# PR Reviewer — `pr-reviewer.mjs`

Autonomous GitHub PR reviewer. Fetches all PRs where you're a requested reviewer, triages them (safe vs needs human), runs a full review with the team's coding guidelines injected, and posts the result back to GitHub.

---

## Usage

```bash
node pr-reviewer.mjs            # review all PRs awaiting your review
node pr-reviewer.mjs --dry-run  # fetch + analyse, skip posting to GitHub
```

Config read from `.pr-reviewer` in the same directory.

---

## Review flow

```
For each PR awaiting review:
  1. Check for previous bot review (<!-- ai-reviewer --> marker)
  2a. No prior review  → fetch full PR diff
  2b. Prior review     → fetch only commits since last review (skip if none)
  3. Triage: needs-review (risky) or autonomous (safe)
  4. Full review with guidelines injected
  5. Post to GitHub:
     - needs-review  → COMMENT (human decides approve/reject)
     - autonomous    → APPROVE or REQUEST_CHANGES
```

---

## Triage

**Escalates to human review (`needs-review`) when:**
- Auth, security, or payment code changes
- DB schema or migration changes
- API contract changes (or missing `X-Api-Version` header)
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
