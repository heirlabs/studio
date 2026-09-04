# Heir Studio

[![CI](https://github.com/heirlabs/studio/actions/workflows/ci.yml/badge.svg)](https://github.com/heirlabs/studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Native **macOS coding app** (Electron) plus a local-only server for
[Grok Build](https://github.com/xai-org/grok-build) (`grok`). An optional
[iOS companion](ios/README.md) talks to the same Mac over Tailscale or a
Cloudflare Tunnel.

**Primary job: software engineering.** Open a project folder, pick a coding
workflow (agent, review, fix, implement, tests), and run real headless `grok`
with tools (edit, shell, search). Screenshots and mocks are optional
attachments. Media workflows live under a secondary panel.

The server binds to `127.0.0.1` by default. Non-loopback clients get `403`
unless you opt into remote access.

[Contributing](CONTRIBUTING.md) · [Architecture](docs/architecture.md) ·
[Environment](docs/environment.md) · [Security](SECURITY.md) ·
[Code of Conduct](CODE_OF_CONDUCT.md)

## Requirements

- macOS 12+ (desktop app). Node-only server and tests also run on Linux CI.
- Node.js 18+
- Grok Build CLI authenticated (`grok` on `PATH` or `~/.grok/bin/grok`)
- The same credentials you already use for the TUI (`grok login` or `XAI_API_KEY`)

## Quick start

```bash
git clone https://github.com/heirlabs/studio.git
cd studio
npm install
npm test
npm run app          # desktop window
```

Or run the UI in a browser:

```bash
npm start
# → http://127.0.0.1:3847
```

Then:

1. Open a **project folder** (⌘O). Coding runs use that directory as cwd.
2. Pick a workflow (Code Agent is the default).
3. Type a task and run. Shift+Tab cycles permission modes.

Health in the UI stays red until `grok` is on `PATH` and logged in. Set
`GROK_BIN` if the binary lives somewhere unusual.

## Build the macOS app

```bash
npm install
npm run dist         # Heir Studio.app → release/mac*/
npm run dist:dmg     # also produce a .dmg
```

Open `release/mac-arm64/Heir Studio.app` (or `mac/` / `mac-x64/` depending on
CPU). Drag the `.app` into **Applications** if you want. First launch of an
unsigned local build may need right-click → Open.

| Script | What it does |
|--------|----------------|
| `npm start` | Loopback server on port `3847` |
| `npm run dev` | Same, restarted on file change |
| `npm run app` | Electron; attaches to `:3847` if that server is already up |
| `npm run dist` | Packaged `.app` |
| `npm run dist:dmg` | Packaged `.app` + `.dmg` |
| `npm test` | Unit + integration (fake grok, no network) |
| `npm run tunnel` | Server + Cloudflare Tunnel with token required on every request |

Packaged-app data lives at
`~/Library/Application Support/heir-studio/data/`. Dev / `npm start` data
lives in `./data/` (gitignored).

## Desktop features

| Feature | How |
|---------|-----|
| Permission modes | Shift+Tab cycles `default` → `acceptEdits` → `plan` → `auto` → `dontAsk` → `bypassPermissions` → passed as `--permission-mode` |
| Multi-model | Model list from `~/.grok/models_cache.json`; selection rules; `-m` |
| Extended thinking | Alt+T cycles effort / off → `--reasoning-effort` |
| Keybindings | 17 contexts; multi-stroke chords; `~/.heir-studio/keybindings.json`; two hardcoded (`forceCancel`, `emergencyStop`) |
| Transcript viewer | Ctrl+O; markdown export |
| History search | Ctrl+R reverse search over user prompts |
| Subagents | Agent defs from `.grok/agents/`, `~/.grok/agents/`, bundled; `--agent` |
| SSH remote | Connection profiles; `scp` of the prompt + `ssh` run of remote `grok` |
| Background runs | Job ledger + notification hooks (Electron `Notification`) |
| Budget / turns | `--max-turns`; daily USD cap (local ledger estimates) |
| Sandbox | `--sandbox` + allow/deny rules |
| Checkpoints | Pre-run + manual snapshots; restore messages |
| Rewind / compact | Jump back in a session; shrink context when a turn gets huge |
| Providers | Gateway / API base URL → flags or env for child `grok` |
| Settings scopes | user (`~/.heir-studio/settings.json`) · project (`.heir-studio/settings.json`) · local (`data/settings.local.json`) |
| Run reattach | Switch sessions mid-run; EventSource re-subscribes via `activeRunId` |
| Tool stream UI | Live tool_call / tool_result / stderr cards with payload previews |
| File attachments | Images **and** text/code files (`@path` into the prompt) |
| Stuck-run recovery | Startup + `POST /api/runs/reconcile` marks orphaned `running` metas aborted |
| Interactive approvals | ACP (`grok agent stdio`) for `default` / `acceptEdits`; UI Allow/Deny modal |
| Mid-run budget | Kill run when day spend + est. turns exceed `maxBudgetUsd` |
| Worktree isolation | Optional git worktree per run (`worktree` checkbox) |

Native extras in the `.app`: dock icon, ⌘O project picker, drop images on the
dock, Finder reveal for outputs, single-instance lock.

## iOS companion

Prompt the Mac from your phone: live token/tool stream, Allow/Deny, cancel,
git, files. The phone reaches the Mac over Tailscale or a Cloudflare Tunnel.
Every request carries a bearer token. A tunneled run cannot inherit
`bypassPermissions`.

```bash
npm run tunnel       # recommended public path (token required, even on loopback)
# or
HEIR_STUDIO_REMOTE=1 HEIR_STUDIO_HOST=100.x.y.z npm start
```

Full setup, threat model, and Xcode build: [ios/README.md](ios/README.md).

## Workflows

Coding first. Media is optional.

| ID | Needs images | What it instructs grok to do |
|----|--------------|------------------------------|
| Code Agent | 0 | Edit, run, test, search in the project cwd |
| Review Diff | 0 | Review `git diff` / staged / a named range |
| Fix Bug | 0 | Reproduce, patch, verify |
| Implement | 0 | Feature end-to-end |
| Refactor | 0 | Structure without behavior change |
| Tests | 0 | Add or fix real tests |
| Explain | 0 | Read-only tour |
| PR / Range | 0 | Branch or commit-range review |
| Saved Workflow | 0 | Launch a `.rhai` workflow by name |
| Image Edit | ≥1 | `image_edit` |
| Image Gen | 0 | `image_gen` |
| Image → Video | ≥1 | `image_to_video` |

Edit `workflows/catalog.json` to add templates (`{{prompt}}`, `{{images}}`,
`{{cwd}}`, `{{#if images}}…{{/if}}`).

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

Bindings are scoped by `when` context. The most specific active context wins,
so Escape on a permission prompt denies that request rather than stopping the
run.

## Tests

```bash
npm test
```

- **Unit**: template, media, config, permissions, keybindings (including chord
  sequences), models, settings layering, budget, sandbox, agents, checkpoints,
  background, ssh quoting (real `/bin/sh` round-trip), providers,
  `buildGrokArgs`, `buildAcpArgs`, `normalizeStreamEvent`, `decidePermission`,
  sessions, rewind, compact, remote auth, tunnel plan, APNs config,
  `resolveProjectCwd`
- **Integration**: HTTP on an ephemeral port, real multer uploads, fake-grok
  child for pong / image / session-image / cancel / concurrency, budget 429,
  keybindings validation, provider, agents CRUD, model select, worktree run,
  spawn-failure finalization, and the ACP matrix (allow / deny / acceptEdits
  auto-approve / read-only auto-deny / turn failure). **No mocks of app code.**

The fake grok fixture emits the **same wire shapes as the real CLI** (verified
against grok 0.2.117): `tool_call` with `title` / `toolName` / `rawInput`,
results as title-less `tool_call_update`, and `available_commands` noise.
Tests that pass against a friendlier invented shape prove nothing.

## Safety

- Loopback-only bind + middleware reject
- UUID validation on run IDs (no path traversal)
- Upload path confined to `data/uploads`
- Max concurrent runs default `3` (429 when exceeded)
- Daily budget cap (local estimate ledger) returns 429 when exceeded
- Cancel sends SIGTERM then SIGKILL after 3s
- Permission modes / sandbox / allow-deny rules passed through to Grok
- Structured stdout logs with timestamps
- No secrets in the repo. Uses your existing `~/.grok/auth.json` / `XAI_API_KEY`
- Rollback: stop the process; delete `data/runs` / `data/outputs` / checkpoints
  if needed. The app is stateless beyond disk.

### Known limits

- **Budget USD** is a local estimate (`$0.05`/turn default when no
  `total_cost_usd` on `end`); pre-spawn gate + mid-run kill on tool turns. Not
  a substitute for xAI billing.
- **SSH remote runs** use `scp` + `ssh` BatchMode; stay on headless transport
  (no ACP over SSH yet); live connectivity is not CI-tested.
- **Subagents** are Grok's own `spawn_subagent` / `--agent` profiles. Studio
  surfaces definitions and flags. It does not reimplement the agent loop.
- **Interactive approvals** use ACP for `default` / `acceptEdits` only.
  `bypassPermissions` / `plan` / `auto` / `dontAsk` stay on headless
  streaming-json.
- **`acceptEdits`** auto-approves `edit` / `read` / `search` and still prompts
  for `execute` / `fetch`. Dismissing a prompt (Escape, backdrop, ×) **denies**
  it.
- **Plan mode** enforcement is the CLI's (`--permission-mode plan`). Studio's
  own policy layer only guards the ACP approval path (for example a
  `read-only` sandbox auto-denies writes).
- **Provider routing** passes `--xai-api-base-url` /
  `--cli-chat-proxy-base-url` on ACP. The headless top-level command has no
  such flags, so there it is env-var best-effort only.
- **Tool events** are normalized server-side to `{name, input}` /
  `{name, result}`. `tool_call_update` has no title, so results are correlated
  to their call by `toolCallId`. `available_commands` (~15KB × ~4 per run) is
  dropped rather than logged and streamed.
- **Screen control** (OS-level UI automation) is out of scope.
- **Agent loop** is the real Grok CLI process (headless or ACP). Studio is the
  desktop shell + orchestration.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Health red | `grok login` or set `XAI_API_KEY`; check `GROK_BIN` |
| 429 on Run | Wait for active runs, or raise concurrency / daily budget in settings |
| Empty gallery | Agent must produce files; check `data/runs/<id>/events.jsonl` |
| Port in use | `HEIR_STUDIO_PORT=3848 npm start` |
| Phone gets HTML instead of JSON | Cloudflare Access is on, but the service token is missing from pairing |
| No permission prompts | Remove `permission_mode = "always-approve"` / `yolo = true` from `~/.grok/config.toml` |
| Tunnel is an open shell | You started the server by hand and left `HEIR_STUDIO_TRUST_LOOPBACK` on. Use `npm run tunnel`. |

## Documentation

| Doc | For |
|-----|-----|
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, tests, PR bar |
| [docs/architecture.md](docs/architecture.md) | Process model, ACP vs headless, data paths |
| [docs/environment.md](docs/environment.md) | Env vars and settings layers |
| [ios/README.md](ios/README.md) | Phone pairing, tunnel, Xcode, TestFlight |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability |

## License

[MIT](LICENSE) © Heir Labs and contributors.
