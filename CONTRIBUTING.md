# Contributing to universo-dev-tools

## Prerequisites

Before contributing, ensure you have:

- **Node.js 18+** — `node --version`
- **Claude Code** — `claude --version` (requires a Claude subscription)
- **GitHub CLI** — `gh --version` (for `pr-reviewer`)
- An **Azure DevOps Personal Access Token** with scopes: `Work Items (Read & Write)`, `Code (Read)` (for ADO tools)
- A **GitHub Personal Access Token** with scope: `repo` (for `pr-reviewer`)

## Local setup

```bash
git clone https://github.com/YOUR_GITHUB_ORG/universo-dev-tools.git
cd universo-dev-tools

# Verify dependencies
./setup.sh

# Configure credentials (never commit these files)
cp devagent.example .devagent        # edit with your ADO org/project/PAT
cp pr-reviewer.example .pr-reviewer  # edit with your GitHub token/user
```

## Coding conventions

- **Zero npm dependencies** — use only Node.js built-in modules (`fs`, `https`, `child_process`, `readline`, `path`, `os`). This is intentional and must be preserved.
- **ESM only** — all files use `.mjs` extension and `import`/`export` syntax.
- **ANSI colour constants** — reuse the constants already defined at the top of each script (`B`, `R`, `D`, `GRN`, `RED`, `YEL`, etc.).
- **Logging convention** — use the existing `log(icon, stage, msg)` helper pattern consistent across all tools.
- **Claude Code pipe pattern** — when spawning Claude Code, follow the existing `runClaude(prompt)` / `spawnClaude(args)` pattern in the relevant script.
- **Error handling** — fail fast with a clear message; don't swallow errors silently.

## Making changes

1. Fork the repository and create a branch: `git checkout -b feat/your-feature`
2. Make your changes, keeping each tool self-contained in its own folder.
3. Test your changes locally end-to-end (see each tool's `README.md` for usage).
4. Run a syntax check: `node --check <tool>/<tool>.mjs`
5. Open a pull request against `main` with a clear description of what changed and why.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) when opening an issue. Include:
- Which tool (`agent`, `refine`, `cab-gen`, `pr-reviewer`)
- Node.js version (`node --version`)
- Sanitised config (no tokens)
- Full error output

## Guidelines

- Each tool folder has its own `README.md` — keep it up to date when you change behaviour.
- The `references/` folder contains coding guidelines injected into AI prompts — changes there affect AI-generated output.
- Never add dependencies. If you need a capability that seems to require a package, reach out first to discuss alternatives.
