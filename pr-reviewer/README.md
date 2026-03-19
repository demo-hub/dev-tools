# PR Reviewer — `pr-reviewer.mjs`

Autonomous GitHub PR reviewer. Fetches all PRs where you're a requested reviewer, triages them (safe vs needs human), runs a full review with the team's coding guidelines injected, and posts the result back to GitHub.

---

## Usage

```bash
node pr-reviewer.mjs            # review all PRs awaiting your review
node pr-reviewer.mjs --dry-run  # fetch + analyse, skip posting to GitHub
node pr-reviewer.mjs --debug    # print gh commands and raw output
```

Config read from `.pr-reviewer` in the same directory (optional — see [Config](#config)).

---

## Prerequisites

- [GitHub CLI](https://cli.github.com) installed and authenticated (`gh auth login`)
- [Claude Code](https://claude.ai/code) installed and authenticated

---

## Config

`.pr-reviewer` is optional. Create it only if you want to filter by specific repos:

```
REPOS=myorg/backend,myorg/mobile
```

> Add `.pr-reviewer` to `.gitignore` if you store it in a repo.

---

## Review flow

```
For each PR awaiting review:
  1. Check for previous bot review (<!-- ai-reviewer --> marker)
  2a. No prior review  → fetch full PR diff
  2b. Prior review     → fetch only commits since last review (skip if none)
  3. Pre-check: missing AB#id in description → escalate immediately
  4. Triage: needs-review (risky) or autonomous (safe)
  5. Full review with guidelines injected
  6. Post to GitHub:
     - needs-review  → interactive gate (y/n/e/q), then COMMENT
     - autonomous    → APPROVE or REQUEST_CHANGES posted directly
```

---

## Triage

**Escalates to human review (`needs-review`) when:**
- Auth, security, or payment code changes
- DB schema or migration changes
- API contract changes (or missing `X-Api-Version` header)
- Missing `AB#id` link in the PR description
- Open unresolved discussions on the PR
- Large or structurally risky diffs
- Atomic Design hierarchy violations
- `useEffect` used for data fetching

**Handles autonomously when:**
- Docs, comments, formatting
- Config changes or version bumps
- Small test additions
- Trivial bug fixes with no side effects

---

## Interactive gate (flagged PRs)

After displaying the AI's review for a flagged PR, the script pauses:

```
Post this review? [y] post  [n] skip  [e] edit  [q] quit
```

| Key | Action |
|-----|--------|
| `y` | Posts the review to GitHub as-is |
| `n` | Skips this PR, moves to the next |
| `e` | Opens an edit prompt to rewrite the summary, then asks `[y/n]` |
| `q` | Exits the script |

Autonomous PRs (approve / request changes) are posted directly without prompting.

---

## ADO link enforcement

Every PR description must contain `AB#id` (e.g. `AB#1234`) to link it to the Azure Boards work item. If it is missing:

- The PR is immediately escalated to `needs-review` without calling Claude
- The review always includes `[issue] Missing ADO work item link — add AB#id to the PR description`
- The summary is prefixed with `Missing ADO link (AB#id required in description)`

---

## Guideline routing

Guidelines are injected automatically based on the diff:

| Detected | Guidelines used |
|----------|----------------|
| `.ts`, `.tsx`, `.jsx` files | React / RN guidelines |
| `react`, `expo`, `next` in PR title/body | React / RN guidelines |
| Everything else | C# / .NET guidelines |

Full guidelines live in [`../references/`](../references/).

---

## Re-review behaviour

The bot marks every review it posts with `<!-- ai-reviewer -->`. On subsequent runs:
- If **new commits** exist since the last bot review → reviews only the delta
- If **no new commits** → skips the PR entirely

> ⚠️ Never change the `<!-- ai-reviewer -->` marker — it's how re-review detection works across all existing PRs.
