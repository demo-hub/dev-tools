#!/usr/bin/env node
/**
 * DevAgent – Multi-Repo Autonomous Sprint Developer
 *
 * Reads your VS Code workspace file to discover repos.
 * Auto-detects test commands per repo.
 * Creates branches and PRs only in repos that were actually modified.
 *
 * Usage:
 *   node agent.mjs                                      — interactive picker
 *   node agent.mjs --id 1234                           — specific ADO item
 *   node agent.mjs --dry-run                           — skip push + PR
 *   node agent.mjs --workspace path/to/foo.code-workspace
 */

import https from "https";
import readline from "readline";
import { execSync, execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname, basename } from "path";

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const R = "\x1b[0m", B = "\x1b[1m", D = "\x1b[2m";
const CYAN = "\x1b[36m", YEL = "\x1b[33m", GRN = "\x1b[32m";
const RED = "\x1b[31m", BLU = "\x1b[34m";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

function loadConfig() {
  const sources = [join(process.cwd(), ".devagent"), join(homedir(), ".devagent")];
  let file = {};
  for (const src of sources) {
    if (existsSync(src)) {
      readFileSync(src, "utf8")
        .split("\n")
        .filter(l => l.includes("=") && !l.startsWith("#"))
        .forEach(l => { const [k, ...v] = l.split("="); file[k.trim()] = v.join("=").split("#")[0].trim(); });
      break;
    }
  }
  return {
    org:        process.env.ADO_ORG        || file.ADO_ORG,
    project:    process.env.ADO_PROJECT    || file.ADO_PROJECT,
    team:       process.env.ADO_TEAM       || file.ADO_TEAM,
    pat:        process.env.ADO_PAT        || file.ADO_PAT,
    stack:      process.env.ADO_STACK      || file.ADO_STACK      || "",
    maxRetry:   parseInt(file.ADO_MAX_RETRY || "2", 10),
    baseBranch: file.ADO_BASE_BRANCH       || "main",
  };
}

// ─── WORKSPACE DISCOVERY ─────────────────────────────────────────────────────

function findWorkspaceFile() {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--workspace");
  if (flag !== -1 && args[flag + 1]) {
    const p = resolve(args[flag + 1]);
    if (!existsSync(p)) throw new Error(`Workspace file not found: ${p}`);
    return p;
  }
  // Search cwd and up to 3 parent directories
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const files = readdirSync(dir).filter(f => f.endsWith(".code-workspace"));
    if (files.length) return join(dir, files[0]);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseWorkspace(workspacePath) {
  // VS Code workspace JSON allows comments — strip them before parsing
  const raw = readFileSync(workspacePath, "utf8")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  let ws;
  try { ws = JSON.parse(raw); }
  catch (e) { throw new Error(`Failed to parse workspace: ${e.message}`); }
  const wsDir = dirname(workspacePath);
  return (ws.folders || [])
    .map(f => resolve(wsDir, f.path))
    .filter(p => existsSync(p));
}

// ─── TEST COMMAND DETECTION ───────────────────────────────────────────────────

function detectTestCommand(repoPath) {
  const has = (...f) => f.some(name => existsSync(join(repoPath, name)));
  const read = f => { try { return readFileSync(join(repoPath, f), "utf8"); } catch { return ""; } };
  const anyExt = ext => { try { return readdirSync(repoPath).some(f => f.endsWith(ext)); } catch { return false; } };

  // .NET — solution or project files
  if (anyExt(".sln")) return "dotnet test";
  if (anyExt(".csproj")) return "dotnet test";

  // Node / JS / TS
  if (has("package.json")) {
    const pkg = JSON.parse(read("package.json") || "{}");
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };

    if (scripts.test && !scripts.test.includes("no test")) return "npm test";
    if (deps["vitest"])  return "npx vitest run";
    if (deps["jest"] || deps["@jest/core"]) return "npx jest";
    if (deps["mocha"])   return "npx mocha";
    // React Native
    if (has("android", "ios")) return "npx jest";
  }

  // Python
  if (has("pytest.ini") || read("pyproject.toml").includes("[tool.pytest")) return "pytest";
  if (has("setup.py") || has("setup.cfg")) return "python -m pytest";

  // Go
  if (has("go.mod")) return "go test ./...";

  // Ruby
  if (has("Gemfile")) return has("spec") ? "bundle exec rspec" : "bundle exec rake test";

  // Makefile with a test target
  if (has("Makefile") && /^test:/m.test(read("Makefile"))) return "make test";

  return null; // couldn't detect
}

function discoverRepos(workspacePath) {
  return parseWorkspace(workspacePath).map(repoPath => ({
    name:      basename(repoPath),
    path:      repoPath,
    testCmd:   detectTestCommand(repoPath),
    isGitRepo: existsSync(join(repoPath, ".git")),
  }));
}

// ─── GIT HELPERS ─────────────────────────────────────────────────────────────

function git(cwd, ...args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe","pipe","pipe"] }).trim();
  } catch (e) { throw new Error(`git ${args[0]} (${basename(cwd)}): ${e.stderr || e.message}`); }
}

function gitSafe(cwd, ...args) { try { return git(cwd, ...args); } catch { return null; } }

function hasChangesVsBase(repoPath, baseBranch) {
  const diff = gitSafe(repoPath, "diff", `${baseBranch}...HEAD`, "--name-only");
  if (diff !== null && diff.trim() !== "") return true;
  // Also check uncommitted
  try { return git(repoPath, "status", "--porcelain").trim() !== ""; } catch { return false; }
}

function branchExists(repoPath, name) {
  return gitSafe(repoPath, "rev-parse", "--verify", name) !== null;
}

function suggestBranchName(wi) {
  const f = wi.fields;
  const prefix = f["System.WorkItemType"] === "Bug" ? "fix"
    : f["System.WorkItemType"] === "User Story" ? "feat" : "task";
  const slug = f["System.Title"]
    .toLowerCase().replace(/[^a-z0-9\s]/g, "").trim()
    .split(/\s+/).slice(0, 6).join("-");
  return `${prefix}/ADO-${f["System.Id"]}-${slug}`;
}

function runTests(repoPath, cmd) {
  try {
    const out = execSync(cmd, {
      cwd: repoPath, encoding: "utf8",
      stdio: ["pipe","pipe","pipe"], timeout: 180_000,
    });
    return { passed: true, output: out };
  } catch (e) {
    return { passed: false, output: (e.stdout || "") + "\n" + (e.stderr || "") };
  }
}

// ─── ADO API ─────────────────────────────────────────────────────────────────

function adoRequest(path, pat, body = null, method = null) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`:${pat}`).toString("base64");
    const data = body ? JSON.stringify(body) : null;
    const verb = method || (data ? "POST" : "GET");
    if (process.env.DEVAGENT_DEBUG) console.log(`${D}[ADO] ${verb} https://dev.azure.com${path}${R}`);
    const req = https.request({
      hostname: "dev.azure.com", path, method: verb,
      headers: {
        Authorization: `Basic ${auth}`, Accept: "application/json",
        ...(data && {
          "Content-Type": verb === "PATCH" ? "application/json-patch+json" : "application/json",
          "Content-Length": Buffer.byteLength(data),
        }),
      },
    }, res => {
      let raw = "";
      res.on("data", d => (raw += d));
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`ADO ${res.statusCode}: ${raw.slice(0,300)}`));
        else { try { resolve(JSON.parse(raw)); } catch { reject(new Error(`Bad JSON: ${raw.slice(0,200)}`)); } }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const enc = s => encodeURIComponent(s);

async function getCurrentUser(cfg) {
  try {
    const d = await adoRequest(`/_apis/connectionData?api-version=7.0`, cfg.pat);
    return d.authenticatedUser?.providerDisplayName || null;
  } catch { return null; }
}


async function getCurrentIteration(cfg) {
  const d = await adoRequest(`/${enc(cfg.org)}/${enc(cfg.project)}/${enc(cfg.team)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.0`, cfg.pat);
  if (!d.value?.length) throw new Error("No active sprint found.");
  return d.value[0];
}

async function getSprintItems(cfg, iterationId) {
  const rel = await adoRequest(`/${enc(cfg.org)}/${enc(cfg.project)}/${enc(cfg.team)}/_apis/work/teamsettings/iterations/${iterationId}/workitems?api-version=7.0`, cfg.pat);
  const ids = (rel.workItemRelations || []).map(r => r.target?.id).filter(Boolean);
  if (!ids.length) return [];

  // ADO batch endpoint limit is 200 — chunk and merge
  const chunks = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));

  const fields = ["System.Id","System.Title","System.WorkItemType","System.State","System.Description","System.Tags","Microsoft.VSTS.Common.Priority","Microsoft.VSTS.Common.AcceptanceCriteria","System.AssignedTo"];
  const results = await Promise.all(chunks.map(chunk =>
    adoRequest(`/${enc(cfg.org)}/_apis/wit/workitemsbatch?api-version=7.0`, cfg.pat, { ids: chunk, fields })
  ));

  return results.flatMap(d => d.value || [])
    .filter(wi => ["User Story", "Bug", "Product Backlog Item", "Incident"].includes(wi.fields["System.WorkItemType"]));
}

async function getWorkItemById(cfg, id) {
  return adoRequest(`/${enc(cfg.org)}/_apis/wit/workitems/${id}?api-version=7.0&$expand=relations`, cfg.pat);
}

// Fetch comments (newest first, max 20)
async function getWorkItemComments(cfg, id) {
  try {
    const d = await adoRequest(
      `/${enc(cfg.org)}/${enc(cfg.project)}/_apis/wit/workItems/${id}/comments?$top=20&order=desc&api-version=7.1-preview.3`,
      cfg.pat
    );
    return (d.comments || []).map(c => ({
      author: c.createdBy?.displayName || "Unknown",
      date:   c.createdDate?.slice(0, 10) || "",
      text:   (c.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    })).filter(c => c.text);
  } catch { return []; }
}

// Fetch linked work items (parent, child, related, duplicate)
async function getLinkedWorkItems(cfg, wi) {
  const relations = wi.relations || [];
  const linked = [];

  for (const rel of relations) {
    // Only follow work item links, not PRs/commits/attachments (those handled separately)
    if (!rel.url?.includes("/_apis/wit/workItems/")) continue;

    const relType = rel.rel || "";
    const kind =
      relType.includes("Parent")      ? "Parent"  :
      relType.includes("Child")       ? "Child"   :
      relType.includes("Duplicate")   ? "Duplicate" :
      relType.includes("Related")     ? "Related" : "Linked";

    const linkedId = rel.url.split("/").pop();
    try {
      const item = await adoRequest(
        `/${enc(cfg.org)}/_apis/wit/workitems/${linkedId}?api-version=7.0`,
        cfg.pat
      );
      const f = item.fields;
      linked.push({
        kind,
        id:    f["System.Id"],
        type:  f["System.WorkItemType"],
        title: f["System.Title"],
        state: f["System.State"],
        desc:  (f["System.Description"] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500),
      });
    } catch { /* non-critical — skip if fetch fails */ }
  }
  return linked;
}

// Fetch PRs already linked to this work item
async function getLinkedPRs(cfg, wi) {
  const relations = wi.relations || [];
  const prs = [];

  for (const rel of relations) {
    if (rel.rel !== "ArtifactLink") continue;
    const url = rel.url || "";
    // ADO artifact links for PRs look like: vstfs:///Git/PullRequestId/...
    if (!url.includes("PullRequestId")) continue;

    const attrs = rel.attributes || {};
    prs.push({
      title:  attrs.name || "Pull Request",
      url:    attrs.resourceUrl || url,
      status: attrs.resourceType || "",
    });
  }
  return prs;
}

// Fetch attachments metadata (not the files themselves)
async function getAttachments(cfg, wi) {
  const relations = wi.relations || [];
  return relations
    .filter(r => r.rel === "AttachedFile")
    .map(r => ({
      name: r.attributes?.name || "attachment",
      url:  r.url,
      comment: r.attributes?.comment || "",
    }));
}

/**
 * Fetches all context for a work item in parallel.
 * Returns { comments, linkedItems, linkedPRs, attachments }
 */
async function fetchFullContext(cfg, wi) {
  const [comments, linkedItems, linkedPRs, attachments] = await Promise.all([
    getWorkItemComments(cfg, wi.id || wi.fields["System.Id"]),
    getLinkedWorkItems(cfg, wi),
    getLinkedPRs(cfg, wi),
    getAttachments(cfg, wi),
  ]);
  return { comments, linkedItems, linkedPRs, attachments };
}

async function updateWorkItemState(cfg, id, state) {
  return adoRequest(`/${enc(cfg.org)}/${enc(cfg.project)}/_apis/wit/workitems/${id}?api-version=7.0`, cfg.pat,
    [{ op: "replace", path: "/fields/System.State", value: state }], "PATCH");
}

async function createPullRequest(cfg, repoName, { sourceBranch, title, description, workItemId }) {
  const repos = await adoRequest(`/${enc(cfg.org)}/${enc(cfg.project)}/_apis/git/repositories?api-version=7.0`, cfg.pat);
  const repo = repos.value?.find(r => r.name.toLowerCase() === repoName.toLowerCase());
  if (!repo) throw new Error(`Repo '${repoName}' not found in ADO project '${cfg.project}'.`);
  return adoRequest(`/${enc(cfg.org)}/${enc(cfg.project)}/_apis/git/repositories/${repo.id}/pullrequests?api-version=7.0`, cfg.pat, {
    title, description,
    sourceRefName: `refs/heads/${sourceBranch}`,
    targetRefName: `refs/heads/${cfg.baseBranch}`,
    workItemRefs: workItemId ? [{ id: String(workItemId) }] : [],
    isDraft: false,
  });
}

// ─── PROMPT BUILDERS ─────────────────────────────────────────────────────────

function buildImplementationPrompt(wi, cfg, repos, context = {}) {
  const f = wi.fields;
  const clean = s => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const tags = (f["System.Tags"] || "").split(";").map(t => t.trim()).filter(Boolean);
  const { comments = [], linkedItems = [], linkedPRs = [], attachments = [] } = context;

  // ── Linked work items section ──────────────────────────────────────────────
  const linkedSection = linkedItems.length ? [
    `## Linked Work Items`,
    ...linkedItems.map(li => [
      `### [${li.kind}] ${li.type} #${li.id} — ${li.title} (${li.state})`,
      li.desc ? li.desc : null,
    ].filter(Boolean).join("\n")),
    ``,
  ].join("\n") : null;

  // ── Comments section (newest first, most recent 10) ────────────────────────
  // Reverse so oldest is first — easier to follow the conversation thread
  const commentsSection = comments.length ? [
    `## Discussion & Comments`,
    `(${comments.length} comment${comments.length > 1 ? "s" : ""}, oldest first)`,
    ``,
    ...[...comments].reverse().map(c =>
      `**${c.author}** (${c.date}):\n${c.text}`
    ),
    ``,
  ].join("\n") : null;

  // ── Linked PRs section ─────────────────────────────────────────────────────
  const prsSection = linkedPRs.length ? [
    `## Already Linked Pull Requests`,
    `(Be aware of these — avoid duplicating work)`,
    ...linkedPRs.map(pr => `- ${pr.title} ${pr.status ? `[${pr.status}]` : ""}`),
    ``,
  ].join("\n") : null;

  // ── Attachments notice ─────────────────────────────────────────────────────
  const attachmentsSection = attachments.length ? [
    `## Attachments`,
    `(${attachments.length} file(s) attached to this item — may include mockups or specs)`,
    ...attachments.map(a => `- ${a.name}${a.comment ? `: ${a.comment}` : ""}`),
    ``,
  ].join("\n") : null;

  // ── Repo section ───────────────────────────────────────────────────────────
  const repoSection = repos.map(r => [
    `### ${r.name}`,
    `Path: ${r.path}`,
    r.testCmd
      ? `Tests: \`${r.testCmd}\``
      : `Tests: ⚠ Could not auto-detect — explore and find the right test command.`,
  ].join("\n")).join("\n\n");

  return [
    `You are implementing ADO-${f["System.Id"]} across a multi-repo VS Code workspace.`,
    `Read ALL context below carefully before writing any code.`,
    ``,
    `## Work Item`,
    `- Type: ${f["System.WorkItemType"]}`,
    `- Title: ${f["System.Title"]}`,
    `- State: ${f["System.State"]}`,
    tags.length ? `- Tags: ${tags.join(", ")}` : null,
    f["Microsoft.VSTS.Common.Priority"] != null ? `- Priority: P${f["Microsoft.VSTS.Common.Priority"]}` : null,
    cfg.stack ? `- Stack: ${cfg.stack}` : null,
    ``,
    clean(f["System.Description"])       ? `## Description\n${clean(f["System.Description"])}\n`             : null,
    clean(f["Microsoft.VSTS.Common.AcceptanceCriteria"])? `## Acceptance Criteria\n${clean(f["Microsoft.VSTS.Common.AcceptanceCriteria"])}\n` : null,
    linkedSection,
    commentsSection,
    prsSection,
    attachmentsSection,
    `## Repositories in this workspace`,
    repoSection,
    ``,
    `## Instructions`,
    `1. Read ALL context above — especially comments and linked items — before deciding what to implement.`,
    `   Comments often contain clarifications or decisions that override the original description.`,
    `2. Identify which repos need changes. You don't need to touch all of them.`,
    `3. Explore each relevant repo before writing any code — understand its structure, patterns, naming conventions.`,
    `4. Write tests first (TDD) using the test framework already in the repo.`,
    `5. Implement the solution that makes those tests pass.`,
    `6. Run the tests in each repo you modified to verify they pass.`,
    `7. Use typed models/classes — never plain dicts or anonymous objects.`,
    `8. Follow existing patterns — don't invent new conventions.`,
    `9. Do NOT touch: secrets, production config, CI/CD pipelines, or DB migrations unless explicitly required.`,
    `10. When done, end with this exact block:`,
    ``,
    `AGENT_OUTPUT_START`,
    `MODIFIED_REPOS: <comma-separated repo names you actually modified>`,
    `PR_TITLE: <one concise title>`,
    `PR_BODY:`,
    `<full PR description in markdown>`,
    `AGENT_OUTPUT_END`,
  ].filter(l => l !== null).join("\n");
}

function buildAnalysisPrompt(wi, cfg, repos) {
  const f = wi.fields;
  const clean = s => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const tags = (f["System.Tags"] || "").split(";").map(t => t.trim()).filter(Boolean);

  const repoList = repos.map(r => `- ${r.name}: ${r.path}`).join("\n");

  return [
    `You are a senior developer analysing a work item before implementation.`,
    `DO NOT write any code yet. Only analyse and respond with a JSON block.`,
    ``,
    `## Work Item`,
    `- Type: ${f["System.WorkItemType"]}`,
    `- Title: ${f["System.Title"]}`,
    tags.length ? `- Tags: ${tags.join(", ")}` : null,
    cfg.stack ? `- Stack: ${cfg.stack}` : null,
    ``,
    clean(f["System.Description"]) ? `## Description\n${clean(f["System.Description"])}\n` : null,
    clean(f["Microsoft.VSTS.Common.AcceptanceCriteria"]) ? `## Acceptance Criteria\n${clean(f["Microsoft.VSTS.Common.AcceptanceCriteria"])}\n` : null,
    `## Available Repositories`,
    repoList,
    ``,
    `## Task`,
    `1. Briefly explore each repo's root and README to understand what it does.`,
    `2. Determine which repos actually need changes for this work item.`,
    `3. Respond with ONLY this JSON block and nothing else:`,
    ``,
    `ANALYSIS_START`,
    `{`,
    `  "relevant_repos": ["repo-name-1", "repo-name-2"],`,
    `  "reasoning": "one sentence explaining why these repos need changes",`,
    `  "complexity": "low|medium|high"`,
    `}`,
    `ANALYSIS_END`,
  ].filter(l => l !== null).join("\n");
}

function parseAnalysis(text) {
  const s = text.indexOf("ANALYSIS_START");
  const e = text.indexOf("ANALYSIS_END");
  if (s === -1 || e === -1) return null;
  try {
    return JSON.parse(text.slice(s + "ANALYSIS_START".length, e).trim());
  } catch { return null; }
}

function buildFixPrompt(failedRepos, attempt, maxRetry) {
  return [
    `Tests are still failing. Fix attempt ${attempt}/${maxRetry}.`,
    ``,
    ...failedRepos.map(r => [`### ${r.name}\n\`\`\`\n${r.output.slice(-2000)}\n\`\`\``]),
    ``,
    `Fix only what is broken. Re-run tests in each failing repo. Re-output AGENT_OUTPUT_START when all pass.`,
  ].flat().join("\n");
}

// ─── CLAUDE CODE ─────────────────────────────────────────────────────────────

function parseAgentOutput(text) {
  const s = text.indexOf("AGENT_OUTPUT_START");
  const e = text.indexOf("AGENT_OUTPUT_END");
  if (s === -1 || e === -1) return null;
  const lines = text.slice(s + "AGENT_OUTPUT_START".length, e).trim().split("\n");
  const get = key => { const l = lines.find(l => l.startsWith(`${key}:`)); return l ? l.slice(key.length + 1).trim() : null; };
  const prIdx = lines.findIndex(l => l.startsWith("PR_BODY:"));
  return {
    modifiedRepos: (get("MODIFIED_REPOS") || "").split(",").map(s => s.trim()).filter(Boolean),
    prTitle:       get("PR_TITLE"),
    prBody:        prIdx !== -1 ? lines.slice(prIdx + 1).join("\n").trim() : null,
  };
}

function runClaudeInteractive(prompt) {
  const tmp = join(homedir(), ".devagent-prompt.md");
  writeFileSync(tmp, prompt, "utf8");
  return spawnSync(`cat "${tmp}" | claude --dangerously-skip-permissions`, [], {
    stdio: "inherit", shell: true, env: { ...process.env }
  });
}

function runClaudeSilent(prompt) {
  const tmp = join(homedir(), ".devagent-prompt.md");
  writeFileSync(tmp, prompt, "utf8");
  const r = spawnSync(`cat "${tmp}" | claude --dangerously-skip-permissions --print --allowedTools "Bash,Edit,Write"`, [], {
    stdio: ["inherit","pipe","pipe"], shell: true, env: { ...process.env },
  });
  return { ok: r.status === 0, stdout: (r.stdout || "").toString() };
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, a => { rl.close(); resolve(a.trim()); }));
}

function log(icon, stage, msg) {
  const label = `${D}[${stage}]${R}`;
  console.log(`  ${icon}  ${label.padEnd(22)} ${msg}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const cfg = loadConfig();
  if (!cfg.org || !cfg.pat) {
    console.error(`${RED}No .devagent config. Run task.mjs first.${R}`); process.exit(1);
  }

  try { execSync("claude --version", { stdio: "ignore" }); }
  catch { console.error(`${RED}Claude Code not found. npm i -g @anthropic-ai/claude-code${R}`); process.exit(1); }

  console.log(`\n${B}${BLU}⚡ DevAgent${R}  ${D}Multi-Repo · Autonomous${R}`);
  console.log(`${D}${"─".repeat(54)}${R}`);
  if (dryRun) console.log(`${YEL}${B}DRY RUN${R}${YEL} — push and PR creation skipped\n${R}`);

  // ── Discover repos ─────────────────────────────────────────────────────────
  log("🔍", "DISCOVER", "Looking for VS Code workspace file…");
  const workspacePath = findWorkspaceFile();
  let repos = [];

  if (workspacePath) {
    log("✓", "DISCOVER", `${GRN}${basename(workspacePath)}${R}`);
    repos = discoverRepos(workspacePath);

    console.log(`\n  ${"Repo".padEnd(26)} Test command`);
    console.log(`  ${"─".repeat(60)}`);
    for (const r of repos) {
      const cmd = r.testCmd ? `${GRN}${r.testCmd}${R}` : `${YEL}not detected${R}`;
      console.log(`  ${CYAN}${r.name.padEnd(26)}${R} ${cmd}`);
    }
    console.log();

    // Let user fill in any gaps
    for (const repo of repos) {
      if (!repo.testCmd && repo.isGitRepo) {
        const input = await ask(`  Test command for ${B}${repo.name}${R} (Enter to skip): `);
        if (input) repo.testCmd = input;
      }
    }
  } else {
    console.log(`  ${YEL}No .code-workspace found — single repo mode.${R}`);
    const cwd = process.cwd();
    const testCmd = detectTestCommand(cwd);
    if (!testCmd) {
      const input = await ask(`  Test command (e.g. dotnet test): `);
      repos = [{ name: basename(cwd), path: cwd, testCmd: input || null, isGitRepo: true }];
    } else {
      repos = [{ name: basename(cwd), path: cwd, testCmd, isGitRepo: true }];
      log("✓", "DISCOVER", `Test command: ${GRN}${testCmd}${R}`);
    }
  }

  const gitRepos = repos.filter(r => r.isGitRepo);
  if (!gitRepos.length) { console.error(`${RED}No git repos found.${R}`); process.exit(1); }

  // ── Pick task ──────────────────────────────────────────────────────────────
  log("📋", "PICK", "Loading sprint…");
  let wi;
  const idFlag = args.indexOf("--id");

  if (idFlag !== -1 && args[idFlag + 1]) {
    wi = await getWorkItemById(cfg, parseInt(args[idFlag + 1], 10));
    log("✓", "PICK", `${B}${wi.fields["System.Title"]}${R}`);
  } else {
    const [iter, currentUser] = await Promise.all([
      getCurrentIteration(cfg),
      getCurrentUser(cfg),
    ]);

    if (currentUser) log("👤", "PICK", `Filtering by ${CYAN}${currentUser}${R}`);

    let items = await getSprintItems(cfg, iter.id);

    // Filter to current user — AssignedTo is an object { displayName, uniqueName }
    if (currentUser) {
      const assigned = items.filter(wi => {
        const a = wi.fields["System.AssignedTo"];
        if (!a) return false;
        const name = typeof a === "object" ? a.displayName : a;
        return name?.toLowerCase() === currentUser.toLowerCase();
      });
      // If filtering yields nothing (e.g. name mismatch), fall back to all items
      if (assigned.length) {
        items = assigned;
      } else {
        log("⚠", "PICK", `${YEL}No items assigned to you — showing all${R}`);
      }
    }

    // Exclude terminal states
    const EXCLUDED_STATES = ["done", "ready", "closed", "removed", "resolved"];
    items = items.filter(wi => !EXCLUDED_STATES.includes(wi.fields["System.State"]?.toLowerCase()));

    if (!items.length) { console.log(`\n${YEL}No items assigned to you in this sprint.${R}\n`); process.exit(0); }

    console.log(`\n  ${B}${CYAN}${iter.name}${R}\n`);
    const TC = { "User Story": CYAN, "Bug": RED, "Task": GRN, "Product Backlog Item": CYAN, "Incident": YEL };
    const TI = { "User Story": "◈", "Bug": "⬡", "Task": "◻", "Product Backlog Item": "◈", "Incident": "⚠" };
    items.forEach((item, i) => {
      const f = item.fields;
      console.log(
        `  ${B}${String(i + 1).padStart(2)}.${R} ` +
        `${TC[f["System.WorkItemType"]] || D}${TI[f["System.WorkItemType"]] || "◻"} ${f["System.WorkItemType"].padEnd(11)}${R} ` +
        `${D}#${String(f["System.Id"]).padEnd(6)}[${f["System.State"]}]${R} ` +
        `${B}${f["System.Title"]}${R}`
      );
    });
    console.log();
    const pick = await ask(`  Pick (1–${items.length}): `);
    const idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= items.length) { console.error(`${RED}Invalid.${R}`); process.exit(1); }
    wi = items[idx];
    log("✓", "PICK", `${B}${wi.fields["System.Title"]}${R} ${D}(ADO-${wi.fields["System.Id"]})${R}`);
  }

  // ── Fetch full context ─────────────────────────────────────────────────────
  log("📎", "CONTEXT", "Fetching comments, linked items, PRs…");

  // getWorkItemById with $expand=relations gives us the relations array
  // Re-fetch so we always have relations even if wi came from the batch endpoint
  const wiWithRelations = await getWorkItemById(cfg, wi.fields["System.Id"]);
  const context = await fetchFullContext(cfg, wiWithRelations);

  // Merge relations back onto wi for prompt building
  wi.relations = wiWithRelations.relations || [];

  const ctxSummary = [
    context.comments.length     ? `${context.comments.length} comment(s)` : null,
    context.linkedItems.length  ? `${context.linkedItems.length} linked item(s)` : null,
    context.linkedPRs.length    ? `${context.linkedPRs.length} linked PR(s)` : null,
    context.attachments.length  ? `${context.attachments.length} attachment(s)` : null,
  ].filter(Boolean);

  log("✓", "CONTEXT", ctxSummary.length ? ctxSummary.join(" · ") : "No extra context found");

  // ── Phase 1: Analyse — which repos need changes? ──────────────────────────
  console.log();
  log("🔎", "ANALYSE", "Asking Claude Code which repos are relevant…\n");
  const analysisResult = runClaudeSilent(buildAnalysisPrompt(wi, cfg, repos));
  const analysis = parseAnalysis(analysisResult.stdout);

  let workingRepos = gitRepos;

  if (analysis?.relevant_repos?.length) {
    const relevant = gitRepos.filter(r => analysis.relevant_repos.includes(r.name));
    if (relevant.length) {
      workingRepos = relevant;
      log("✓", "ANALYSE", `${GRN}${analysis.relevant_repos.join(", ")}${R}`);
      if (analysis.reasoning) console.log(`     ${D}${analysis.reasoning}${R}`);
      if (analysis.complexity) console.log(`     ${D}Complexity: ${analysis.complexity}${R}`);
    } else {
      log("⚠", "ANALYSE", `${YEL}Could not match repo names — using all repos${R}`);
    }
  } else {
    log("⚠", "ANALYSE", `${YEL}Analysis inconclusive — using all repos${R}`);
  }

  // ── Create branches only in relevant repos ─────────────────────────────────
  console.log();
  const suggested = suggestBranchName(wi);
  const branchInput = await ask(`  ${D}Branch name [${suggested}]:${R} `);
  const branch = branchInput || suggested;

  log("🌿", "BRANCH", `${CYAN}${branch}${R}`);
  for (const repo of workingRepos) {
    if (branchExists(repo.path, branch)) {
      git(repo.path, "checkout", branch);
      console.log(`     ${D}${repo.name}: existing branch checked out${R}`);
    } else {
      git(repo.path, "checkout", "-b", branch);
      console.log(`     ${D}${repo.name}: branch created${R}`);
    }
  }

  // ── Phase 2: Implement in relevant repos only ──────────────────────────────
  console.log();
  log("🤖", "IMPLEMENT", `Handing off to Claude Code (${workingRepos.map(r => r.name).join(", ")})…\n`);
  runClaudeInteractive(buildImplementationPrompt(wi, cfg, workingRepos, context));

  // ── Detect touched repos ───────────────────────────────────────────────────
  console.log();
  log("🔍", "DETECT", "Checking which repos were modified…");
  const touchedRepos = workingRepos.filter(r => hasChangesVsBase(r.path, cfg.baseBranch));

  if (!touchedRepos.length) {
    console.log(`\n${YEL}No changes detected in any repo.${R}\n`); process.exit(0);
  }

  touchedRepos.forEach(r => console.log(`     ${GRN}✓${R} ${r.name}`));
  workingRepos.filter(r => !touchedRepos.includes(r)).forEach(r => console.log(`     ${D}– ${r.name} (unchanged)${R}`));

  // ── Test loop with auto-retry ──────────────────────────────────────────────
  let agentOutput = null;
  let retryCount = 0;

  while (true) {
    console.log();
    log("🧪", "TEST", "Running tests in modified repos…");

    const results = touchedRepos.map(repo => {
      if (!repo.testCmd) {
        console.log(`     ${YEL}⚠ ${repo.name}: no test command — skipped${R}`);
        return { ...repo, passed: true, output: "" };
      }
      process.stdout.write(`     ${repo.name}: ${D}${repo.testCmd}${R} … `);
      const res = runTests(repo.path, repo.testCmd);
      console.log(res.passed ? `${GRN}✓ pass${R}` : `${RED}✗ fail${R}`);
      return { ...repo, ...res };
    });

    const failed = results.filter(r => !r.passed);

    if (!failed.length) {
      log("✓", "TEST", `${GRN}All tests passing.${R}`);
      break;
    }

    retryCount++;
    if (retryCount > cfg.maxRetry) {
      console.log(`\n${RED}Max retries reached. Fix manually, then re-run with --id ${wi.fields["System.Id"]}.${R}\n`);
      failed.forEach(r => { console.log(`${YEL}── ${r.name}${R}\n${r.output.slice(-1500)}`); });
      process.exit(1);
    }

    log("↺", "RETRY", `${YEL}Attempt ${retryCount}/${cfg.maxRetry} — sending failures to Claude Code…${R}\n`);
    const fix = runClaudeSilent(buildFixPrompt(failed, retryCount, cfg.maxRetry));
    if (fix.stdout) {
      const parsed = parseAgentOutput(fix.stdout);
      if (parsed) agentOutput = parsed;
    }
  }

  // ── Human review gate ──────────────────────────────────────────────────────
  console.log(`\n${B}${YEL}── Review Gate ───────────────────────────────────────────${R}`);
  console.log(`${D}Tests pass. Review the diff before PRs are created.\n${R}`);

  for (const repo of touchedRepos) {
    console.log(`  ${CYAN}${repo.name}${R}`);
    try { git(repo.path, "diff", `${cfg.baseBranch}...HEAD`, "--stat").split("\n").forEach(l => console.log(`    ${D}${l}${R}`)); }
    catch {}
    console.log();
  }

  const action = await ask(`  ${B}Proceed? y = create PRs  n = abort  s = skip PRs:${R} `);
  if (action === "n") { console.log(`\n${YEL}Aborted. Branches kept locally.${R}\n`); process.exit(0); }
  if (action === "s") { console.log(`\n${GRN}Done. Create PRs manually when ready.${R}\n`); process.exit(0); }

  // ── Create PRs ─────────────────────────────────────────────────────────────
  const f = wi.fields;
  const prTitle = agentOutput?.prTitle || `ADO-${f["System.Id"]}: ${f["System.Title"]}`;
  const prBody  = agentOutput?.prBody  || `Implements ADO-${f["System.Id"]}\n\nAll tests passing.`;

  console.log();
  for (const repo of touchedRepos) {
    log("🔀", "PR", `${repo.name}…`);
    if (!dryRun) {
      git(repo.path, "push", "-u", "origin", branch);
      try {
        const pr = await createPullRequest(cfg, repo.name, {
          sourceBranch: branch,
          title: `[${repo.name}] ${prTitle}`,
          description: prBody,
          workItemId: f["System.Id"],
        });
        const url = `https://dev.azure.com/${cfg.org}/${enc(cfg.project)}/_git/${repo.name}/pullrequest/${pr.pullRequestId}`;
        log("✓", "PR", `${GRN}#${pr.pullRequestId} created${R}`);
        console.log(`     ${BLU}${url}${R}`);
      } catch (e) {
        log("⚠", "PR", `${YEL}${e.message}${R}`);
      }
    } else {
      log("~", "PR", `${YEL}DRY RUN — would push and open PR for ${repo.name}${R}`);
    }
  }

  // ── Update ADO ─────────────────────────────────────────────────────────────
  console.log();
  if (!dryRun) {
    await updateWorkItemState(cfg, f["System.Id"], "In Review");
    log("✓", "ADO", `ADO-${f["System.Id"]} → ${GRN}In Review${R}`);
  } else {
    log("~", "ADO", `${YEL}DRY RUN — would move ADO-${f["System.Id"]} to In Review${R}`);
  }

  console.log(`\n${GRN}${B}✓ Done.${R} Review the PRs and merge when ready.\n`);
}

main().catch(err => { console.error(`\n${RED}✗ ${err.message}${R}\n`); process.exit(1); });
