# dev-tools

AI-powered developer automation scripts for Azure DevOps + GitHub teams.

All tools are Node.js 18+ ESM scripts with **zero npm dependencies**. They rely on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) for AI inference — no `ANTHROPIC_API_KEY` needed in most cases.

---

## Tools

| Folder | Script | What it does |
|--------|--------|--------------|
| [`agent/`](./agent/) | `agent.mjs` | Autonomous sprint developer — picks an ADO work item and implements it end-to-end via Claude Code |
| [`refine/`](./refine/) | `refine.mjs` | Pre-refinement PBI analyser — runs DoR checks and generates a development plan |
| [`cab-gen/`](./cab-gen/) | `cab-gen.mjs` | CAB document generator — produces Change Advisory Board docs from ADO release items |
| [`pr-reviewer/`](./pr-reviewer/) | `pr-reviewer.mjs` | Autonomous PR reviewer — reviews GitHub PRs via Claude Code and posts the result |

Reference guidelines used by the tools live in [`references/`](./references/).

---

## Prerequisites

- **Node.js 18+** (ESM, no transpilation needed)
- **Claude Code** installed and authenticated

```bash
# Verify both are available
node --version      # v18+
claude --version    # any version
```

---

## Quick start

```bash
# 1. Clone
git clone git@github.com:YOUR_GITHUB_ORG/dev-tools.git
cd dev-tools

# 2. Run the setup script
chmod +x setup.sh && ./setup.sh

# 3. Fill in your credentials (see Config section below)
cp .devagent.example .devagent
cp .pr-reviewer.example .pr-reviewer
# Edit both files with your PAT / token
```

---

## Config files

### `.devagent` — shared by `agent.mjs` and `refine.mjs`

```ini
ADO_ORG=YOUR_ADO_ORG
ADO_PROJECT=YOUR_ADO_PROJECT
ADO_TEAM=YOUR_TEAM_NAME
ADO_PAT=<your-ado-personal-access-token>
ADO_STACK=.NET 8, React Native, Azure
ADO_BASE_BRANCH=main
ADO_MAX_RETRY=2
```

Scopes required for `ADO_PAT`: **Work Items (Read & Write)**, **Code (Read)**.

### `.pr-reviewer` — used by `pr-reviewer.mjs`

```ini
GH_TOKEN=<your-github-personal-access-token>
GH_USER=<your-github-username>
REPOS=YOUR_GITHUB_ORG/your-backend-repo,YOUR_GITHUB_ORG/your-mobile-repo   # optional filter
```

Scope required for `GH_TOKEN`: **repo** (full).

> ⚠️ Both config files are `.gitignore`d — never commit them.

---

## Tool usage

### DevAgent

```bash
cd agent
node agent.mjs                  # interactive sprint picker
node agent.mjs --id 1234        # jump to a specific work item
node agent.mjs --dry-run        # full flow, skip push + PR
DEVAGENT_DEBUG=1 node agent.mjs # verbose ADO API logging
```

### Refinement Agent

```bash
cd refine
node refine.mjs app             # analyse all refine-ready-app PBIs
node refine.mjs app 5678        # analyse a single PBI (no tag needed)
node refine.mjs --list          # list configured products
```

### CAB Generator

```bash
cd cab-gen
node cab-gen.mjs app            # generate CAB doc for App Universo
node cab-gen.mjs usp --publish  # generate + publish to ADO wiki
node cab-gen.mjs app --enrich   # enrich existing CAB doc
node cab-gen.mjs app --release-notes  # generate release notes
```

### PR Reviewer

```bash
cd pr-reviewer
node pr-reviewer.mjs            # review all PRs awaiting your review
node pr-reviewer.mjs --dry-run  # fetch + analyse, skip posting to GitHub
```

---

## Repo structure

```
dev-tools/
├── agent/
│   ├── agent.mjs
│   └── README.md
├── refine/
│   ├── refine.mjs
│   └── README.md
├── cab-gen/
│   ├── cab-gen.mjs
│   └── README.md
├── pr-reviewer/
│   ├── pr-reviewer.mjs
│   └── README.md
├── references/
│   ├── csharp-guidelines.md    # C# / .NET 8 coding standards
│   ├── react-guidelines.md     # React / RN / Expo / Next.js standards
│   └── dor.md                  # Definition of Ready checklist
├── .devagent.example
├── .pr-reviewer.example
├── .gitignore
├── setup.sh
└── README.md
```

---

## Contributing

1. Tools share conventions — ANSI colour constants, `log(icon, stage, msg)`, Claude Code pipe pattern. Keep them consistent.
2. Each tool folder has its own `README.md` with deeper docs.
3. Guidelines in `references/` are the source of truth — the PR reviewer and DevAgent both read from them.
4. Never add npm dependencies. These scripts are meant to run anywhere with just Node.
