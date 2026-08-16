# Heir Studio

Native **macOS coding app** (Electron) + local-only server for [Grok Build](https://github.com/xai-org/grok-build) (`grok`).

**Primary job: software engineering** — open a project folder, pick a coding workflow (agent, review, fix, implement, tests…), run real headless `grok` with tools (edit, shell, search). Screenshots/mocks are optional attachments; media workflows live under a secondary panel.

Desktop-agent features (Claude Desktop–style, mapped to Grok CLI):

| Feature | How |
|---------|-----|
| Permission modes | Shift+Tab cycles `default` → `acceptEdits` → `plan` → `auto` → `dontAsk` → `bypassPermissions` → passed as `--permission-mode` |
| Multi-model | Model list from `~/.grok/models_cache.json`; selection rules; `-m` |
| Extended thinking | Alt+T cycles effort / off → `--reasoning-effort` |
| Keybindings | 17 contexts; multi-stroke chords; `~/.heir-studio/keybindings.json`; two hardcoded (`forceCancel`, `emergencyStop`) |
| Transcript viewer | Ctrl+O; markdown export |
| History search | Ctrl+R reverse search over user prompts |
| Subagents | Agent defs from `.grok/agents/`, `~/.grok/agents/`, bundled; `--agent` |
| SSH remote | Connection profiles; scp prompt + `ssh` run of remote `grok` |
| Background runs | Job ledger + notification hooks (Electron `Notification`) |
| Budget / turns | `--max-turns`; daily USD cap (local ledger estimates) |
| Sandbox | `--sandbox` + allow/deny rules |
| Checkpoints | Pre-run + manual snapshots; restore messages |
| Providers | Gateway / API base URL → env for child `grok` |
| Settings scopes | user (`~/.heir-studio/settings.json`) · project (`.heir-studio/settings.json`) · local (`data/settings.local.json`) |
| Run reattach | Switch sessions mid-run; EventSource re-subscribes via `activeRunId` |
| Tool stream UI | Live tool_call / tool_result / stderr cards with payload previews |
| File attachments | Images **and** text/code files (`@path` into the prompt) |
| Stuck-run recovery | Startup + `POST /api/runs/reconcile` marks orphaned `running` metas aborted |
| Interactive approvals | ACP (`grok agent stdio`) for `default` / `acceptEdits`; UI Allow/Deny modal |
| Mid-run budget | Kill run when day spend + est. turns exceed `maxBudgetUsd` |
| Worktree isolation | Optional git worktree per run (`worktree` checkbox) |

**Binds only to `127.0.0.1`.** Non-loopback clients get `403`.

## Requirements

- macOS 12+
- Node.js 18+ (for build / browser mode)
- Grok Build CLI authenticated (`grok` on PATH or `~/.grok/bin/grok`)
- Same credentials you already use for the TUI (`grok login` or `XAI_API_KEY`)

## macOS app (recommended)

```bash
cd ~/grok-studio
npm install
npm run app          # launch desktop app (dev)
npm run dist         # build Heir Studio.app → release/mac*/
npm run dist:dmg     # also produce a .dmg
```

Open **`release/mac-arm64/Heir Studio.app`** (or `mac/` / `mac-x64/` depending on CPU).

You can drag the `.app` into **Applications**. First launch may need right-click → Open (unsigned local build).

**Native features**

- Real window + dock icon (not a browser tab)
- **⌘O** → Open **Project** folder (required cwd for coding runs)
- **⌘⇧O** → Attach screenshots/mocks (optional)
- Coding workflows first: Code Agent, Review Diff, Fix Bug, Implement, Refactor, Tests, Explain, PR/Range
- Media fold for optional Imagine jobs
- Drop images on the dock icon or into Attachments
- **Finder** + right-click media outs → Reveal
- Data: `~/Library/Application Support/heir-studio/data/`
- Single-instance lock; ephemeral localhost port

## Browser mode (still works)

```bash
npm start
# → http://127.0.0.1:3847
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `HEIR_STUDIO_PORT` | `3847` | Browser-mode listen port |
| `GROK_BIN` | auto-detect | Path to `grok` |

## Architecture

```
server/
  index.js          # listen + shutdown
  app.js            # createApp() — used by tests
  lib/
    config.js       # paths, loopback, uuid, grok bin
    catalog.js      # workflow catalog + rhai scan
    template.js     # prompt template + safeName
    media.js        # list/copy/harvest session + text
    runs.js         # spawn grok, SSE, cancel, concurrency, CLI flags
    sessions.js     # multi-tab chat + history search + restore
    permissions.js  # mode cycle + CLI mapping
    models.js       # catalog + selection rules
    keybindings.js  # 17 contexts + load/save/resolve
    settings.js     # user / project / local layers
    agents.js       # agent definition discovery
    ssh.js          # remote profiles + scp/ssh spawn
    checkpoints.js  # session snapshots
    budget.js       # daily spend + turn accounting
    sandbox.js      # profiles + tool policy
    background.js   # background jobs + notification hooks
    providers.js    # gateway env routing
    projects.js     # recent project cwd
    logger.js
public/             # static UI (chat, modals, shortcuts)
electron/           # native shell + notifications
workflows/catalog.json
test/
  unit/             # pure + filesystem tests
  integration/      # real HTTP + fake-grok child process
  fixtures/fake-grok.mjs
data/
  uploads/ outputs/ runs/<uuid>/ chat-sessions/ checkpoints/
```

Each run:

1. Optional pre-run checkpoint of the chat session
2. Stages selected images into `data/runs/<id>/`
3. Writes `prompt.txt` with `@/abs/path` attachments + workflow template
4. Builds CLI args (`--permission-mode`, `-m`, `--max-turns`, `--sandbox`, `--agent`, …)
5. Spawns local `grok` or remote `ssh … grok` with streaming-json
6. Streams NDJSON → SSE clients; appends `events.jsonl`
7. On exit: harvest media, record budget usage, finish background job hooks

## Workflows

| ID | Needs images | Real tools instructed |
|----|--------------|------------------------|
| Image Edit | ≥1 | `image_edit` |
| Image Generate | 0 | `image_gen` |
| Image → Video | ≥1 | `image_to_video` |
| Multi-ref Video | ≥2 | compose + animate |
| Character Sheet | 0+ | gen + edit consistency |
| Style Transfer | ≥2 | multi-ref `image_edit` |
| Game Sprite / UI | 0+ | game asset skills |
| Freeform Agent | 0+ | full agent |
| Saved Rhai Workflow | 0+ | `workflow` tool |

Edit `workflows/catalog.json` to add templates (`{{prompt}}`, `{{images}}`, `{{#if images}}…{{/if}}`).

## Shortcuts (defaults)

| Chord | Action |
|-------|--------|
| Shift+Tab | Cycle permission mode |
| Ctrl+R | History search |
| Ctrl+O | Transcript viewer |
| Alt+T | Toggle / cycle thinking effort |
| Ctrl+C | Cancel current run |
| Ctrl+, | Settings |
| Ctrl+/ | Keybindings help |
| Ctrl+N | New session |
| Ctrl+Shift+C | Checkpoints |
| Ctrl+1…3 | Jump to session 1–3 |
| ↑ / ↓ | Recall previous / next prompt in the composer |
| Escape | Deny a permission prompt · close a modal · stop a run |

Customize: `~/.heir-studio/keybindings.json` (or `data/keybindings.json`).

Bindings are scoped by `when` context; the most specific active context wins, so
Escape on a permission prompt denies that request rather than stopping the run.

## Tests

```bash
npm test
```

- **Unit**: template, media, config, permissions, keybindings (incl. chord sequences), models, settings layering, budget (daily + session turns, ledger corruption recovery), sandbox, agents, checkpoints, background, ssh (quoting proved by a real `/bin/sh` round-trip), providers, `buildGrokArgs`, `buildAcpArgs`, `normalizeStreamEvent`, `decidePermission`, sessions (attach/fail/restore/history order), `resolveProjectCwd`
- **Integration**: HTTP on ephemeral port, real multer uploads, fake-grok child for pong/image/session-image/cancel/concurrency, budget 429, keybindings validation, provider, agents CRUD, model select, worktree-isolated run, spawn-failure finalization, and the full ACP matrix (allow / deny / acceptEdits auto-approve / read-only auto-deny / turn failure) — **no mocks of app code**

The fake grok fixture emits the **same wire shapes as the real CLI** (verified
against grok 0.2.117): `tool_call` with `title` / `toolName` / `rawInput`,
results as title-less `tool_call_update`, and `available_commands` noise. Tests
that pass against a friendlier invented shape prove nothing.

## Safety / ops

- Loopback-only bind + middleware reject
- UUID validation on run IDs (no path traversal)
- Upload path confined to `data/uploads`
- Max concurrent runs default `3` (429 when exceeded)
- Daily budget cap (local estimate ledger) returns 429 when exceeded
- Cancel sends SIGTERM then SIGKILL after 3s
- Permission modes / sandbox / allow-deny rules passed through to Grok
- Structured stdout logs with timestamps
- No secrets in repo; uses your existing `~/.grok/auth.json` / `XAI_API_KEY`
- Rollback: stop process; delete `data/runs` / `data/outputs` / checkpoints if needed; app is stateless beyond disk

### Known limits (honest)

- **Budget USD** is a local estimate (`$0.05`/turn default when no `total_cost_usd` on `end`); pre-spawn gate + mid-run kill on tool turns. Not a substitute for xAI billing
- **SSH remote runs** use `scp` + `ssh` BatchMode; stay on headless transport (no ACP over SSH yet); live connectivity is not CI-tested
- **Subagents** are Grok’s own `spawn_subagent` / `--agent` profiles — Studio surfaces definitions and flags, does not reimplement the agent loop
- **Interactive approvals** use ACP for `default` / `acceptEdits` only; `bypassPermissions` / `plan` / `auto` / `dontAsk` stay on headless streaming-json
- **`acceptEdits`** auto-approves `edit` / `read` / `search` tool calls and still prompts for `execute` / `fetch`. Dismissing a prompt (Escape, backdrop, ×) **denies** it — leaving it unanswered would stall the turn
- **Plan mode** enforcement is the CLI’s (`--permission-mode plan`); Studio’s own policy layer only guards the ACP approval path (e.g. a `read-only` sandbox auto-denies writes)
- **Provider routing** passes the documented `--xai-api-base-url` / `--cli-chat-proxy-base-url` flags on the ACP transport. The headless top-level command has no such flags, so there it is env-var best-effort only
- **Tool events** are normalized server-side to `{name, input}` / `{name, result}`; `tool_call_update` has no title, so results are correlated to their call by `toolCallId`. `available_commands` (~15KB × ~4 per run) is dropped rather than logged and streamed
- **Screen control** (OS-level UI automation) is out of scope for this app
- **Agent loop** is the real Grok CLI process (headless or ACP); Studio is the desktop shell + orchestration

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Health red | `grok login` or set `XAI_API_KEY`; check `GROK_BIN` |
| 429 on Run | Wait for active runs or raise concurrency in `createConfig` |
| Empty gallery | Agent must produce files; check `data/runs/<id>/events.jsonl` and session `images/` |
| Port in use | `HEIR_STUDIO_PORT=3848 npm start` |
