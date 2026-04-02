#!/usr/bin/env node
/**
 * cab-gen.mjs
 * Generates a CAB Knowledge Base document from ADO PBIs tagged with
 * "cab-ready-<product>", enriched with linked PR titles, descriptions,
 * and code diffs. Posts the result to the ADO Wiki.
 *
 * Usage:
 *   node cab-gen.mjs <product> <version>
 *   node cab-gen.mjs app 3.5.0
 *   node cab-gen.mjs --list
 *
 * Prerequisites:
 *   - ADO_PAT in .devagent (or as environment variable)
 *     PAT scopes required: Work Items Read, Code Read, Wiki Read/Write
 *   - Either: `claude` CLI installed (Claude Code subscription)
 *   - Or:     ANTHROPIC_API_KEY in .devagent — set GENERATION_MODE = "api"
 *   - `gh` CLI installed and authenticated (for GitHub PR fetching)
 *   - Node 18+ (uses native fetch)
 */

import fs from "fs";

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
// CONFIG — fill in once
// ---------------------------------------------------------------------------
const ADO = {
  org: process.env.ADO_ORG || "YOUR_ADO_ORG",
  project: process.env.ADO_PROJECT || "YOUR_ADO_PROJECT",
  wikiIdentifier: (process.env.ADO_PROJECT || "YOUR_ADO_PROJECT") + ".wiki", // ADO > Project Settings > Wiki
};

const PRODUCTS = {
  app: {
    tag: "cab-ready-app",
    name: "App Universo",
    wikiBasePath: "/Knowledge Base/App Universo",
  },
  usp: {
    tag: "cab-ready-usp",
    name: "USP",
    wikiBasePath: "/Knowledge Base/USP",
  },
  personalLoan: {
    tag: "cab-ready-personal-loan",
    name: "Personal Loans",
    wikiBasePath: "/Knowledge Base/Personal Loans",
  },
  uniportal: {
    tag: "cab-ready-uniportal",
    name: "Uniportal",
    wikiBasePath: "/Knowledge Base/Uniportal",
  },
  salesforce: {
    tag: "cab-ready-salesforce",
    name: "Salesforce",
    wikiBasePath: "/Knowledge Base/Salesforce",
  },
  onboarding: {
    tag: "cab-ready-onboarding",
    name: "Onboarding",
    wikiBasePath: "/Knowledge Base/Onboarding",
  },
};

// ---------------------------------------------------------------------------
// GitHub config — org name for gh CLI calls
// ---------------------------------------------------------------------------
const GITHUB = {
  org: process.env.GITHUB_ORG || "YOUR_GITHUB_ORG", // ← your GitHub org name
};

// ---------------------------------------------------------------------------
// Generation mode — set to "api" or "claude-code"
// "api"          requires ANTHROPIC_API_KEY in .devagent
// "claude-code"  requires the `claude` CLI (Claude Code subscription)
// ---------------------------------------------------------------------------
const GENERATION_MODE = "claude-code"; // ← change to "api" if you have an API key

const DIFF = {
  maxBytesPerFile: 8 * 1024,
  maxBytesTotal: 40 * 1024,
  maxFiles: 20,
  skipPatterns: [
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.ya?ml$/,
    /\.min\.(js|css)$/,
    /[/\\]migrations[/\\]/,
    /\.g\.cs$/,
    /\.generated\./,
    /[/\\](bin|obj|\.vs)[/\\]/,
    /appsettings\..+\.json$/,
    /\.(suo|user|DotSettings)$/,
    /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/,
  ],
  priorityExtensions: [".cs", ".ts", ".tsx", ".js", ".jsx", ".py", ".sql", ".yaml", ".yml"],
};

// ---------------------------------------------------------------------------
// ADO HTTP helpers — native fetch, no shell escaping
// ---------------------------------------------------------------------------
function adoAuthHeader() {
  const pat = getSecret("ADO_PAT");
  if (!pat) throw new Error("ADO_PAT not found — set it in .devagent or as an environment variable");
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

async function adoFetch(path, options = {}) {
  const url = `https://dev.azure.com/${ADO.org}/${ADO.project}/_apis${path}`;
  const qs = new URLSearchParams({ "api-version": options.apiVersion ?? "7.1" });
  // Extra params passed explicitly — avoids them being baked into the path string
  // where they can collide with api-version or get percent-encoded unexpectedly
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      qs.set(k, v);
    }
  }
  const res = await fetch(`${url}?${qs}`, {
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

async function adoFetchRaw(url) {
  const res = await fetch(url, {
    headers: { Authorization: adoAuthHeader(), Accept: "text/plain" },
  });
  if (!res.ok) throw new Error(`ADO raw fetch ${res.status}: ${url}`);
  return res.text();
}

async function adoFetchWithHeaders(path, options = {}) {
  const url = `https://dev.azure.com/${ADO.org}/${ADO.project}/_apis${path}`;
  const qs = new URLSearchParams({ "api-version": options.apiVersion ?? "7.1" });
  return fetch(`${url}?${qs}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: adoAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

// adoGitFetch uses the org-level URL (no project scope) so it works for
// repos in any project within the same org
async function adoGitFetch(path, options = {}) {
  const url = `https://dev.azure.com/${ADO.org}/_apis/git${path}`;
  const qs = new URLSearchParams({ "api-version": options.apiVersion ?? "7.1" });
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) qs.set(k, v);
  }
  const res = await fetch(`${url}?${qs}`, {
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
    throw new Error(`ADO API ${res.status} on /git${path}: ${text}`);
  }
  return res.json();
}

// Blob fetch also needs org-level URL
async function adoGitFetchRaw(repoId, objectId) {
  const url = `https://dev.azure.com/${ADO.org}/_apis/git/repositories/${repoId}/blobs/${objectId}?$format=text&api-version=7.1`;
  const res = await fetch(url, {
    headers: { Authorization: adoAuthHeader(), Accept: "text/plain" },
  });
  if (!res.ok) throw new Error(`ADO blob fetch ${res.status}: ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt(productName) {
  return `You are a technical writer producing a CAB (Change Advisory Board) Knowledge Base
document for ${productName}.

The document must be written entirely in English.
The target reader is a SUPPORT AGENT handling a live incident — not a developer.
The document's goal is maximum support autonomy: the agent should be able to
diagnose, scope, and resolve (or correctly escalate) any incident without involving
the dev team.

You will receive PBI metadata (title, description, acceptance criteria) AND, where
available, associated pull request context: PR title, PR description, changed file
list, and file contents from merged PRs.

USE THE CODE CONTEXT to:
- Name the exact microservice/component/API endpoint that changed
- Write realistic Verification Steps (what to check in App Insights, back-office, etc.)
- Identify Known Limitations (things that look broken but aren't)
- Determine Affected Scope (all users? iOS only? version-gated?)
- Infer Feature Flag names from code (look for feature toggle checks, app config keys)
- Spot Self-Service Actions (back-office resets, cache clears, retry mechanisms)
- Write a symptom-driven Escalation Decision Tree (not just a name)
- Identify which external vendors are in the call path (MEA Wallet, Firebase, Apple, Claranet)
Do NOT reproduce code. Translate everything into plain English for support agents.
If a field cannot be determined from context, write "TBC — verify with [owner]".

Format output as Markdown with this EXACT structure per feature:

# ${productName} {VERSION} — CAB Knowledge Base

**Version:** {VERSION}
**Release date:** {DATE}

---

## Release Summary
[2–3 sentences. What changed, why, and cross-cutting notes: migrations, flags, platform scope.]

---

## Features and Changes

### #[PBI_ID] — [Feature Name]
**Owner:** [Owner if known, otherwise "TBC"]
**Type:** New Feature | Improvement | Fix | Technical

#### Description
[3–5 sentences. Functional + technical. Name the service/component. Mention API endpoints if visible.]

#### Previous Behaviour
[How this worked before this release. "N/A" for new features.]

#### Current Behaviour
[How it works now — numbered steps a support agent can follow to verify it's working.]
1. ...

#### Verification Steps
[How support confirms working vs broken. Reference back-office screens, App Insights queries.]
1. ...

#### Known Limitations / Expected Non-Bugs
- ...

#### Affected Scope
- **Users:** [All | Subset — describe]
- **Platforms:** [iOS | Android | Both]
- **Version gate:** [e.g. Only users on ${productName} X.Y.Z+]
- **Repos affected:** [List repos from the PR context — e.g. App.Mobile, App.Api]

#### Feature Flag
**Flag name:** \`[name from code, or "None"]\`
**Location:** [Azure App Config / Variable Group / not applicable]
**To disable:** [Exact instruction]
**Effect of disabling:** [What the user sees or loses]
**Who can do this:** [Support lead / on-call engineer / requires dev]

#### Self-Service Actions
- **[Action]:** [Where and exactly how to do it]
- If none: "None — escalate to dev team for any data corrections."

#### Rollback
**Reversible:** Yes | No | Partial
**Procedure:** [Steps, or "Use feature flag above"]
**Data impact:** [Does rollback affect user data? Migrations to reverse?]

#### Escalation
**First contact:** [Owner name]
**Decision tree:**
- [Symptom A] → [Check X] → [If confirmed: do Y | escalate to Z with: info to provide]
- [Symptom B] → [Escalate to owner with: user ID, OS/version, timestamp]

**Vendor involvement:**
- [MEA Wallet | Claranet | Apple | Firebase] — [when and what info to provide]

#### External Status Pages
- [Vendor]: [URL]

---
[Repeat for each PBI]

---

## Technical Changes (no user impact)
[Config changes, new env vars, infra updates support should know about.]

---

## Rollback — Release Level
[Who authorises it, procedure, data impact.]

Known team owners for App Universo:
- Notifications / Chat: Magda Mendonça
- Contracts / Regulatory: Tânia Costa
- Personal Credit: Pedro Faria
- Apple Pay / Tokenisation: escalate to MEA Wallet
- Infra / Pipelines: Claranet

External status pages:
- Firebase Cloud Messaging: https://status.firebase.google.com
- Apple System Status (APNS): https://www.apple.com/support/systemstatus/

Rules:
- Plain language — no stack traces, no internal error codes without explanation
- Never leave a field blank — write "TBC — verify with [owner]" if unknown
- Each feature section must be fully self-contained
- Do not reproduce code snippets
- Escalation must be symptom-driven, not just a contact name
- Customer templates must be copy-pasteable with minimal editing
- Output only the Markdown document — no preamble or closing remarks`;
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------
async function fetchTaggedPBIs(tag) {
  console.log(`🔍 Querying ADO for PBIs tagged "${tag}"...`);

  const wiqlResult = await adoFetch("/wit/wiql", {
    method: "POST",
    body: {
      query: `SELECT [System.Id] FROM WorkItems
              WHERE [System.TeamProject] = '${ADO.project}'
              AND [System.Tags] CONTAINS '${tag}'
              AND [System.WorkItemType] IN ('Product Backlog Item', 'Bug', 'Task', 'Incident')
              AND [System.State] NOT IN ('Done', 'Closed', 'Removed', 'Resolved')
              ORDER BY [System.ChangedDate] DESC`,
    },
  });

  const ids = wiqlResult.workItems?.map((wi) => wi.id) ?? [];
  if (ids.length === 0) {
    console.log(`⚠️  No PBIs found with tag "${tag}".`);
    return [];
  }
  console.log(`✅ Found ${ids.length} PBI(s): ${ids.join(", ")}`);

  const fields = [
    "System.Id", "System.Title", "System.Description", "System.Tags",
    "System.State", "System.WorkItemType",
    "Microsoft.VSTS.Common.AcceptanceCriteria",
    "System.AreaPath", "System.AssignedTo",
  ].join(",");

  // ADO doesn't allow $expand and fields together — two separate batch calls, merged by id
  const workItems = [];
  const relationsMap = {};

  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200).join(",");

    // Call 1: fields
    const fieldsResult = await adoFetch(`/wit/workitems`, { params: { ids: chunk, fields } });
    workItems.push(...(fieldsResult.value ?? []));

    // Call 2: relations only
    const relationsResult = await adoFetch(`/wit/workitems`, { params: { ids: chunk, '$expand': 'Relations' } });
    for (const wi of relationsResult.value ?? []) {
      relationsMap[wi.id] = wi.relations ?? [];
    }
  }

  // Merge relations into work items
  for (const wi of workItems) {
    wi.relations = relationsMap[wi.id] ?? [];
  }

  return workItems;
}

// ---------------------------------------------------------------------------
// PR extraction — supports both ADO Git and GitHub PRs
// ---------------------------------------------------------------------------

// ADO artifact link: vstfs:///Git/PullRequestId/<projectId>/<repoId>/<prId>
function parseAdoPRLink(url) {
  try {
    const decoded = decodeURIComponent(url);
    const match = decoded.match(/PullRequestId\/([^/]+)\/([^/]+)\/(\d+)$/);
    if (match) return { source: "ado", repoId: match[2], prId: parseInt(match[3], 10) };
  } catch { /* ignore */ }
  return null;
}

// GitHub external link: https://github.com/<org>/<repo>/pull/<prId>
function parseGitHubPRLink(url) {
  try {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (match) return { source: "github", org: match[1], repo: match[2], prId: parseInt(match[3], 10) };
  } catch { /* ignore */ }
  return null;
}

function extractPRLinksFromWorkItem(workItem) {
  return (workItem.relations ?? [])
    .flatMap((r) => {
      // ADO Git PR artifact links
      if (r.rel === "ArtifactLink" && r.url?.includes("PullRequestId")) {
        const link = parseAdoPRLink(r.url);
        return link ? [link] : [];
      }
      // GitHub PR external links (ADO stores these as Hyperlink or GitHub link relations)
      if ((r.rel === "Hyperlink" || r.rel === "GitHub Pull Request" || r.rel === "GitHub.PullRequest") && r.url?.includes("github.com") && r.url?.includes("/pull/")) {
        const link = parseGitHubPRLink(r.url);
        return link ? [link] : [];
      }
      return [];
    });
}

function shouldSkipFile(filePath) {
  return DIFF.skipPatterns.some((p) => p.test(filePath));
}

function priorityScore(filePath) {
  const ext = filePath.match(/\.[^.]+$/)?.[0] ?? "";
  const idx = DIFF.priorityExtensions.indexOf(ext);
  return idx === -1 ? DIFF.priorityExtensions.length : idx;
}

async function fetchPRContext(repoId, prId) {
  const pr = await adoGitFetch(`/repositories/${repoId}/pullRequests/${prId}`);
  if (pr.status !== "completed") return null;

  const context = {
    prId,
    repoName: pr.repository?.name ?? repoId,
    title: pr.title ?? "",
    description: pr.description ?? "",
    mergedBy: pr.closedBy?.displayName ?? "unknown",
    mergeDate: pr.closedDate?.split("T")[0] ?? "",
    files: [],
    diffSummary: "",
  };

  const iterations = await adoGitFetch(`/repositories/${repoId}/pullRequests/${prId}/iterations`);
  const lastIteration = iterations.value?.at(-1);
  if (!lastIteration) return context;

  const changes = await adoGitFetch(`/repositories/${repoId}/pullRequests/${prId}/iterations/${lastIteration.id}/changes`);

  const allFiles = (changes.changeEntries ?? [])
    .filter((c) => c.item?.path && !shouldSkipFile(c.item.path))
    .map((c) => ({ path: c.item.path, changeType: c.changeType, objectId: c.item.objectId }))
    .sort((a, b) => priorityScore(a.path) - priorityScore(b.path))
    .slice(0, DIFF.maxFiles);

  context.files = allFiles.map((f) => `${f.changeType.padEnd(6)} ${f.path}`);

  let totalBytes = 0;
  const diffParts = [];

  for (const file of allFiles) {
    if (totalBytes >= DIFF.maxBytesTotal) break;
    if (file.changeType === "delete" || !file.objectId) continue;

    try {
      let content = await adoGitFetchRaw(repoId, file.objectId);

      if (Buffer.byteLength(content) > DIFF.maxBytesPerFile) {
        content = content.slice(0, DIFF.maxBytesPerFile) + "\n... (truncated)";
      }

      totalBytes += Buffer.byteLength(content);
      diffParts.push(`### ${file.changeType.toUpperCase()}: ${file.path}\n\`\`\`\n${content}\n\`\`\``);
    } catch { /* skip files that fail */ }
  }

  context.diffSummary = diffParts.join("\n\n");
  return context;
}

// ---------------------------------------------------------------------------
// GitHub PR fetch via gh CLI
// ---------------------------------------------------------------------------
async function fetchGitHubPRContext(org, repo, prId) {
  const { execSync } = await import("child_process");

  const prJson = execSync(
    `gh api repos/${org}/${repo}/pulls/${prId}`,
    { encoding: "utf8", timeout: 30000 }
  );
  const pr = JSON.parse(prJson);

  if (pr.state !== "closed" || !pr.merged_at) return null;

  const context = {
    prId,
    source: "github",
    repoName: repo,
    title: pr.title ?? "",
    description: pr.body ?? "",
    mergedBy: pr.merged_by?.login ?? "unknown",
    mergeDate: pr.merged_at?.split("T")[0] ?? "",
    files: [],
    diffSummary: "",
  };

  // Fetch changed files
  const filesJson = execSync(
    `gh api repos/${org}/${repo}/pulls/${prId}/files --paginate`,
    { encoding: "utf8", timeout: 30000 }
  );
  const allFiles = JSON.parse(filesJson)
    .filter((f) => !shouldSkipFile(f.filename))
    .sort((a, b) => priorityScore(a.filename) - priorityScore(b.filename))
    .slice(0, DIFF.maxFiles);

  context.files = allFiles.map((f) => `${f.status.padEnd(6)} ${f.filename}`);

  // Fetch file contents for priority files
  let totalBytes = 0;
  const diffParts = [];

  for (const file of allFiles) {
    if (totalBytes >= DIFF.maxBytesTotal) break;
    if (file.status === "removed" || !file.contents_url) continue;

    try {
      const fileJson = execSync(
        `gh api "${file.contents_url.replace("https://api.github.com/", "")}"`,
        { encoding: "utf8", timeout: 15000 }
      );
      const fileData = JSON.parse(fileJson);
      if (fileData.encoding !== "base64") continue;

      let fileContent = Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf8");
      if (Buffer.byteLength(fileContent) > DIFF.maxBytesPerFile) {
        fileContent = fileContent.slice(0, DIFF.maxBytesPerFile) + "\n... (truncated)";
      }
      totalBytes += Buffer.byteLength(fileContent);
      diffParts.push(`### ${file.status.toUpperCase()}: ${file.filename}\n\`\`\`\n${fileContent}\n\`\`\``);
    } catch { /* skip files that fail */ }
  }

  context.diffSummary = diffParts.join("\n\n");
  return context;
}

async function fetchAllPRContextForWorkItem(workItem) {
  const links = extractPRLinksFromWorkItem(workItem);
  if (links.length === 0) return [];

  const results = [];
  for (const link of links) {
    try {
      if (link.source === "github") {
        console.log(`   📎 Fetching GitHub PR #${link.prId} (${link.repo})...`);
        const ctx = await fetchGitHubPRContext(link.org, link.repo, link.prId);
        if (ctx) results.push(ctx);
      } else {
        console.log(`   📎 Fetching ADO PR #${link.prId}...`);
        const ctx = await fetchPRContext(link.repoId, link.prId);
        if (ctx) results.push(ctx);
      }
    } catch (err) {
      console.log(`   ⚠️  Could not fetch PR #${link.prId}: ${err.message}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Format for Claude
// ---------------------------------------------------------------------------
function formatWorkItemsForPrompt(workItems, prContextMap) {
  const stripHtml = (html) =>
    html ? html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";

  return workItems.map((wi) => {
    const f = wi.fields;
    const prs = prContextMap[wi.id] ?? [];

    const prSection = prs.length === 0
      ? "No linked merged PRs found."
      : prs.map((pr) => [
          `#### PR #${pr.prId} (${pr.repoName}): ${pr.title}`,
          pr.description ? `**PR Description:** ${pr.description}` : "",
          `**Merged by:** ${pr.mergedBy} on ${pr.mergeDate}`,
          pr.files.length > 0
            ? `**Changed files (${pr.files.length}):**\n${pr.files.map((f) => `  - ${f}`).join("\n")}`
            : "",
          pr.diffSummary ? `**File contents:**\n${pr.diffSummary}` : "",
        ].filter(Boolean).join("\n")).join("\n\n");

    const reposAffected = prs.length > 0
      ? [...new Set(prs.map((pr) => pr.repoName))].join(", ")
      : "unknown";

    return [
      `### #${f["System.Id"]} — ${f["System.Title"]}`,
      `**Type:** ${f["System.WorkItemType"]}`,
      `**State:** ${f["System.State"]}`,
      `**Area:** ${f["System.AreaPath"] ?? ""}`,
      `**Assigned to:** ${f["System.AssignedTo"]?.displayName ?? "Unassigned"}`,
      `**Repos affected:** ${reposAffected}`,
      ``,
      `### Description`,
      stripHtml(f["System.Description"]) || "(no description)",
      ``,
      `### Acceptance Criteria`,
      stripHtml(f["Microsoft.VSTS.Common.AcceptanceCriteria"]) || "(none)",
      ``,
      `### Linked Pull Requests`,
      prSection,
    ].join("\n");
  }).join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Claude API
// ---------------------------------------------------------------------------
async function generateCabDocument(promptText, product, version) {
  console.log(`🤖 Generating CAB document via Claude (${GENERATION_MODE})...`);

  const today = new Date().toLocaleDateString("en-GB");
  const systemPrompt = buildSystemPrompt(product.name)
    .replaceAll("{VERSION}", version)
    .replaceAll("{DATE}", today);

  const userPrompt =
    `Generate a CAB Knowledge Base document for ${product.name} version ${version} ` +
    `(release date ${today}).\n\n` +
    `PBIs included in this release (tagged "${product.tag}"), with linked PR and code context:\n\n` +
    promptText;

  if (GENERATION_MODE === "claude-code") {
    return generateViaCLI(systemPrompt, userPrompt);
  } else {
    return generateViaAPI(systemPrompt, userPrompt);
  }
}

async function generateViaCLI(systemPrompt, userPrompt) {
  const { execSync } = await import("child_process");
  const os = await import("os");
  const path = await import("path");

  // Write full prompt to a temp file — avoids any shell escaping issues
  const tmpFile = path.join(os.tmpdir(), `cab-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, `${systemPrompt}\n\n---\n\n${userPrompt}`, "utf8");

  try {
    const result = execSync(`cat "${tmpFile}" | claude -p --dangerously-skip-permissions`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000, // 5 min timeout
    });
    return result.trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

async function generateViaAPI(systemPrompt, userPrompt) {
  const apiKey = getSecret("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not found — set it in .devagent or as an environment variable");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status} — ${await response.text()}`);
  }

  const data = await response.json();
  return data.content.find((b) => b.type === "text")?.text ?? "";
}

// ---------------------------------------------------------------------------
// ADO Wiki
// ---------------------------------------------------------------------------
async function postToWiki(product, version, content) {
  const pagePath = `${product.wikiBasePath}/${version}`;
  const qs = new URLSearchParams({ path: pagePath, "api-version": "7.1" });
  const pageUrl = `https://dev.azure.com/${ADO.org}/${ADO.project}/_apis/wiki/wikis/${ADO.wikiIdentifier}/pages?${qs}`;

  console.log(`📖 Posting to Wiki: ${pagePath}`);

  // Check if page exists and get ETag
  const checkRes = await fetch(pageUrl, {
    headers: { Authorization: adoAuthHeader(), Accept: "application/json" },
  });

  const headers = { Authorization: adoAuthHeader(), "Content-Type": "application/json" };
  if (checkRes.ok) {
    const etag = checkRes.headers.get("ETag");
    if (etag) headers["If-Match"] = etag;
  }

  const putRes = await fetch(pageUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({ content }),
  });

  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`Wiki API ${putRes.status}: ${text}`);
  }

  const parsed = await putRes.json();
  if (parsed.remoteUrl) {
    console.log(`✅ Wiki page created/updated.`);
    return parsed.remoteUrl;
  }
  console.error("⚠️  Unexpected Wiki API response:", JSON.stringify(parsed, null, 2));
  return null;
}

// ---------------------------------------------------------------------------
// Enrich: fills TBC / incomplete fields in an existing draft
// ---------------------------------------------------------------------------
async function enrichCabDocument(existingDraft, promptText, product, version) {
  const today = new Date().toLocaleDateString("en-GB");

  const systemPrompt = `You are a technical writer improving an existing CAB Knowledge Base document.

Your ONLY job is to fill in fields that are marked as "TBC", "TBC — verify with [owner]",
or contain placeholder text like "[...]". Do NOT change, rewrite, or reformat anything else.
Every section, sentence, and word the human wrote must be preserved exactly as-is.

Use the ADO PBI data and PR code context provided to fill in what's missing.
If you still cannot determine a value from the context, leave it as "TBC — verify with [owner]".

Return the complete document with only the TBC fields filled in. Nothing else.`;

  const userPrompt =
    `Here is the existing CAB document draft. Fill in only the TBC / placeholder fields.

` +
    `--- EXISTING DRAFT ---
${existingDraft}
--- END DRAFT ---

` +
    `--- ADO + PR CONTEXT ---
${promptText}
--- END CONTEXT ---`;

  if (GENERATION_MODE === "claude-code") {
    return generateViaCLI(systemPrompt, userPrompt);
  } else {
    return generateViaAPI(systemPrompt, userPrompt);
  }
}


// ---------------------------------------------------------------------------
// Release Notes generation
// ---------------------------------------------------------------------------
function buildReleaseNotesPrompt(productName, version) {
  return `És um redator técnico a produzir as release notes internas e o texto para as lojas de aplicações para ${productName} versão ${version}.

Deves produzir DOIS documentos separados no mesmo output.
Separa-os com esta linha exacta: ---STORE-COPY---
Não incluas mais nada além dos dois documentos.

===========================================================================
DOCUMENTO 1 — EMAIL DE RELEASE NOTES (pt-PT, para stakeholders internos)
===========================================================================

Segue este formato exactamente:

Assunto: [${productName}] Release Notes — Versão ${version}

Bom dia.

Foi submetida para aprovação nas stores a versão ${version} da ${productName}, uma release com foco em [tema em 1 frase], que inclui novas funcionalidades, melhorias e correções trabalhadas ao longo das últimas semanas. Esta release será publicada no dia [data — TBC se não souberes] com o seguinte conteúdo:

🆕 Novas Funcionalidades

1️⃣ [Nome da Funcionalidade]

[2–3 frases: o que mudou, quem é afectado, limites/formatos se relevante.]
Benefício: [uma linha — benefício para o utilizador ou negócio.]

2️⃣ [Nome da Funcionalidade]

[...]

🔧 Melhorias

1️⃣ [Nome da Melhoria]

[1–2 frases: o que mudou e por que é melhor.]

🩹 Correções

[ADO_ID] [Título da Correção]

Problema: [O que o utilizador experienciava.]
Correção: [O que foi corrigido.]
Resultado esperado: [O que o utilizador vê agora.]

🔎 Validação Pós-Produção

Convidamos todos os owners de negócio e equipa de monitorização a validar em ambiente de produção o correto funcionamento das correções e melhorias incluídas nesta release, com foco em:

[Um bullet por funcionalidade/correção em forma imperativa: "Confirmar...", "Validar..."]

Podem consultar a documentação funcional de apoio para confirmar os comportamentos e resolver potenciais problemas.

❓ Dúvidas e Esclarecimentos

Para qualquer dúvida, validação funcional ou esclarecimento sobre as funcionalidades e correções desta release, por favor direcionar para:

[Funcionalidade]: @[Owner]
Questões técnicas: @João Rodrigues
Incidentes: Equipa de suporte (via canais habituais)

Sempre que possível, indicar:

Versão da App
NIF / ID do cliente
Evidência (print, vídeo e/ou logs)

👏 Obrigado a todas as equipas envolvidas no desenvolvimento desta release, reforçando a experiência, a estabilidade e a conformidade da ${productName}.

---

Regras para o email:
- pt-PT: "ecrã" não "tela", "utilizador" não "usuário", "subscrições" não "assinaturas"
- Sem detalhes técnicos: sem APIs, microserviços, nomes de PRs
- Correções têm formato Problema / Correção / Resultado esperado — não bullets simples
- Omite secções vazias (sem 🔧 Melhorias se não houver melhorias)
- Se uma funcionalidade tem driver regulatório (ex: Banco de Portugal), menciona-o na descrição
- Owners por área: Notificações/Chat → @Magda Mendonca | Contratos/Cartões → @Tânia Costa | Crédito Pessoal → @Pedro Faria

===========================================================================
DOCUMENTO 2 — TEXTO PARA LOJAS (App Store + Google Play, idêntico)
===========================================================================

Formato:
[Linha de intro opcional — só se houver um tema forte nesta versão]

🆕 [Funcionalidade nova — benefício numa linha]
✨ [Melhoria existente]
🔧 [Fix técnico com impacto no utilizador]
🐛 [Bug fix — só se visível para o utilizador]

Mais clareza, mais segurança, mais ${productName}.

Regras para as lojas:
- Máximo 500 caracteres (limite do Google Play) — funciona em ambas as lojas
- Foco total no benefício para o utilizador — sem termos técnicos
- Tom directo: "Gere", "Consulta", "Envia" (não "implementámos", "foi adicionado")
- A linha de fecho é obrigatória e verbatim: "Mais clareza, mais segurança, mais ${productName}."
- Emojis: 🆕 nova funcionalidade | ✨ melhoria | 🔧 fix técnico com impacto | 🐛 bug visível | 📄 documentos | 🔔 notificações | 💬 chat | 💳 cartão`;
}

async function generateReleaseNotes(promptText, product, version, cabContent = null) {
  console.log("🤖 Generating release notes via Claude...");

  const systemPrompt = buildReleaseNotesPrompt(product.name, version);

  const sourceBlock = cabContent
    ? `O seguinte CAB document foi editado manualmente e é a fonte de verdade para esta release.\n` +
      `Usa o seu conteúdo como base — especialmente descrições de funcionalidades, comportamentos e correções.\n\n` +
      `--- CAB DOCUMENT ---\n${cabContent}\n--- END CAB DOCUMENT ---`
    : `Os seguintes PBIs fazem parte desta versão (tag "${product.tag}"), ` +
      `com contexto de PRs e código:\n\n${promptText}`;

  const userPrompt =
    `Gera as release notes e o texto para as lojas para ${product.name} versão ${version}.\n\n` +
    sourceBlock;

  if (GENERATION_MODE === "claude-code") {
    return generateViaCLI(systemPrompt, userPrompt);
  } else {
    return generateViaAPI(systemPrompt, userPrompt);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Extracts PBI IDs already documented in a draft by scanning for "### #<id> —" headings
function extractDraftPBIIds(draft) {
  const matches = [...draft.matchAll(/###\s+#(\d+)\s+[—-]/g)];
  return new Set(matches.map(m => parseInt(m[1], 10)));
}

// Generates sections for new PBIs not yet in the draft, returns markdown to append
async function generateNewSections(newWorkItems, prContextMap, product, version) {
  const today = new Date().toLocaleDateString("en-GB");
  const promptText = formatWorkItemsForPrompt(newWorkItems, prContextMap);

  const systemPrompt = buildSystemPrompt(product.name)
    .replaceAll("{VERSION}", version)
    .replaceAll("{DATE}", today);

  const userPrompt =
    `Generate ONLY the "## Features and Changes" entries for the following NEW PBIs. ` +
    `Do NOT include the document header, Release Summary, Technical Changes, or Rollback sections. ` +
    `Output only the ### feature sections so they can be appended to an existing document.\n\n` +
    `PBIs to document:\n\n${promptText}`;

  if (GENERATION_MODE === "claude-code") {
    return generateViaCLI(systemPrompt, userPrompt);
  } else {
    return generateViaAPI(systemPrompt, userPrompt);
  }
}

function localPath(productKey, version) {
  return `./cab-${productKey}-${version}.md`;
}

function releaseNotesPath(productKey, version) {
  return `./release-notes-${productKey}-${version}.md`;
}

function printUsage() {
  console.error("Usage:");
  console.error("  node cab-gen.mjs <product> <version>            — generate draft");
  console.error("  node cab-gen.mjs <product> <version> --enrich         — fill TBC fields in existing draft");
  console.error("  node cab-gen.mjs <product> <version> --release-notes  — generate release notes email + store copy");
  console.error("  node cab-gen.mjs <product> <version> --publish  — publish draft to wiki");
  console.error("  node cab-gen.mjs --list                         — list products");
  console.error("");
  console.error("Workflow:");
  console.error("  1. node cab-gen.mjs app 3.5.0           → generates cab-app-3.5.0.md");
  console.error("  2. Edit cab-app-3.5.0.md as needed");
  console.error("  3. node cab-gen.mjs app 3.5.0 --enrich  → fills remaining TBC fields");
  console.error("  4. node cab-gen.mjs app 3.5.0 --publish → posts to wiki");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--list") {
    console.log("\nAvailable products:\n");
    for (const [key, p] of Object.entries(PRODUCTS)) {
      console.log(`  ${key.padEnd(14)} tag: ${p.tag.padEnd(28)} wiki: ${p.wikiBasePath}`);
    }
    console.log();
    return;
  }

  const publishFlag      = args.includes("--publish");
  const enrichFlag       = args.includes("--enrich");
  const releaseNotesFlag = args.includes("--release-notes");
  const [productKey, version] = args.filter(a => !a.startsWith("--"));

  if (!productKey || !version) {
    printUsage();
    process.exit(1);
  }

  const product = PRODUCTS[productKey];
  if (!product) {
    console.error(`❌ Unknown product: "${productKey}". Available: ${Object.keys(PRODUCTS).join(", ")}`);
    process.exit(1);
  }

  const draftPath = localPath(productKey, version);

  // --publish: read local draft and post to wiki — no generation
  if (publishFlag) {
    if (!fs.existsSync(draftPath)) {
      console.error(`❌ No draft found at ${draftPath}`);
      console.error(`   Run without --publish first to generate it.`);
      process.exit(1);
    }
    const content = fs.readFileSync(draftPath, "utf8");
    console.log(`\n📤 Publishing ${draftPath} to wiki...\n`);
    const wikiUrl = await postToWiki(product, version, content);
    if (wikiUrl) console.log(`\n🔗 Wiki URL: ${wikiUrl}`);
    console.log(`\n✅ Published! ${product.name} ${version} is live on the wiki.\n`);
    return;
  }

  // --enrich: read draft, fetch fresh context, fill TBC fields only
  // --release-notes: generate release notes email + store copy
  if (releaseNotesFlag) {
    const rnPath = releaseNotesPath(productKey, version);

    if (fs.existsSync(rnPath)) {
      console.log(`\n📄 Release notes already exist: ${rnPath}`);
      console.log(`   Delete the file first to regenerate:\n   rm ${rnPath}\n`);
      process.exit(0);
    }

    console.log(`\n📝 Generating release notes — ${product.name} ${version}\n`);

    // Prefer the edited CAB draft as source of truth if it exists
    let promptText = null;
    let cabContent = null;

    if (fs.existsSync(draftPath)) {
      cabContent = fs.readFileSync(draftPath, "utf8");
      console.log(`📄 Using CAB draft as source: ${draftPath}`);
    } else {
      console.log(`ℹ️  No CAB draft found at ${draftPath} — fetching from ADO instead`);
      const workItems = await fetchTaggedPBIs(product.tag);
      if (workItems.length === 0) {
        console.log(`No tagged PBIs found. Tag PBIs with "${product.tag}" and re-run.`);
        process.exit(0);
      }

      console.log("\n🔗 Fetching linked PR context...");
      const prContextMap = {};
      for (const wi of workItems) {
        console.log(`  PBI ${wi.id}: ${wi.fields["System.Title"]}`);
        prContextMap[wi.id] = await fetchAllPRContextForWorkItem(wi);
        console.log(`   → ${prContextMap[wi.id].length} merged PR(s) found`);
      }
      promptText = formatWorkItemsForPrompt(workItems, prContextMap);
    }

    const output = await generateReleaseNotes(promptText, product, version, cabContent);
    if (!output) throw new Error("Claude returned an empty response.");

    // Split into email and store copy
    const [emailPart, storePart] = output.split("---STORE-COPY---");

    const rnContent = [
      `# ${product.name} ${version} — Release Notes\n`,
      `## Email para Stakeholders\n`,
      emailPart.trim(),
      `\n---\n`,
      `## Texto para Lojas (App Store + Google Play)\n`,
      (storePart ?? "").trim(),
    ].join("\n");

    fs.writeFileSync(rnPath, rnContent, "utf8");
    console.log(`\n💾 Release notes saved: ${rnPath}`);
    console.log(`   Edit it freely — re-running this flag won't overwrite it.\n`);
    return;
  }

  if (enrichFlag) {
    if (!fs.existsSync(draftPath)) {
      console.error(`❌ No draft found at ${draftPath}`);
      console.error(`   Run without flags first to generate it.`);
      process.exit(1);
    }

    console.log(`\n🔍 Enriching ${draftPath}...\n`);
    let draft = fs.readFileSync(draftPath, "utf8");

    // Fetch all currently tagged PBIs from ADO
    const workItems = await fetchTaggedPBIs(product.tag);
    console.log("\n🔗 Fetching linked PR context...");
    const prContextMap = {};
    for (const wi of workItems) {
      console.log(`  PBI ${wi.id}: ${wi.fields["System.Title"]}`);
      prContextMap[wi.id] = await fetchAllPRContextForWorkItem(wi);
      console.log(`   → ${prContextMap[wi.id].length} merged PR(s) found`);
    }

    // Back up before any writes
    const backupPath = `${draftPath}.bak`;
    fs.copyFileSync(draftPath, backupPath);
    console.log(`\n   Backup saved: ${backupPath}`);

    // Detect PBIs not yet in the draft
    const draftIds = extractDraftPBIIds(draft);
    const newWorkItems = workItems.filter(wi => !draftIds.has(wi.id));

    if (newWorkItems.length > 0) {
      console.log(`\n➕ ${newWorkItems.length} new PBI(s) not yet in draft:`);
      for (const wi of newWorkItems) {
        console.log(`   PBI ${wi.id}: ${wi.fields["System.Title"]}`);
      }
      console.log("\n🤖 Generating sections for new PBIs...");
      const newSections = await generateNewSections(newWorkItems, prContextMap, product, version);
      if (newSections) {
        // Append before the Technical Changes section, or at end if not found
        const insertMarker = "\n## Technical Changes";
        if (draft.includes(insertMarker)) {
          draft = draft.replace(insertMarker, `\n${newSections.trim()}\n${insertMarker}`);
        } else {
          draft = draft.trimEnd() + `\n\n${newSections.trim()}\n`;
        }
        console.log(`   ✅ ${newWorkItems.length} new section(s) added.`);
      }
    } else {
      console.log("   No new PBIs since last generation.");
    }

    // Now fill TBC fields across the whole draft
    const tbcCount = (draft.match(/TBC/g) ?? []).length;
    if (tbcCount === 0 && !draft.includes("[...")) {
      fs.writeFileSync(draftPath, draft, "utf8");
      console.log("\n✅ No TBC fields found — draft looks complete.");
      console.log(`   To publish: node cab-gen.mjs ${productKey} ${version} --publish\n`);
      process.exit(0);
    }

    console.log(`\n   Found ${tbcCount} TBC field(s) to fill.`);
    console.log("🤖 Asking Claude to fill TBC fields...");
    const promptText = formatWorkItemsForPrompt(workItems, prContextMap);
    const enriched = await enrichCabDocument(draft, promptText, product, version);
    if (!enriched) throw new Error("Claude returned an empty response.");

    fs.writeFileSync(draftPath, enriched, "utf8");
    const remaining = (enriched.match(/TBC/g) ?? []).length;
    console.log(`\n✅ Enriched. ${tbcCount - remaining} field(s) filled, ${remaining} still TBC.`);
    console.log(`   To publish: node cab-gen.mjs ${productKey} ${version} --publish\n`);
    return;
  }

  // Generate mode
  console.log(`\n🚀 CAB Generator — ${product.name} ${version}\n`);

  // If a draft already exists, refuse to overwrite — edits are sacred
  // To regenerate: delete the file manually first, then re-run
  if (fs.existsSync(draftPath)) {
    console.log(`\n📄 Draft already exists: ${draftPath}`);
    console.log(`   Edit it, then publish with:`);
    console.log(`   node cab-gen.mjs ${productKey} ${version} --publish`);
    console.log(`\n   To regenerate from scratch, delete the file first:`);
    console.log(`   rm ${draftPath}\n`);
    process.exit(0);
  }

  // 1. Fetch PBIs
  const workItems = await fetchTaggedPBIs(product.tag);
  if (workItems.length === 0) {
    console.log(`Nothing to do. Tag your PBIs with "${product.tag}" and re-run.`);
    process.exit(0);
  }

  // 2. Fetch PR context
  console.log("\n🔗 Fetching linked PR context...");
  const prContextMap = {};
  for (const wi of workItems) {
    console.log(`  PBI ${wi.id}: ${wi.fields["System.Title"]}`);
    prContextMap[wi.id] = await fetchAllPRContextForWorkItem(wi);
    console.log(`   → ${prContextMap[wi.id].length} merged PR(s) found`);
  }

  // 3. Build prompt
  const promptText = formatWorkItemsForPrompt(workItems, prContextMap);

  // 4. Generate
  const cabDocument = await generateCabDocument(promptText, product, version);
  if (!cabDocument) throw new Error("Claude returned an empty document.");

  // 5. Save locally
  fs.writeFileSync(draftPath, cabDocument, "utf8");
  console.log(`\n💾 Draft saved: ${draftPath}`);
  console.log(`   Edit it, then run: node cab-gen.mjs ${productKey} ${version} --publish\n`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
