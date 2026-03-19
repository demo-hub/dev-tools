# CAB Generator — `cab-gen.mjs`

Generates Change Advisory Board (CAB) documentation from ADO release work items, and publishes to the SFSCore wiki.

---

## Usage

```bash
node cab-gen.mjs <product>                    # generate CAB doc
node cab-gen.mjs <product> --publish          # generate + publish to ADO wiki
node cab-gen.mjs <product> --enrich           # enrich an existing CAB doc
node cab-gen.mjs <product> --release-notes    # generate release notes
```

---

## Products

| Key | ADO tag | Wiki path |
|-----|---------|-----------|
| `app` | `cab-ready-app` | `/Knowledge Base/App Universo` |
| `usp` | `cab-ready-usp` | `/Knowledge Base/USP` |
| `personalLoan` | `cab-ready-personal-loan` | `/Knowledge Base/Personal Loans` |
| `uniportal` | `cab-ready-uniportal` | `/Knowledge Base/Uniportal` |

---

## Flags

| Flag | What it does |
|------|-------------|
| `--publish` | Publishes the generated doc to the ADO wiki page |
| `--enrich` | Fetches an existing CAB doc and enriches it with additional context |
| `--release-notes` | Generates release notes format (used for App Store / PT-PT comms) |

---

## Config

Read from `.devagent` in the workspace root. Same file as `agent.mjs` and `refine.mjs` — no additional config needed.
