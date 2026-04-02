#!/usr/bin/env bash
set -e

BOLD="\033[1m"
GRN="\033[32m"
YEL="\033[33m"
RED="\033[31m"
R="\033[0m"

ok()   { echo -e "  ${GRN}✔${R}  $1"; }
warn() { echo -e "  ${YEL}⚠${R}  $1"; }
fail() { echo -e "  ${RED}✖${R}  $1"; }

echo ""
echo -e "${BOLD}dev-tools — setup${R}"
echo "──────────────────────────────────────────"

# ── Node.js ──────────────────────────────────
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ]; then
  fail "Node.js not found. Install Node 18+ from https://nodejs.org"
  exit 1
elif [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js $NODE_VER found — version 18+ required."
  exit 1
else
  ok "Node.js $(node --version)"
fi

# ── Claude Code ───────────────────────────────
if ! command -v claude &> /dev/null; then
  fail "Claude Code not found."
  echo ""
  echo "  Install it with:"
  echo "    npm install -g @anthropic-ai/claude-code"
  echo "  Then authenticate:"
  echo "    claude"
  echo ""
  exit 1
else
  ok "Claude Code $(claude --version 2>/dev/null || echo '(version unknown)')"
fi

# ── Config files ──────────────────────────────
echo ""
echo -e "${BOLD}Config files${R}"

if [ -f ".devagent" ]; then
  ok ".devagent already exists — skipping"
else
  cp .devagent.example .devagent
  warn ".devagent created from template — fill in ADO_PAT before using agent.mjs or refine.mjs"
fi

if [ -f ".pr-reviewer" ]; then
  ok ".pr-reviewer already exists — skipping"
else
  cp .pr-reviewer.example .pr-reviewer
  warn ".pr-reviewer created from template — fill in GH_TOKEN and GH_USER before using pr-reviewer.mjs"
fi

# ── Script permissions ────────────────────────
echo ""
echo -e "${BOLD}Script permissions${R}"

for dir in agent refine cab-gen pr-reviewer; do
  script="$dir/$dir.mjs"
  # cab-gen is the exception
  if [ "$dir" = "cab-gen" ]; then script="cab-gen/cab-gen.mjs"; fi
  if [ -f "$script" ]; then
    chmod +x "$script"
    ok "$script"
  else
    warn "$script not found — has it been added yet?"
  fi
done

# ── Done ──────────────────────────────────────
echo ""
echo -e "${BOLD}All done.${R}"
echo ""
echo "  Next steps:"
echo "  1. Edit ${BOLD}.devagent${R}     → add your ADO PAT"
echo "  2. Edit ${BOLD}.pr-reviewer${R}  → add your GitHub token + username"
echo "  3. Run a tool:"
echo "     node agent/agent.mjs --dry-run"
echo "     node pr-reviewer/pr-reviewer.mjs --dry-run"
echo ""
