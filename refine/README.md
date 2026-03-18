# Refinement Agent — `refine.mjs`

Pre-sprint refinement automation. Fetches ADO PBIs tagged `refine-ready-<product>`, runs automated Definition of Ready (DoR) checks, and produces a detailed development plan via a two-pass Claude analysis with actual source code context.

---

## Usage

```bash
node refine.mjs app             # analyse all PBIs tagged refine-ready-app
node refine.mjs app 5678        # analyse a single PBI by ID (no tag needed)
node refine.mjs --list          # list configured products
```

Config read from `.devagent` in the workspace root (or up to 5 parent directories).

---

## Products

| Key | ADO tag | Name |
|-----|---------|------|
| `app` | `refine-ready-app` | App Universo |
| `usp` | `refine-ready-usp` | USP |
| `personalLoan` | `refine-ready-personal-loan` | Personal Loans |
| `uniportal` | `refine-ready-uniportal` | Uniportal |

---

## Flow

```
1. Find .code-workspace → build file tree per repo
2. Fetch tagged PBIs from ADO
3. Per PBI:
   a. Run automated DoR field checks
   b. If DoR PASSES → two-pass Claude analysis:
        Pass 1: Claude picks relevant files from the workspace tree
        Pass 2: Claude generates full development plan with those files
   c. If DoR FAILS → gap-only analysis → show comment → ask y/N → post to ADO
4. Save report: refine-<product>-YYYY-MM-DD.md
```

---

## DoR check outcomes

| Symbol | Meaning |
|--------|---------|
| ✅ | Auto-confirmed from ADO fields |
| ⚠️ | Manual verification required — does not block dev plan |
| ❌ | Hard failure — blocks dev plan, triggers ADO comment flow |

---

## Output report

Saved as `refine-<product>-YYYY-MM-DD.md`. Each PBI section contains:

1. Header with DoR badge (`🟢` ready / `🔴` not ready)
2. Auto-check compliance table
3. Claude's full analysis (DoR assessment, gaps, AC suggestions, dev plan, tasks)

---

## Definition of Ready

See [`../references/dor.md`](../references/dor.md) for the full checklist and which checks are automated vs manual.
