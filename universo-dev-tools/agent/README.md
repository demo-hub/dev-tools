# DevAgent — `agent.mjs`

Autonomous sprint developer. Picks a work item from the current ADO sprint, hands it to Claude Code for TDD implementation across the workspace repos, runs a human review gate, then opens PRs and moves the item to **In Review**.

---

## Usage

```bash
node agent.mjs                  # interactive sprint picker
node agent.mjs --id 1234        # jump straight to a specific item
node agent.mjs --dry-run        # full flow, skip push + PR creation
DEVAGENT_DEBUG=1 node agent.mjs # verbose — prints every ADO URL called
```

Config is read from `.devagent` in the workspace root (or up to 5 parent directories).

---

## State machine

```
PICK → CONTEXT → ANALYSE → BRANCH → IMPLEMENT → TEST → [RETRY] → REVIEW_GATE → PR → ADO_UPDATE → DONE
```

| Stage | What happens |
|---|---|
| **PICK** | Fetches current sprint, filters by assignee + state + work item type |
| **CONTEXT** | Fetches description, AC, comments, linked items, linked PRs, attachments |
| **ANALYSE** | Claude Code reads task + repo roots → returns relevant repos + reasoning |
| **BRANCH** | Creates feature branch only in repos that need changes |
| **IMPLEMENT** | Claude Code writes code TDD-first, runs tests |
| **TEST** | Runs detected test command per modified repo |
| **RETRY** | On test failure, feeds output back to Claude Code (max `ADO_MAX_RETRY` attempts) |
| **REVIEW_GATE** | Shows full diff, asks: `y` push / `n` abort / `s` skip repo |
| **PR** | Pushes branch, opens PR per repo linked to the work item |
| **ADO_UPDATE** | Moves work item state → **In Review** |

---

## Work item filtering

- **Types shown**: Product Backlog Item, Bug, Incident
- **Excluded states**: Done, Ready, Closed, Removed, Resolved
- **Assigned to**: current user (matched by display name, case-insensitive)

---

## Test detection

Auto-detected per repo in priority order:

| File found | Command run |
|---|---|
| `*.sln` / `*.csproj` | `dotnet test` |
| `package.json` with `scripts.test` | `npm test` |
| `vitest` / `jest` in deps | `npx vitest run` / `npx jest` |
| `android/` + `ios/` | `npx jest` (React Native) |
| `pytest.ini` | `pytest` |
| `go.mod` | `go test ./...` |
| `Makefile` with `test:` | `make test` |
| Nothing detected | Asks the user |
