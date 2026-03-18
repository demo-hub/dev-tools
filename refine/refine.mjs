#!/usr/bin/env node
/**
 * refine.mjs
 * Pre-refinement assistant for ADO PBIs. For each work item tagged with
 * "refine-ready-<product>", it produces per-PBI:
 *   - Definition of Ready compliance report
 *   - Gaps to address before refinement
 *   - Suggested Acceptance Criteria (if missing or thin)
 *   - Development plan
 *   - Suggested tasks / subtasks
 *
 * Usage:
 *   node refine.mjs <product>                    — analyse all tagged PBIs
 *   node refine.mjs <product> <id>               — analyse a single PBI by ID
 *   node refine.mjs --list                        — list configured products
 *
 * Prerequisites:
 *   - ADO_PAT in .devagent (or env var). Scopes: Work Items Read
 *   - Either: `claude` CLI installed (Claude Code subscription)
 *   - Or:     ANTHROPIC_API_KEY in .devagent — set GENERATION_MODE = "api"
 */

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// .devagent config reader
// ---------------------------------------------------------------------------
function readDevAgent() {
  for (const loc of [".devagent", "../.devagent", "../../.devagent"]) {
    try {
      const config = {};
      for (const line of fs.readFileSync(loc, "utf8").split("\n")) {
        const trimmed = line.split("#")[0].trim();
        const match = trimmed.match(/^([^=]+)=(.*)$/);
        if (match) config[match[1].trim()] = match[2].trim();
      }
      return config;
    } catch { /* not found, try next */ }
  }
  return {};
}

const DEVAGENT = readDevAgent();
function getSecret(key) { return DEVAGENT[key] || process.env[key] || null; }

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const ADO = {
  org: "SFS-IT",
  project: "SFSCore",
};

const PRODUCTS = {
  app:          { tag: "refine-ready-app",           name: "App Universo"   },
  usp:          { tag: "refine-ready-usp",           name: "USP"            },
  personalLoan: { tag: "refine-ready-personal-loan", name: "Personal Loans" },
  uniportal:    { tag: "refine-ready-uniportal",     name: "Uniportal"      },
};

// ---------------------------------------------------------------------------
// Generation mode
// ---------------------------------------------------------------------------
const GENERATION_MODE = "claude-code"; // ← change to "api" if you have an API key


// ---------------------------------------------------------------------------
// VS Code workspace reader + file tree builder
// ---------------------------------------------------------------------------

const TREE_IGNORE = new Set([
  "node_modules", ".git", "bin", "obj", ".vs", "dist", "build",
  ".next", "coverage", "__pycache__", ".terraform", ".gradle",
  "Packages", "DerivedData",
]);

const TREE_IGNORE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".min.js", ".min.css",
  ".suo", ".user", ".DotSettings",
  ".lock",  // package-lock, yarn.lock, etc
]);

function buildFileTree(dirPath, pathLib, prefix = "", depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return ["  " + prefix + "..."];
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch { return []; }

  entries = entries.filter(e => {
    if (TREE_IGNORE.has(e.name)) return false;
    if (e.name.startsWith(".") && e.isDirectory()) return false;
    if (!e.isDirectory()) {
      const ext = pathLib.extname(e.name).toLowerCase();
      if (TREE_IGNORE_EXT.has(ext)) return false;
      if (e.name.endsWith(".lock")) return false;
    }
    return true;
  });

  const lines = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    if (e.isDirectory()) {
      lines.push(`${prefix}${connector}${e.name}/`);
      const children = buildFileTree(
        pathLib.join(dirPath, e.name), pathLib,
        prefix + childPrefix, depth + 1, maxDepth
      );
      lines.push(...children);
    } else {
      lines.push(`${prefix}${connector}${e.name}`);
    }
  }
  return lines;
}

async function readWorkspaceContext() {

  // Walk up from cwd looking for .code-workspace
  let dir = process.cwd();
  let workspaceFile = null;
  for (let i = 0; i < 5; i++) {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith(".code-workspace"));
    if (entries.length > 0) { workspaceFile = path.join(dir, entries[0]); break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (!workspaceFile) return null;

  const workspace = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
  const workspaceDir = path.dirname(workspaceFile);

  const repos = [];
  for (const folder of (workspace.folders ?? [])) {
    const folderPath = path.resolve(workspaceDir, folder.path);
    const name = folder.name ?? path.basename(folderPath);
    if (!fs.existsSync(folderPath)) continue;

    const rootFiles = fs.readdirSync(folderPath);
    const type = [];
    if (rootFiles.some(f => f.endsWith(".sln") || f.endsWith(".csproj"))) type.push("dotnet");
    if (rootFiles.includes("metro.config.js") || rootFiles.includes("react-native.config.js")) type.push("react-native");
    else if (rootFiles.includes("package.json")) type.push("node");
    if (rootFiles.some(f => f.endsWith(".tf"))) type.push("terraform");
    if (rootFiles.includes("Dockerfile")) type.push("docker");
    if (type.length === 0) type.push("unknown");

    // Build full file tree
    const treeLines = buildFileTree(folderPath, path);

    repos.push({ name, path: folderPath, type, treeLines });
  }

  return { file: workspaceFile, workspaceDir, repos };
}

// Format tree for Pass 1 (file selection) — full tree, paths relative to workspace root
function formatWorkspaceTree(workspace) {
  if (!workspace) return "(no .code-workspace found — development plan based on standard App Universo stack)";

  const lines = [];
  for (const repo of workspace.repos) {
    lines.push(`### ${repo.name}/ [${repo.type.join(", ")}]`);
    lines.push(...repo.treeLines);
    lines.push("");
  }
  return lines.join("\n");
}

// Resolve a relative path from Pass 1 response to an absolute path
function resolveWorkspacePath(workspace, relativePath) {
  for (const repo of workspace.repos) {
    // Strip leading repo name if Claude included it
    const repoName = repo.name + "/";
    const stripped = relativePath.startsWith(repoName)
      ? relativePath.slice(repoName.length)
      : relativePath;
    const candidate = path.join(repo.path, stripped);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Read files requested by Claude, with caps
const MAX_BYTES_PER_FILE = 12 * 1024;   // 12 KB per file
const MAX_BYTES_TOTAL    = 80 * 1024;   // 80 KB total
const MAX_FILES          = 15;

async function readRequestedFiles(workspace, requestedPaths) {
  const results = [];
  let totalBytes = 0;

  for (const rel of requestedPaths.slice(0, MAX_FILES)) {
    if (totalBytes >= MAX_BYTES_TOTAL) break;

    // Try resolving against each repo
    let absPath = null;
    for (const repo of workspace.repos) {
      const stripped = rel.startsWith(repo.name + "/") ? rel.slice(repo.name.length + 1) : rel;
      const candidate = path.join(repo.path, stripped);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        absPath = candidate;
        break;
      }
    }

    if (!absPath) {
      results.push({ path: rel, content: null, error: "File not found" });
      continue;
    }

    try {
      let content = fs.readFileSync(absPath, "utf8");
      if (Buffer.byteLength(content) > MAX_BYTES_PER_FILE) {
        content = content.slice(0, MAX_BYTES_PER_FILE) + "\n// ... (truncated)";
      }
      totalBytes += Buffer.byteLength(content);
      results.push({ path: rel, content });
    } catch (e) {
      results.push({ path: rel, content: null, error: e.message });
    }
  }

  return results;
}

function formatReadFiles(files) {
  return files.map(f => {
    if (f.error) return `### ${f.path}\n(${f.error})`;
    return `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``;
  }).join("\n\n");
}

// ---------------------------------------------------------------------------
// ADO HTTP helpers
// ---------------------------------------------------------------------------
function adoAuthHeader() {
  const pat = getSecret("ADO_PAT");
  if (!pat) throw new Error("ADO_PAT not found — set it in .devagent or as an environment variable");
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

async function adoFetch(path, options = {}) {
  const base = `https://dev.azure.com/${ADO.org}/${ADO.project}/_apis`;
  const qs = new URLSearchParams({ "api-version": options.apiVersion ?? "7.1" });
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) qs.set(k, Array.isArray(v) ? v.join(",") : v);
  }
  const res = await fetch(`${base}${path}?${qs}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: adoAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ADO API ${res.status} on ${path}: ${text}`);
  }
  return res.json();
}

// Post a comment on an ADO work item
async function postAdoComment(workItemId, markdown) {
  const url = `https://dev.azure.com/${ADO.org}/${ADO.project}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.3`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: adoAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: markdown }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ADO comment API ${res.status}: ${text}`);
  }
  return res.json();
}

// Extract the "Gaps to Address" section from Claude's markdown output
function extractGapsSection(claudeAnalysis) {
  const match = claudeAnalysis.match(
    /###\s+Gaps to Address\s*\n([\s\S]*?)(?=\n###|\n##|$)/i
  );
  return match ? match[1].trim() : null;
}

// Build the comment body posted to the work item
function buildDoRComment(checks, gapsText) {
  const failed = checks.filter(c => c.pass === false);
  const failedList = failed.map(c => `- ❌ ${c.criterion}`).join("\n");

  return [
    "## ⚠️ Definition of Ready — Gaps Detected",
    "",
    "This work item was analysed by the Refinement Assistant and does **not yet meet the Definition of Ready**.",
    "Please address the following before the next refinement session.",
    "",
    "### Failed Checks",
    "",
    failedList,
    "",
    "### Gaps to Address",
    "",
    gapsText ?? "_No gap detail available — review the failed checks above._",
    "",
    "---",
    "_Posted automatically by refine.mjs — resolve the gaps and re-run to get a development plan._",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// ADO: fetch work items
// ---------------------------------------------------------------------------
const WI_FIELDS = [
  "System.Id",
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "System.Description",
  "System.Tags",
  "System.AssignedTo",
  "System.AreaPath",
  "System.IterationPath",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.Scheduling.StoryPoints",
  "Microsoft.VSTS.Common.Priority",
  "System.BoardColumn",
];

async function fetchTaggedWorkItems(tag) {
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = '${ADO.project}'
        AND [System.Tags] CONTAINS '${tag}'
        AND [System.WorkItemType] IN ('Product Backlog Item', 'Bug', 'Task', 'Incident')
        AND [System.State] NOT IN ('Closed', 'Done', 'Removed')
      ORDER BY [System.ChangedDate] DESC
    `,
  };

  const wiqlResult = await adoFetch("/wit/wiql", { method: "POST", body: wiql });
  const ids = (wiqlResult.workItems ?? []).map((w) => w.id);
  if (ids.length === 0) return [];

  console.log(`✅ Found ${ids.length} work item(s): ${ids.join(", ")}`);

  const chunks = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));

  const items = [];
  for (const chunk of chunks) {
    const result = await adoFetch("/wit/workitems", { params: { ids: chunk, fields: WI_FIELDS } });
    items.push(...(result.value ?? []));
  }
  return items;
}

async function fetchSingleWorkItem(id) {
  const result = await adoFetch(`/wit/workitems/${id}`, { params: { fields: WI_FIELDS } });
  return result;
}

// ---------------------------------------------------------------------------
// DoR — static compliance check (what we can determine from ADO fields alone)
// ---------------------------------------------------------------------------

// Criteria we can check purely from field values
function checkFieldCompliance(wi) {
  const f = wi.fields;
  const type = f["System.WorkItemType"];
  const isBug = type === "Bug";

  const checks = [];

  if (isBug) {
    // Bug DoR
    checks.push({ criterion: "Evidence provided (case number / screenshots / logs)", field: "System.Description", pass: hasContent(f["System.Description"], 50), note: "Check description includes evidence" });
    checks.push({ criterion: "Step-by-step reproduction included", field: "System.Description", pass: hasContent(f["System.Description"], 80), note: "Check description includes repro steps" });
    checks.push({ criterion: "Current behavior described", field: "System.Description", pass: hasContent(f["System.Description"], 30), note: null });
    checks.push({ criterion: "Expected behavior described", field: "Microsoft.VSTS.Common.AcceptanceCriteria", pass: hasContent(f["Microsoft.VSTS.Common.AcceptanceCriteria"], 20), note: null });
    checks.push({ criterion: "Bug is estimated (story points)", field: "Microsoft.VSTS.Scheduling.StoryPoints", pass: !!f["Microsoft.VSTS.Scheduling.StoryPoints"], note: null });
    // Fields we can't auto-check — mark as unknown
    checks.push({ criterion: "OS specified", pass: null, note: "Cannot auto-detect — verify in description" });
    checks.push({ criterion: "Browser and version specified (if web)", pass: null, note: "Cannot auto-detect — verify in description" });
    checks.push({ criterion: "Related bugs referenced", pass: null, note: "Cannot auto-detect — check linked work items" });
    checks.push({ criterion: "Timestamps provided for log/trace investigation", pass: null, note: "Cannot auto-detect — verify in description" });
    checks.push({ criterion: "Application version included", pass: null, note: "Cannot auto-detect — verify in description" });
  } else {
    // User Story / PBI DoR
    checks.push({ criterion: "Clear goal is documented", field: "System.Description", pass: hasContent(f["System.Description"], 50), note: null });
    checks.push({ criterion: "Business context is documented", field: "System.Description", pass: hasContent(f["System.Description"], 100), note: "Check description includes business context" });
    checks.push({ criterion: "Acceptance criteria exist", field: "Microsoft.VSTS.Common.AcceptanceCriteria", pass: hasContent(f["Microsoft.VSTS.Common.AcceptanceCriteria"], 10), note: null });
    checks.push({ criterion: "Acceptance criteria are clear and understandable", field: "Microsoft.VSTS.Common.AcceptanceCriteria", pass: hasContent(f["Microsoft.VSTS.Common.AcceptanceCriteria"], 80), note: "Assessed by Claude below" });
    // Fields we can flag but not fully auto-assess
    checks.push({ criterion: "Customer/persona identified", pass: null, note: "Cannot auto-detect — verify in description" });
    checks.push({ criterion: "Happy path covered in AC", pass: null, note: "Assessed by Claude below" });
    checks.push({ criterion: "Edge scenarios listed", pass: null, note: "Assessed by Claude below" });
    checks.push({ criterion: "Negative scenarios listed", pass: null, note: "Assessed by Claude below" });
    checks.push({ criterion: "Error-handling behavior defined", pass: null, note: "Assessed by Claude below" });
    checks.push({ criterion: "Dependencies identified", pass: null, note: "Cannot auto-detect — verify with team" });
    checks.push({ criterion: "UI/UX designs finalized", pass: null, note: "Cannot auto-detect — verify with design" });
    checks.push({ criterion: "Technical approach approved by Tech Lead", pass: null, note: "Cannot auto-detect — verify with Tech Lead" });
    checks.push({ criterion: "Story fits within a single sprint", field: "Microsoft.VSTS.Scheduling.StoryPoints", pass: f["Microsoft.VSTS.Scheduling.StoryPoints"] ? f["Microsoft.VSTS.Scheduling.StoryPoints"] <= 8 : null, note: "Based on story points ≤ 8" });
  }

  return checks;
}

function hasContent(value, minLength = 10) {
  if (!value) return false;
  const stripped = value.replace(/<[^>]+>/g, "").trim();
  return stripped.length >= minLength;
}

function renderComplianceTable(checks) {
  const rows = checks.map((c) => {
    const icon = c.pass === true ? "✅" : c.pass === false ? "❌" : "⚠️";
    const note = c.note ? ` *(${c.note})*` : "";
    return `| ${icon} | ${c.criterion}${note} |`;
  });
  return [
    "| Status | Criterion |",
    "|--------|-----------|",
    ...rows,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Claude prompt builder
// ---------------------------------------------------------------------------
function buildRefineSystemPrompt(dorPassed = true) {
  const devPlanSections = dorPassed ? `
### Development Plan

A realistic technical breakdown based on the actual source files provided. Reference specific files, classes, components, or patterns you can see in the code. Include:
- Which repos and files are affected
- Where exactly the change lands (file, class, method level if visible)
- Suggested implementation approach referencing existing patterns in the code
- Risks or unknowns to clarify before starting

### Suggested Tasks

A flat list of concrete development tasks ready to create as ADO child items. Format each as:
\`[ ] Task title — brief description\`` : `
> ⚠️ **Development plan and suggested tasks skipped** — this PBI has hard DoR failures that must be resolved first. Address the gaps below before requesting a development plan.`;

  return `You are a senior product manager and tech lead helping prepare PBIs for sprint refinement.

For each PBI provided, produce a structured refinement report in markdown with these exact sections:

### DoR Assessment

A qualitative assessment of the criteria that require human judgment (AC quality, happy path, edge cases, error handling, personas, dependencies). Be specific — quote or reference the actual AC text. Flag exactly what is missing or unclear.

### Gaps to Address

A numbered list of concrete actions the PO or team must take before this PBI is ready for refinement. Each gap should be actionable: "Add AC covering the error state when X fails" not "improve AC".

### Suggested Acceptance Criteria

Only if AC is missing or clearly incomplete. Write in Given/When/Then or clear declarative format. Cover happy path, edge cases, negative scenarios, and error handling based on what you can infer from the description. Mark assumptions with *(assumption)*.
${devPlanSections}

---

Rules:
- Be direct and specific — no generic advice
- If the PBI is a Bug, skip "Suggested Acceptance Criteria" and "Development Plan"; focus on reproduction quality, root cause hypotheses, and fix tasks
- Do not repeat the PBI title or description back verbatim — reference it, don't copy it
- If something looks good, say so briefly — don't pad with praise`;
  return `You are a senior product manager and tech lead helping prepare PBIs for sprint refinement.

For each PBI provided, produce a structured refinement report in markdown with these exact sections:

### DoR Assessment

A qualitative assessment of the criteria that require human judgment (AC quality, happy path, edge cases, error handling, personas, dependencies). Be specific — quote or reference the actual AC text. Flag exactly what is missing or unclear.

### Gaps to Address

A numbered list of concrete actions the PO or team must take before this PBI is ready for refinement. Each gap should be actionable: "Add AC covering the error state when X fails" not "improve AC".

### Suggested Acceptance Criteria

Only if AC is missing or clearly incomplete. Write in Given/When/Then or clear declarative format. Cover happy path, edge cases, negative scenarios, and error handling based on what you can infer from the description. Mark assumptions with *(assumption)*.

### Development Plan

A realistic technical breakdown based on the actual source files provided. Reference specific files, classes, components, or patterns you can see in the code. Include:
- Which repos and files are affected
- Where exactly the change lands (file, class, method level if visible)
- Suggested implementation approach referencing existing patterns in the code
- Risks or unknowns to clarify before starting

### Suggested Tasks

A flat list of concrete development tasks ready to create as ADO child items. Format each as:
\`[ ] Task title — brief description\`

---

Rules:
- Be direct and specific — no generic advice
- If the PBI is a Bug, skip "Suggested Acceptance Criteria" and "Development Plan"; focus on reproduction quality, root cause hypotheses, and fix tasks
- Do not repeat the PBI title or description back verbatim — reference it, don't copy it
- If something looks good, say so briefly — don't pad with praise`;
}

function formatWorkItemForPrompt(wi) {
  const f = wi.fields;
  const type = f["System.WorkItemType"];
  const ac = f["Microsoft.VSTS.Common.AcceptanceCriteria"]
    ? f["Microsoft.VSTS.Common.AcceptanceCriteria"].replace(/<[^>]+>/g, "").trim()
    : "(none)";
  const desc = f["System.Description"]
    ? f["System.Description"].replace(/<[^>]+>/g, "").trim()
    : "(none)";

  return [
    `## #${f["System.Id"]} — ${f["System.Title"]}`,
    `**Type:** ${type}`,
    `**State:** ${f["System.State"]}`,
    `**Story Points:** ${f["Microsoft.VSTS.Scheduling.StoryPoints"] ?? "not estimated"}`,
    `**Area:** ${f["System.AreaPath"]}`,
    `**Iteration:** ${f["System.IterationPath"]}`,
    ``,
    `### Description`,
    desc,
    ``,
    `### Acceptance Criteria`,
    ac,
  ].join("\n");
}


// ---------------------------------------------------------------------------
// Pass 1: ask Claude which files it needs to read for the development plan
// ---------------------------------------------------------------------------
function buildPass1Prompt() {
  return `You are a senior engineer planning a development task.

You will be given a PBI (user story or bug) and the file tree of the VS Code workspace.
Your job is to identify which source files you need to read to write a realistic development plan.

Choose files that are directly relevant — existing implementations of similar features,
shared services, base classes, interfaces, navigation/routing files, or API contracts
that the new work will touch or extend.

Be selective: request the minimum files needed to understand the impact and approach.
Max 15 files.

Respond ONLY with a JSON array of relative file paths (relative to their repo root,
prefixed with the repo folder name). Example:
["App.Mobile/src/screens/Notifications/NotificationList.tsx", "App.Api/Controllers/NotificationsController.cs"]

No explanation, no markdown, just the JSON array.`;
}

async function requestFilesFromClaude(wi, workspace) {
  const wiText = formatWorkItemForPrompt(wi);
  const treeText = formatWorkspaceTree(workspace);

  const userPrompt =
    `PBI to plan:\n\n${wiText}\n\n` +
    `Workspace file tree:\n\n${treeText}\n\n` +
    `Which files do you need to read to write a development plan for this PBI?`;

  const raw = await runClaude(buildPass1Prompt(), userPrompt);

  // Extract JSON array from response
  const match = raw.match(/\[.*?\]/s);
  if (!match) return [];
  try { return JSON.parse(match[0]); }
  catch { return []; }
}

// ---------------------------------------------------------------------------
// Claude invocation
// ---------------------------------------------------------------------------
async function generateViaCLI(systemPrompt, userPrompt) {
  const { execSync } = await import("child_process");
  const os = await import("os");

  const tmpFile = path.join(os.tmpdir(), `refine-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, `${systemPrompt}\n\n---\n\n${userPrompt}`, "utf8");

  try {
    const result = execSync(`cat "${tmpFile}" | claude -p --dangerously-skip-permissions`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
    return result.trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

async function generateViaAPI(systemPrompt, userPrompt) {
  const apiKey = getSecret("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not found");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) throw new Error(`Claude API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.content.find((b) => b.type === "text")?.text ?? "";
}

async function runClaude(systemPrompt, userPrompt) {
  return GENERATION_MODE === "claude-code"
    ? generateViaCLI(systemPrompt, userPrompt)
    : generateViaAPI(systemPrompt, userPrompt);
}

// ---------------------------------------------------------------------------
// Per-PBI report
// ---------------------------------------------------------------------------
async function analyseWorkItem(wi, workspaceCtx) {
  const f = wi.fields;
  const id = f["System.Id"];
  const title = f["System.Title"];
  const type = f["System.WorkItemType"];

  console.log(`\n  Analysing #${id}: ${title}`);

  // Static field checks
  const checks = checkFieldCompliance(wi);
  const passed = checks.filter((c) => c.pass === true).length;
  const failed = checks.filter((c) => c.pass === false).length;
  const unknown = checks.filter((c) => c.pass === null).length;
  const total = checks.length;

  console.log(`   Field checks: ${passed}/${total} passed, ${failed} failed, ${unknown} require manual review`);

  // If any hard failures, skip the development plan entirely — PBI is not ready
  const dorPassed = failed === 0;

  if (!dorPassed) {
    console.log(`   ⛔ DoR not met (${failed} hard failure(s)) — skipping development plan`);
  }

  // Pass 1: ask Claude which files it needs — only if DoR passed and workspace is available
  let codeContext = "";
  if (dorPassed && workspaceCtx) {
    console.log(`   Pass 1: asking Claude which files to read...`);
    const requestedPaths = await requestFilesFromClaude(wi, workspaceCtx);
    if (requestedPaths.length > 0) {
      console.log(`   Reading ${requestedPaths.length} file(s): ${requestedPaths.join(", ")}`);
      const readFiles = await readRequestedFiles(workspaceCtx, requestedPaths);
      const found = readFiles.filter(f => f.content !== null).length;
      console.log(`   ${found}/${requestedPaths.length} file(s) read successfully`);
      codeContext = `\n\n### Source Files\n\n${formatReadFiles(readFiles)}`;
    } else {
      console.log(`   Pass 1: no specific files requested — proceeding with file tree only`);
      codeContext = `\n\n### Workspace File Tree\n\n${formatWorkspaceTree(workspaceCtx)}`;
    }
  }

  // Pass 2: refinement report — scope depends on DoR status
  console.log(`   ${dorPassed ? "Pass 2: generating full report..." : "Generating DoR gap report..."}`);
  const systemPrompt = buildRefineSystemPrompt(dorPassed);
  const userPrompt =
    `Analyse this ${type} and produce a refinement report.\n\n` +
    formatWorkItemForPrompt(wi) +
    codeContext;

  const claudeAnalysis = await runClaude(systemPrompt, userPrompt);

  // Post ADO comment if DoR failed — show for review first
  if (!dorPassed) {
    try {
      const gaps = extractGapsSection(claudeAnalysis);
      const comment = buildDoRComment(checks, gaps);

      console.log(`\n   📝 Comment to post on #${id}:\n`);
      console.log("   " + comment.split("\n").join("\n   "));
      console.log();

      const confirmed = await promptConfirm(`   Post this comment on #${id}? [y/N] `);
      if (confirmed) {
        await postAdoComment(id, comment);
        console.log(`   💬 Comment posted on #${id}`);
      } else {
        console.log(`   Skipped — comment not posted on #${id}`);
      }
    } catch (e) {
      console.warn(`   ⚠️  Could not post comment on #${id}: ${e.message}`);
    }
  }

  // Assemble full report section
  const dorBadge = dorPassed ? "🟢 DoR — no hard failures" : `🔴 DoR — ${failed} hard failure(s) — development plan skipped`;
  const header = [
    `---`,
    ``,
    `# #${id} — ${title}`,
    ``,
    `**Type:** ${type} | **State:** ${f["System.State"]} | **Points:** ${f["Microsoft.VSTS.Scheduling.StoryPoints"] ?? "—"} | ${dorBadge}`,
    ``,
    `## DoR Field Check`,
    ``,
    `${passed} of ${total} auto-checkable criteria passed. ${failed} failed. ${unknown} require manual verification.`,
    ``,
    renderComplianceTable(checks),
    ``,
    `## Claude Analysis`,
    ``,
  ].join("\n");

  return header + claudeAnalysis + "\n";
}

async function promptConfirm(question) {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

// ---------------------------------------------------------------------------
// Output path
// ---------------------------------------------------------------------------
function outputPath(productKey) {
  const date = new Date().toISOString().slice(0, 10);
  return `./refine-${productKey}-${date}.md`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function printUsage() {
  console.error("Usage:");
  console.error("  node refine.mjs <product>          — analyse all refine-ready PBIs");
  console.error("  node refine.mjs <product> <id>     — analyse a single PBI by ID");
  console.error("  node refine.mjs --list              — list configured products");
  console.error("");
  console.error("Output: refine-<product>-<date>.md");
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--list") {
    console.log("\nConfigured products:\n");
    for (const [key, p] of Object.entries(PRODUCTS)) {
      console.log(`  ${key.padEnd(14)} tag: ${p.tag}`);
    }
    console.log();
    return;
  }

  const [productKey, singleId] = args;

  if (!productKey) {
    printUsage();
    process.exit(1);
  }

  const product = PRODUCTS[productKey];
  if (!product) {
    console.error(`❌ Unknown product: "${productKey}". Run --list to see options.`);
    process.exit(1);
  }

  console.log(`\n🔍 Refinement Assistant — ${product.name}\n`);

  // Read workspace context once
  const workspaceCtx = await readWorkspaceContext();
  if (workspaceCtx) {
    console.log(`📁 Workspace: ${workspaceCtx.file}`);
    console.log(`   Repos: ${workspaceCtx.repos.map(r => r.name).join(", ")}\n`);
  } else {
    console.log("⚠️  No .code-workspace file found — development plan will use standard stack context\n");
  }

  let workItems;

  if (singleId) {
    // Single PBI mode
    console.log(`Fetching PBI #${singleId}...`);
    const wi = await fetchSingleWorkItem(singleId);
    workItems = [wi];
  } else {
    // All tagged PBIs
    console.log(`Fetching work items tagged "${product.tag}"...`);
    workItems = await fetchTaggedWorkItems(product.tag);
    if (workItems.length === 0) {
      console.log(`\nNothing found. Tag PBIs with "${product.tag}" and re-run.\n`);
      process.exit(0);
    }
  }

  const date = new Date().toLocaleDateString("en-GB");
  const docHeader = [
    `# Refinement Report — ${product.name}`,
    `Generated: ${date} | Work items: ${workItems.map((w) => `#${w.fields["System.Id"]}`).join(", ")}`,
    ``,
    `> This report combines automated DoR field checks with Claude's qualitative assessment.`,
    `> **Auto-checks** flag missing or empty fields. **Claude Analysis** covers AC quality,`,
    `> edge cases, development planning, and suggested tasks.`,
    ``,
  ].join("\n");

  const sections = [];
  for (const wi of workItems) {
    const section = await analyseWorkItem(wi, workspaceCtx);
    sections.push(section);
  }

  const outPath = outputPath(productKey);
  fs.writeFileSync(outPath, docHeader + sections.join("\n"), "utf8");

  console.log(`\n💾 Report saved: ${outPath}`);
  console.log(`   ${workItems.length} work item(s) analysed.\n`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
