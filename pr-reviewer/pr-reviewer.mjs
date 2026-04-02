#!/usr/bin/env node
/**
 * pr-reviewer.mjs — Autonomous GitHub PR reviewer
 * v3
 *
 * Usage:
 *   node pr-reviewer.mjs              # review all PRs awaiting your review
 *   node pr-reviewer.mjs --dry-run    # fetch + analyse but don't post to GitHub
 *   node pr-reviewer.mjs --debug      # print gh commands and raw output
 *
 * Config: .pr-reviewer in the same directory (optional — gh CLI handles auth)
 *   REPOS=myorg/backend,myorg/mobile   # optional repo filter
 *
 * Requires:
 *   - gh CLI installed and authenticated (gh auth login)
 *   - Claude Code installed and authenticated
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { createInterface } from 'readline';

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

// ── Flags ────────────────────────────────────────────────────────

// ── Interactive gate ────────────────────────────────────────────
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

async function editReview(review) {
  const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
  const tmpFile = join(tmpdir(), `.pr-reviewer-edit-${Date.now()}.txt`);
  writeFileSync(tmpFile, review.summary, 'utf8');
  try {
    execSync(`${editor} "${tmpFile}"`, { stdio: 'inherit' });
    const edited = readFileSync(tmpFile, 'utf8').trim();
    return edited && edited !== review.summary ? { ...review, summary: edited } : review;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}
const DRY_RUN = process.argv.includes('--dry-run');
const DEBUG   = process.argv.includes('--debug') || process.env.PR_REVIEWER_DEBUG === '1';

// ── Config ───────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dir, '.pr-reviewer');

function loadConfig() {
  const cfg = {};
  if (existsSync(CONFIG_PATH)) {
    for (const line of readFileSync(CONFIG_PATH, 'utf8').split('\n')) {
      const clean = line.split('#')[0].trim();
      if (!clean || !clean.includes('=')) continue;
      const [key, ...rest] = clean.split('=');
      cfg[key.trim()] = rest.join('=').trim();
    }
  }
  return cfg;
}

// ── gh CLI helpers ───────────────────────────────────────────────
const BOT_MARKER = '<!-- ai-reviewer -->';

function ghExec(args, opts = {}) {
  const cmd = `gh ${args}`;
  if (DEBUG) console.log(`${D}[debug] ${cmd}${R}`);
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    if (DEBUG && out.trim()) console.log(`${D}[debug] → ${out.trim().slice(0, 200)}${R}`);
    return out.trim();
  } catch (e) {
    const msg = e.stderr || e.message || String(e);
    if (DEBUG) console.log(`${RED}[debug] gh error: ${msg}${R}`);
    throw new Error(msg.trim());
  }
}

function ghJSON(args) {
  const out = ghExec(args);
  try { return JSON.parse(out); }
  catch { throw new Error(`Failed to parse gh output: ${out.slice(0, 200)}`); }
}

// Fetch all PRs where I'm requested as reviewer
function fetchPRs(repos) {
  const repoFlags = repos.length
    ? repos.map(r => `-R ${r}`).join(' ')
    : '';

  if (repos.length) {
    // Search per repo when filter is specified
    const all = [];
    for (const repo of repos) {
      try {
        const prs = ghJSON(
          `pr list -R ${repo} --review-requested @me --state open --json number,title,author,createdAt,url,headRefName,additions,deletions,changedFiles,body --limit 50`
        );
        all.push(...prs.map(pr => ({ ...pr, repo })));
      } catch (e) {
        if (DEBUG) console.log(`${YEL}[debug] skipping ${repo}: ${e.message}${R}`);
      }
    }
    return all;
  }

  // No repo filter — search across all repos the user has access to
  return ghJSON(
    `search prs --review-requested @me --state open --json number,title,author,createdAt,url,repository --limit 50`
  ).map(pr => ({
    ...pr,
    repo: pr.repository?.nameWithOwner || '',
  }));
}

function fetchPRDetail(repo, number) {
  return ghJSON(
    `pr view ${number} -R ${repo} --json number,title,author,createdAt,url,headRefName,headRefOid,additions,deletions,changedFiles,body,reviews`
  );
}

function fetchDiff(repo, number) {
  try {
    return ghExec(`pr diff ${number} -R ${repo}`);
  } catch { return ''; }
}

function fetchCommitRangeDiff(repo, base, head) {
  try {
    return ghExec(`api repos/${repo}/compare/${base}...${head} --header 'Accept: application/vnd.github.v3.diff'`);
  } catch { return ''; }
}

function fetchCommits(repo, number) {
  try {
    return ghJSON(`pr view ${number} -R ${repo} --json commits`).commits || [];
  } catch { return []; }
}

function getLastBotReview(prDetail) {
  const reviews = prDetail.reviews || [];
  const bot = reviews.filter(r => r.body?.includes(BOT_MARKER));
  if (!bot.length) return null;
  return bot.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))[0];
}

function postPRComment(repo, number, body) {
  try {
    ghExec(`pr comment ${number} -R ${repo} --body ${JSON.stringify(body)}`);
    return true;
  } catch { return false; }
}

function postReview(repo, number, headSha, review) {
  const body = `${BOT_MARKER}\n${review.summary}`;
  const comments = (review.inline_comments || [])
    .filter(c => c.path && c.line && c.body)
    .map(c => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body }));

  const payload = JSON.stringify({
    commit_id: headSha,
    body,
    event: review.action,
    comments,
  });

  try {
    ghExec(
      `api repos/${repo}/pulls/${number}/reviews \
        --method POST \
        --header 'Accept: application/vnd.github.comfort-fade-preview+json' \
        --input -`,
      { input: payload }
    );
    return true;
  } catch { return false; }
}

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
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function triage(pr, diff) {
  const prompt = `Triage this PR. Risky enough for human review?
Title: ${pr.title} | Files: ${pr.changedFiles} +${pr.additions} -${pr.deletions}
Body: ${(pr.body || '').slice(0, 300)}
Diff: ${diff.slice(0, 1200)}

Reply ONLY with valid JSON, no markdown, no backticks:
{"verdict":"needs-review" or "autonomous"}

needs-review: auth/security/payments, DB schema, API changes, missing versioning headers, large/risky diffs, Atomic Design violations, useEffect data fetching misuse, missing AB#{{id}} ADO link in PR description.
autonomous: docs, formatting, config, version bumps, trivial fixes.`;

  try {
    return parseJSON(callClaude(prompt))?.verdict || 'autonomous';
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
React Native + Expo + Next.js + .NET 8 + Azure. Git Flow.
Products: App Universo, USP, Personal Loans, Uniportal.
X-Api-Version header required on all public endpoints. [Deprecated] attribute on deprecated endpoints.
TDD on backend. Backward-compatible contracts. Feature toggles for risky changes. Additive migrations only.

=== PR REVIEW GUIDELINES ===
PR size < 400 lines. One purpose per PR.
Checklist: Design & Correctness · Tests · Code Quality · Safety & Impact.
Comment prefixes: [issue] must fix · [suggestion] non-blocking · [nit] optional · [question] context needed.
ADO link rule: Every PR description MUST contain AB#{id} (e.g. AB#1234) to link to the Azure Boards work item. If it is missing, always raise [issue] Missing ADO work item link — add AB#{{id}} to the PR description to link it to the Azure Boards ticket.

${isRN ? `=== REACT / REACT NATIVE GUIDELINES ===\n${rnGuide}` : `=== C# CODING GUIDELINES ===\n${csharpGuide}`}

=== TESTING GUIDELINES ===
TDD: Red→Green→Refactor. Test behavior not implementation.
Stack: xUnit/NUnit, Moq, SonarQube. Naming: Should_X_When_Y() or GivenX_WhenY_ThenZ().
No real DB/network/IO in unit tests. Single logical assertion. No sleeps/randoms.
Frontend (React Native / Next.js) has no automated tests.

=== PR UNDER REVIEW ===
Title: ${pr.title}
Repo: ${pr.repo}
Author: ${pr.author?.login || pr.author?.name || 'unknown'}
Files changed: ${pr.changedFiles}, +${pr.additions} -${pr.deletions}
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
When you can propose a concrete fix, include a GitHub suggestion block immediately after the prefix line so the author can apply it with one click:

[issue] Brief explanation of the problem.
\`\`\`suggestion
corrected code here (exact replacement for the flagged line(s))
\`\`\`

Use suggestion blocks for: wrong type, missing null guard, incorrect async pattern, style violations with a clear fix. Skip them when the fix requires understanding broader context or multiple files.

Respond ONLY with valid JSON, no markdown, no backticks:
{"verdict":"${isFlagged ? 'needs-review' : 'autonomous'}","action":"${isFlagged ? 'COMMENT' : 'APPROVE or REQUEST_CHANGES'}","summary":"2-3 sentences focused on what the code does and why it matters. Do not mention diff size, truncation, or token limits.","inline_comments":[{"path":"file","line":42,"body":"[issue] ..."}],"tags":[]}

inline_comments rules:
- Only for issues tied to a SPECIFIC line of code in a specific file.
- NEVER use inline_comments for PR-level concerns (missing description, PR size, missing ADO link, missing tests in general, broad architectural feedback). Those belong in the summary.
- Max 6. Return [] if no genuine line-level issues exist.
tags: up to 3 from: risk, bug, security, missing-tests, style, trivial
line: integer line number in new file.`;
}

// ── Output ───────────────────────────────────────────────────────
function ageText(d) {
  const h = Math.round((Date.now() - new Date(d)) / 36e5);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function printPR(pr, review, isReReview, deltaInfo) {
  const isFlagged = pr._triage_verdict === 'needs-review';
  const statusIcon = isFlagged ? `${RED}⚑ NEEDS YOUR CALL${R}` :
    review.action === 'APPROVE' ? `${GRN}✓ AUTO-APPROVED${R}` :
    `${YEL}↩ CHANGES REQUESTED${R}`;

  console.log();
  console.log(`  ${B}${CYAN}#${pr.number}${R} ${B}${pr.title}${R}`);
  console.log(`  ${D}${pr.repo} · by ${pr.author?.login || 'unknown'} · ${ageText(pr.createdAt)} · +${pr.additions || 0} -${pr.deletions || 0}${isReReview ? ' · re-review' : ''}${deltaInfo ? ' · ' + deltaInfo : ''}${R}`);
  console.log(`  ${statusIcon}`);
  console.log(`  ${review.summary}`);

  if (review.inline_comments?.length) {
    console.log();
    for (const c of review.inline_comments.slice(0, 6)) {
      const col = c.body.startsWith('[issue]') ? RED :
        c.body.startsWith('[suggestion]') ? BLU :
        c.body.startsWith('[nit]') ? D : YEL;
      if (c.path) console.log(`  ${col}${c.path}${c.line ? ':' + c.line : ''}${R}`);
      console.log(`  ${D}${c.body}${R}`);
    }
  }

  if (review.tags?.length) console.log(`  ${D}tags: ${review.tags.join(', ')}${R}`);

  if (DRY_RUN) console.log(`  ${D}(dry run — not posted)${R}`);
  else if (review.posted) console.log(`  ${D}↑ posted to GitHub${R}`);
  else if (review.posted === false) console.log(`  ${YEL}⚠ Could not post to GitHub${R}`);

  console.log(`  ${D}${pr.url}${R}`);
}

function printSkipped(pr, lastReviewAge) {
  console.log(`  ${D}#${pr.number} ${pr.title} · ${pr.repo} · no new commits since ${lastReviewAge}${R}`);
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  const repos = cfg.REPOS ? cfg.REPOS.split(',').map(r => r.trim()).filter(Boolean) : [];

  console.log();
  console.log(`${B}PR Reviewer${R}${DRY_RUN ? ` ${YEL}[dry run]${R}` : ''}`);
  hr();

  // Check dependencies
  for (const [cmd, label] of [['gh --version', 'GitHub CLI'], ['claude --version', 'Claude Code']]) {
    try { execSync(cmd, { stdio: 'pipe' }); }
    catch {
      console.error(`${RED}✗ ${label} not found. Install and authenticate first.${R}`);
      process.exit(1);
    }
  }

  log('🔍', 'FETCH', `Fetching PRs awaiting your review${repos.length ? ` in ${repos.join(', ')}` : ''}…`);

  let prs;
  try {
    prs = fetchPRs(repos);
  } catch (e) {
    console.error(`${RED}✗ Failed to fetch PRs: ${e.message}${R}`);
    console.error(`Make sure you're authenticated: gh auth login`);
    process.exit(1);
  }

  if (DEBUG) console.log(`${D}[debug] found ${prs.length} PR(s)${R}`);

  if (!prs.length) {
    log('✓', 'DONE', 'No PRs awaiting your review — queue is clear.');
    console.log();
    return;
  }

  log('📋', 'QUEUE', `Found ${prs.length} PR${prs.length > 1 ? 's' : ''} awaiting review`);
  hr();

  const counts = { flagged: 0, approved: 0, changes: 0, skipped: 0 };
  const skippedPRs = [];

  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i];

    process.stdout.write(`${D}[${i + 1}/${prs.length}] Fetching detail: ${pr.title.slice(0, 45)}…${R}\r`);

    // Fetch full PR detail (includes reviews for re-review detection)
    let detail = pr;
    try {
      detail = { ...pr, ...fetchPRDetail(pr.repo, pr.number) };
    } catch {}

    const headSha = detail.headRefOid || '';

    // Re-review detection
    const lastBotReview = getLastBotReview(detail);
    let diff = '', isReReview = false, deltaInfo = '', newCommitCount = 0;

    if (lastBotReview) {
      const since = new Date(lastBotReview.submittedAt);
      const commits = await fetchCommits(pr.repo, pr.number);
      const newCommits = commits.filter(c => new Date(c.committedDate || c.authoredDate) > since);
      newCommitCount = newCommits.length;

      if (newCommitCount === 0) {
        counts.skipped++;
        skippedPRs.push({ pr: detail, lastReviewAge: ageText(lastBotReview.submittedAt) });
        continue;
      }

      isReReview = true;
      const allShas = commits.map(c => c.oid);
      const firstNewSha = newCommits[newCommits.length - 1].oid;
      const firstNewIdx = allShas.indexOf(firstNewSha);
      const baseSha = firstNewIdx > 0 ? allShas[firstNewIdx - 1] : allShas[0];
      diff = await fetchCommitRangeDiff(pr.repo, baseSha, headSha);
      deltaInfo = `${newCommitCount} new commit${newCommitCount > 1 ? 's' : ''} since ${ageText(lastBotReview.submittedAt)}`;
    } else {
      process.stdout.write(`${D}[${i + 1}/${prs.length}] Fetching diff: ${pr.title.slice(0, 47)}…${R}\r`);
      diff = await fetchDiff(pr.repo, pr.number);
    }

    // Pre-check: ADO link
    const hasADOLink = /AB#\d+/i.test(detail.body || '');
    if (!hasADOLink) {
      detail._triage_verdict = 'needs-review';
      detail._missing_ado_link = true;
    }

    // Triage
    if (!detail._missing_ado_link) {
      process.stdout.write(`${D}[${i + 1}/${prs.length}] Triaging: ${pr.title.slice(0, 50)}…${R}\r`);
      detail._triage_verdict = triage(detail, diff);
    }

    // Review
    process.stdout.write(`${D}[${i + 1}/${prs.length}] Reviewing: ${pr.title.slice(0, 48)}…${R}\r`);
    const prompt = buildReviewPrompt(detail, diff, detail._triage_verdict === 'needs-review', isReReview, newCommitCount);

    let review = { action: 'COMMENT', summary: 'Could not parse review.', inline_comments: [], tags: [] };
    try {
      review = parseJSON(callClaude(prompt)) || review;
    } catch (e) {
      review.summary = `Review failed: ${e.message}`;
    }

    // Strip PR-level concerns Claude incorrectly placed as inline comments
    const PR_LEVEL_PATTERNS = [
      /missing.*ADO.*link/i,
      /AB#.*description/i,
      /no pr description/i,
      /missing.*description/i,
      /PR.*lines.*limit/i,
      /400.line/i,
      /split.*PR/i,
      /PR.*too large/i,
    ];
    if (review.inline_comments?.length) {
      const stripped = [];
      for (const c of review.inline_comments) {
        if (PR_LEVEL_PATTERNS.some(p => p.test(c.body))) {
          // Absorb into summary only if not already covered
          if (!review.summary.includes(c.body.slice(0, 40))) {
            review._extra_summary = (review._extra_summary || '') + ' ' + c.body;
          }
        } else {
          stripped.push(c);
        }
      }
      review.inline_comments = stripped;
    }

    // Guarantee ADO link comment is present when link is missing
    if (detail._missing_ado_link) {
      detail._ado_comment = '[issue] Missing ADO work item link — add AB#id to the PR description to link it to the Azure Boards ticket.';
    }

    process.stdout.write(' '.repeat(70) + '\r');
    printPR(detail, review, isReReview, deltaInfo);

    if (detail._triage_verdict === 'needs-review') {
      counts.flagged++;
      if (!DRY_RUN && headSha) {
        // Interactive gate for flagged PRs
        let answer = '';
        while (!['y', 'n', 'e', 'q'].includes(answer)) {
          answer = await ask(`\n  ${YEL}Post this review? [y] post  [n] skip  [e] edit  [q] quit${R}  `);
        }
        if (answer === 'q') {
          console.log(`\n${D}Aborted.${R}\n`);
          process.exit(0);
        }
        if (answer === 'e') {
          review = await editReview(review);
          console.log(`\n  ${D}Updated summary: ${review.summary}${R}`);
          answer = await ask(`  ${YEL}Post edited review? [y] post  [n] skip${R}  `);
        }
        if (answer === 'y') {
          review.posted = postReview(pr.repo, pr.number, headSha, review);
          console.log(review.posted
            ? `  ${D}↑ posted to GitHub${R}`
            : `  ${YEL}⚠ Could not post to GitHub${R}`);
          if (review.posted && detail._ado_comment) postPRComment(pr.repo, pr.number, detail._ado_comment);
        } else {
          console.log(`  ${D}skipped${R}`);
        }
      }
    } else if (review.action === 'APPROVE') {
      counts.approved++;
      // Auto-post for autonomous PRs
      if (!DRY_RUN && headSha) {
        review.posted = postReview(pr.repo, pr.number, headSha, review);
        if (!review.posted) console.log(`  ${YEL}⚠ Could not post to GitHub${R}`);
      }
    } else {
      counts.changes++;
      // Auto-post for autonomous PRs
      if (!DRY_RUN && headSha) {
        review.posted = postReview(pr.repo, pr.number, headSha, review);
        if (!review.posted) console.log(`  ${YEL}⚠ Could not post to GitHub${R}`);
      }
    }
  }

  // Skipped
  if (skippedPRs.length) {
    hr();
    console.log(`${D}NO NEW COMMITS SINCE LAST REVIEW${R}`);
    for (const { pr, lastReviewAge } of skippedPRs) printSkipped(pr, lastReviewAge);
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
