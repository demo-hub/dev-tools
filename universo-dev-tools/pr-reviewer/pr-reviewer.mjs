#!/usr/bin/env node
/**
 * pr-reviewer.mjs — Autonomous GitHub PR reviewer
 * IT Channels / SFS-IT · v2
 *
 * Usage:
 *   node pr-reviewer.mjs              # review all PRs awaiting your review
 *   node pr-reviewer.mjs --dry-run    # fetch + analyse but don't post to GitHub
 *
 * Config: .pr-reviewer in the same directory
 *   GH_TOKEN=ghp_xxxxxxxxxxxx
 *   GH_USER=your-github-username
 *   REPOS=myorg/backend,myorg/mobile   # optional filter
 *
 * Requires Claude Code to be installed and authenticated (uses your existing session).
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

// ── ANSI ────────────────────────────────────────────────────────
const R    = '\x1b[0m';
const B    = '\x1b[1m';
const D    = '\x1b[2m';
const CYAN = '\x1b[36m';
const YEL  = '\x1b[33m';
const GRN  = '\x1b[32m';
const RED  = '\x1b[31m';
const BLU  = '\x1b[34m';

const log = (icon, stage, msg) =>
  console.log(`${D}${icon}${R} ${B}${stage}${R}  ${msg}`);

const hr = () => console.log(`${D}${'─'.repeat(60)}${R}`);

// ── Config ───────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dir, '.pr-reviewer');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`${RED}✗ Config not found: ${CONFIG_PATH}${R}`);
    console.error(`Create .pr-reviewer with:\n  GH_TOKEN=...\n  GH_USER=...\n  REPOS=org/repo1,org/repo2  # optional`);
    process.exit(1);
  }
  const cfg = {};
  for (const line of readFileSync(CONFIG_PATH, 'utf8').split('\n')) {
    const clean = line.split('#')[0].trim();
    if (!clean || !clean.includes('=')) continue;
    const [key, ...rest] = clean.split('=');
    cfg[key.trim()] = rest.join('=').trim();
  }
  for (const k of ['GH_TOKEN', 'GH_USER']) {
    if (!cfg[k]) { console.error(`${RED}✗ Missing ${k} in .pr-reviewer${R}`); process.exit(1); }
  }
  return cfg;
}

// ── Flags ────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');

// ── Claude via Claude Code ────────────────────────────────────────
const PROMPT_FILE = join(tmpdir(), '.pr-reviewer-prompt.md');

function callClaude(prompt) {
  writeFileSync(PROMPT_FILE, prompt, 'utf8');
  try {
    const out = execSync(`cat "${PROMPT_FILE}" | claude --dangerously-skip-permissions -p`, {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim();
  } finally {
    try { unlinkSync(PROMPT_FILE); } catch {}
  }
}

function parseJSON(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  // Find the first { ... } block in the output
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function triage(pr, diff) {
  const prompt = `Triage this PR. Risky enough for human review?
Title: ${pr.title} | Files: ${pr.changed_files} +${pr.additions} -${pr.deletions}
Body: ${(pr.body || '').slice(0, 300)}
Diff: ${diff.slice(0, 1200)}

Reply ONLY with valid JSON, no markdown, no backticks:
{"verdict":"needs-review" or "autonomous"}

needs-review: auth/security/payments, DB schema, API changes, missing versioning headers, large/risky diffs, Atomic Design violations, useEffect data fetching misuse.
autonomous: docs, formatting, config, version bumps, trivial fixes.`;

  try {
    const out = callClaude(prompt);
    return parseJSON(out)?.verdict || 'autonomous';
  } catch { return 'autonomous'; }
}

function buildReviewPrompt(pr, diff, isFlagged, isReReview, newCommitCount) {
  const isRN = /\.(tsx?|jsx?)/.test(diff) || /react|expo|next/i.test(pr.title + (pr.body || ''));
  const reReviewNote = isReReview
    ? `IMPORTANT: Re-review. Diff contains only ${newCommitCount} new commit(s) since last review. Focus on what changed — do not re-raise previously flagged issues unless still present.`
    : 'First-time review. Review the full diff.';

  const csharpGuide = `Code Style: System usings first. No var (except obvious initializers). Allman braces always. File-scoped namespaces. Namespace matches folder.
Language: ?? and ?. for nulls. No ==true/==false. Collection initializers. Collection expressions []. Compound assignments. String interpolation. Pattern matching. Records for DTOs. Primary constructors (C#12). required members.
Async: await always — no .Result/.Wait(). CancellationToken on all I/O. No ConfigureAwait(false) in app code. Async suffix required.
NRTs: correct ? annotations. No ! suppression without comment. No #nullable disable.
Performance: .Count/.Length over .Count(). AsSpan/AsMemory in hot paths only.`;

  const rnGuide = `TypeScript: strict:true — no any, no @ts-ignore. type not interface for props. Annotate return types. Union types over enum.
Atomic Design: Atom (no data/logic) → Molecule (generic) → Organism (may call useQuery) → Template (layout) → Screen (prefetch + mutations). Atoms/molecules never fetch.
Components: one per file PascalCase. Destructure props. No inline component defs. No useMemo/useCallback/memo without profiling.
Effects: useEffect for external systems only. Derived state inline. Events in handlers not effects. No exhaustive-deps suppression.
State: TanStack Query for all remote data. Organisms call useQuery — cache deduplicates. Screens own prefetching + mutations. Context for auth/theme/locale/flags only.
Styling: design system tokens — no hardcoded hex/px. Gluestack over raw RN. No inline style for token values. Gluestack breakpoints for responsive.
Expo: Expo SDK preferred. SSR-safe shared layers.`;

  return `You are an autonomous code reviewer. Apply the team's exact guidelines.

=== STACK & TEAM CONTEXT ===
React Native + Expo + Next.js + .NET 8 + Azure. Git Flow. ADO org: SFS-IT, project: SFSCore, team: IT Channels.
Products: App Universo, USP, Personal Loans, Uniportal.
X-Api-Version header required on all public endpoints. [Deprecated] attribute on deprecated endpoints.
TDD on backend. Backward-compatible contracts. Feature toggles for risky changes. Additive migrations only.

=== PR REVIEW GUIDELINES ===
PR size < 400 lines. One purpose per PR.
Checklist: Design & Correctness · Tests · Code Quality · Safety & Impact.
Comment prefixes: [issue] must fix · [suggestion] non-blocking · [nit] optional · [question] context needed.

${isRN ? `=== REACT / REACT NATIVE GUIDELINES ===\n${rnGuide}` : `=== C# CODING GUIDELINES ===\n${csharpGuide}`}

=== TESTING GUIDELINES ===
TDD: Red→Green→Refactor. Test behavior not implementation.
Stack: xUnit/NUnit, Moq, SonarQube. Naming: Should_X_When_Y() or GivenX_WhenY_ThenZ().
No real DB/network/IO in unit tests. Single logical assertion. No sleeps/randoms.
Frontend (React Native / Next.js) has no automated tests.

=== PR UNDER REVIEW ===
Title: ${pr.title}
Repo: ${repoFrom(pr.url || pr.html_url)}
Author: ${pr.user?.login}
Files changed: ${pr.changed_files}, +${pr.additions} -${pr.deletions}
Description: ${(pr.body || '(none)').slice(0, 600)}

${reReviewNote}

Diff (up to 4000 chars):
${diff.slice(0, 4000)}

=== INSTRUCTIONS ===
${isFlagged
  ? 'Risky PR. Thorough review. action="COMMENT" — human decides on approval.'
  : 'Low-risk. APPROVE if good, REQUEST_CHANGES if real issues.'}
${isReReview ? 'Start summary with "Re-review:".' : ''}
Prefix inline comments: [issue], [suggestion], [nit], or [question].

Respond ONLY with valid JSON, no markdown, no backticks:
{"verdict":"${isFlagged ? 'needs-review' : 'autonomous'}","action":"${isFlagged ? 'COMMENT' : 'APPROVE or REQUEST_CHANGES'}","summary":"2-3 sentences.","inline_comments":[{"path":"file","line":42,"body":"[issue] ..."}],"tags":[]}

inline_comments: real issues only, max 6, [] if none.
tags: up to 3 from: risk, bug, security, missing-tests, style, trivial
line: integer line number in new file.`;
}

// ── GitHub helpers ───────────────────────────────────────────────
const BOT_MARKER = '<!-- ai-reviewer -->';

async function gh(token, path, opts = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: opts.diff ? 'application/vnd.github.v3.diff' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (opts.diff) return res.ok ? res.text() : '';
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub ${res.status}`);
  return data;
}

function repoFrom(url = '') {
  const m = url.match(/repos\/(.+?\/.+?)\/(?:issues|pulls)/);
  return m ? m[1] : '';
}

function ageText(d) {
  const h = Math.round((Date.now() - new Date(d)) / 36e5);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function getLastBotReview(token, repo, prNumber) {
  try {
    const reviews = await gh(token, `/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
    const bot = reviews.filter(r => r.body?.includes(BOT_MARKER));
    if (!bot.length) return null;
    return bot.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))[0];
  } catch { return null; }
}

async function getNewCommits(token, repo, prNumber, since) {
  try {
    const commits = await gh(token, `/repos/${repo}/pulls/${prNumber}/commits?per_page=100`);
    return commits.filter(c => new Date(c.commit.committer.date) > new Date(since));
  } catch { return []; }
}

async function getCommitRangeDiff(token, repo, base, head) {
  return gh(token, `/repos/${repo}/compare/${base}...${head}`, { diff: true });
}

async function postReview(token, repo, prNumber, commitId, review) {
  const body = `${BOT_MARKER}\n${review.summary}`;
  const comments = (review.inline_comments || [])
    .filter(c => c.path && c.line && c.body)
    .map(c => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body }));
  try {
    await gh(token, `/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github.comfort-fade-preview+json' },
      body: { commit_id: commitId, body, event: review.action, comments },
    });
    return true;
  } catch { return false; }
}

// ── Output ───────────────────────────────────────────────────────
function printPR(pr, review, isReReview, deltaInfo) {
  const repo = repoFrom(pr.url || pr.html_url);
  const isFlagged = pr._triage_verdict === 'needs-review';

  const statusIcon = isFlagged ? `${RED}⚑ NEEDS YOUR CALL${R}` :
    review.action === 'APPROVE' ? `${GRN}✓ AUTO-APPROVED${R}` :
    `${YEL}↩ CHANGES REQUESTED${R}`;

  console.log();
  console.log(`  ${B}${CYAN}#${pr.number}${R} ${B}${pr.title}${R}`);
  console.log(`  ${D}${repo} · by ${pr.user.login} · ${ageText(pr.created_at)} · +${pr.additions || 0} -${pr.deletions || 0}${isReReview ? ' · re-review' : ''}${deltaInfo ? ' · ' + deltaInfo : ''}${R}`);
  console.log(`  ${statusIcon}`);
  console.log(`  ${review.summary}`);

  if (review.inline_comments?.length) {
    console.log();
    for (const c of review.inline_comments.slice(0, 6)) {
      const col = c.body.startsWith('[issue]') ? RED :
        c.body.startsWith('[suggestion]') ? BLU :
        c.body.startsWith('[nit]') ? D : YEL;
      console.log(`  ${col}${c.path}${c.line ? ':' + c.line : ''}${R}`);
      console.log(`  ${D}${c.body}${R}`);
    }
  }

  if (review.tags?.length) console.log(`  ${D}tags: ${review.tags.join(', ')}${R}`);

  if (DRY_RUN) console.log(`  ${D}(dry run — not posted)${R}`);
  else if (review.posted) console.log(`  ${D}↑ posted to GitHub${R}`);
  else if (review.posted === false) console.log(`  ${YEL}⚠ Could not post to GitHub${R}`);

  console.log(`  ${D}${pr.html_url}${R}`);
}

function printSkipped(pr, lastReviewAge) {
  const repo = repoFrom(pr.url || pr.html_url);
  console.log(`  ${D}#${pr.number} ${pr.title} · ${repo} · no new commits since ${lastReviewAge}${R}`);
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  const { GH_TOKEN: token, GH_USER: user } = cfg;
  const repos = cfg.REPOS ? cfg.REPOS.split(',').map(r => r.trim()).filter(Boolean) : [];

  console.log();
  console.log(`${B}PR Reviewer${R} ${D}IT Channels · SFS-IT${R}${DRY_RUN ? ` ${YEL}[dry run]${R}` : ''}`);
  hr();

  // Check claude is available
  try {
    execSync('claude --version', { stdio: 'pipe' });
  } catch {
    console.error(`${RED}✗ Claude Code not found. Install it and authenticate first.${R}`);
    process.exit(1);
  }

  log('🔍', 'FETCH', `Searching PRs review-requested:${user}${repos.length ? ` in ${repos.join(', ')}` : ''}…`);

  const repoQ = repos.length ? ' ' + repos.map(r => `repo:${r}`).join(' ') : '';
  const q = encodeURIComponent(`is:pr is:open review-requested:${user}${repoQ}`);
  const searchData = await gh(token, `/search/issues?q=${q}&per_page=30&sort=created&order=asc`);
  const items = searchData.items || [];

  if (!items.length) {
    log('✓', 'DONE', 'No PRs awaiting your review — queue is clear.');
    console.log();
    return;
  }

  log('📋', 'QUEUE', `Found ${items.length} PR${items.length > 1 ? 's' : ''} awaiting review`);
  hr();

  const counts = { flagged: 0, approved: 0, changes: 0, skipped: 0 };
  const skippedPRs = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const repo = repoFrom(item.url);

    process.stdout.write(`${D}[${i + 1}/${items.length}] Fetching: ${item.title.slice(0, 50)}…${R}\r`);

    let prDetail = {}, commitId = '';
    try {
      prDetail = await gh(token, `/repos/${repo}/pulls/${item.number}`);
      commitId = prDetail.head?.sha || '';
    } catch {}

    const pr = { ...item, ...prDetail };

    // Re-review detection
    const lastBotReview = await getLastBotReview(token, repo, item.number);
    let diff = '', isReReview = false, deltaInfo = '', newCommitCount = 0;

    if (lastBotReview) {
      const newCommits = await getNewCommits(token, repo, item.number, lastBotReview.submitted_at);
      newCommitCount = newCommits.length;

      if (newCommitCount === 0) {
        counts.skipped++;
        skippedPRs.push({ pr, lastReviewAge: ageText(lastBotReview.submitted_at) });
        continue;
      }

      isReReview = true;
      const allCommits = await gh(token, `/repos/${repo}/pulls/${item.number}/commits?per_page=100`);
      const allShas = allCommits.map(c => c.sha);
      const firstNewSha = newCommits[newCommits.length - 1].sha;
      const firstNewIdx = allShas.indexOf(firstNewSha);
      const baseSha = firstNewIdx > 0 ? allShas[firstNewIdx - 1] : allCommits[0].sha;
      diff = await getCommitRangeDiff(token, repo, baseSha, commitId);
      deltaInfo = `${newCommitCount} new commit${newCommitCount > 1 ? 's' : ''} since ${ageText(lastBotReview.submitted_at)}`;
    } else {
      diff = await gh(token, `/repos/${repo}/pulls/${item.number}`, { diff: true });
    }

    // Triage
    process.stdout.write(`${D}[${i + 1}/${items.length}] Triaging: ${item.title.slice(0, 48)}…${R}\r`);
    pr._triage_verdict = triage(pr, diff);

    // Review
    process.stdout.write(`${D}[${i + 1}/${items.length}] Reviewing: ${item.title.slice(0, 46)}…${R}\r`);
    const prompt = buildReviewPrompt(pr, diff, pr._triage_verdict === 'needs-review', isReReview, newCommitCount);

    let review = { action: 'COMMENT', summary: 'Could not parse review.', inline_comments: [], tags: [] };
    try {
      const raw = callClaude(prompt);
      review = parseJSON(raw) || review;
    } catch (e) {
      review.summary = `Review failed: ${e.message}`;
    }

    // Post
    if (!DRY_RUN && commitId) {
      review.posted = await postReview(token, repo, item.number, commitId, review);
    }

    process.stdout.write(' '.repeat(70) + '\r');
    printPR(pr, review, isReReview, deltaInfo);

    if (pr._triage_verdict === 'needs-review') counts.flagged++;
    else if (review.action === 'APPROVE') counts.approved++;
    else counts.changes++;
  }

  // Skipped
  if (skippedPRs.length) {
    hr();
    console.log(`${D}NO NEW COMMITS SINCE LAST REVIEW${R}`);
    for (const { pr, lastReviewAge } of skippedPRs) {
      printSkipped(pr, lastReviewAge);
    }
  }

  // Summary
  hr();
  const parts = [];
  if (counts.flagged)  parts.push(`${RED}${B}${counts.flagged} need your call${R}`);
  if (counts.changes)  parts.push(`${YEL}${counts.changes} changes requested${R}`);
  if (counts.approved) parts.push(`${GRN}${counts.approved} auto-approved${R}`);
  if (counts.skipped)  parts.push(`${D}${counts.skipped} skipped (no new commits)${R}`);
  console.log(`${B}Done.${R}  ${parts.join('  ·  ')}`);
  console.log();
}

main().catch(e => {
  console.error(`\n${RED}✗ ${e.message}${R}`);
  process.exit(1);
});
