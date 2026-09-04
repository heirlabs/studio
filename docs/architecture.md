# Architecture

Heir Studio is a desktop shell around a real `grok` child process. It does not
reimplement the agent loop. The server builds prompts and CLI flags, streams
events to the UI, and enforces a few local policies (budget, concurrency,
remote auth, ACP approvals).

## Processes

```
┌──────────────────────┐     loopback HTTP      ┌─────────────────────┐
│  Electron window     │◄──────────────────────►│  Express server     │
│  (or any browser)    │   REST + SSE           │  server/app.js      │
└──────────────────────┘                        └──────────┬──────────┘
                                                           │ spawn
                                                           ▼
                                                ┌─────────────────────┐
                                                │  grok (headless     │
                                                │  or `grok agent     │
                                                │  stdio` ACP)        │
                                                └─────────────────────┘
        phone ── HTTPS + bearer ──► tunnel/tailnet ──► same server
```

- **`npm start` / `npm run tunnel`** bind a stable port (default `3847`).
- **`npm run app`** starts Electron. If something is already healthy on
  `:3847`, the app attaches to that process so desktop and phone share one
  session store. Otherwise it starts its own server on an ephemeral port and
  stores data under `~/Library/Application Support/heir-studio/data/`.
- **iOS** is a second client of the same API. It never talks to xAI directly.

## Why two grok transports

| Mode | When | Wire |
|------|------|------|
| Headless `grok --output-format stream-json` | `plan`, `auto`, `dontAsk`, `bypassPermissions`, SSH remotes | NDJSON on stdout |
| ACP `grok agent stdio` | `default` and `acceptEdits` | JSON-RPC over stdio, with `session/request_permission` |

ACP exists so the UI (and the phone) can Allow / Deny a tool call. Headless
cannot prompt. `acceptEdits` auto-approves `edit` / `read` / `search` and
still prompts for `execute` / `fetch`. Dismissing a prompt denies it. Leaving
it unanswered would stall the turn.

A remote client cannot inherit `bypassPermissions`. The server downgrades that
mode before spawn.

## A coding run

1. Optional pre-run checkpoint of the chat session.
2. Selected images and text files are staged under `data/runs/<uuid>/`.
3. `prompt.txt` is written from the workflow template plus `@/abs/path`
   attachments.
4. CLI args are built (`--permission-mode`, `-m`, `--max-turns`, `--sandbox`,
   `--agent`, worktree cwd, …).
5. Local `grok` or `ssh … grok` is spawned.
6. NDJSON / ACP events are normalized and written to `events.jsonl`, then
   fanned out over SSE (`/api/runs/:id/stream` and `/api/events`).
7. On exit: harvest media, record budget, finish background-job hooks, fire
   APNs if a phone is registered.

## Settings and data

| Layer | Path |
|-------|------|
| User | `~/.heir-studio/settings.json`, `~/.heir-studio/keybindings.json` |
| Project | `<cwd>/.heir-studio/settings.json` |
| Local (gitignored) | `data/settings.local.json` |
| Runtime | `data/uploads`, `data/outputs`, `data/runs/<uuid>`, `data/chat-sessions`, `data/checkpoints` |
| Packaged app | `~/Library/Application Support/heir-studio/data/` |
| Grok itself | `~/.grok/` (`auth.json`, `models_cache.json`, `agents/`, `sessions/`) |

The repo `data/` directory is gitignored except for empty `.gitkeep` folders.

## Remote access

Remote is opt-in. Default bind is `127.0.0.1`. Two independent gates:

1. Source address in an allowed CIDR (Tailscale ranges by default), **and**
2. A bearer token compared in constant time.

`npm run tunnel` sets `trustLoopback: false` because cloudflared's requests
arrive from `127.0.0.1`. Pairing and rotate stay loopback-only so a paired
phone cannot read or replace the token.

Details: [ios/README.md](../ios/README.md), [SECURITY.md](../SECURITY.md).

## Module map

| File | Job |
|------|-----|
| `server/lib/runs.js` | Spawn, SSE, cancel, CLI flags, concurrency |
| `server/lib/acp-client.js` | ACP stdio session + permission RPCs |
| `server/lib/sessions.js` | Multi-tab chat, history search, restore |
| `server/lib/permissions.js` | Mode cycle and CLI mapping |
| `server/lib/remote.js` | Token, CIDR, lockout, pairing |
| `server/lib/tunnel.js` | Pure plan for cloudflared argv |
| `server/lib/budget.js` / `budget-runtime.js` | Daily USD estimate + mid-run kill |
| `server/lib/worktrees.js` | Optional git worktree per run |
| `server/lib/rewind.js` / `compact.js` / `checkpoints.js` | Session time travel |
| `server/lib/git-ops.js` / `fs-browse.js` | Phone file + git panels |
| `server/lib/push.js` | APNs device registry + send |
| `server/lib/hub.js` | Fan-out of live events to SSE clients |

## Trade-offs

- **Studio is a shell, not an agent.** Subagents, plan-mode enforcement, and
  tool sandboxing are Grok's. Studio surfaces them and adds a local approval
  UI on the ACP path only.
- **Budget USD is a local estimate** (`$0.05`/turn when the CLI does not emit
  `total_cost_usd`). It is a tripwire, not xAI billing.
- **SSH remotes stay on headless transport.** There is no ACP over SSH yet.
- **Provider routing** can pass `--xai-api-base-url` /
  `--cli-chat-proxy-base-url` on ACP. The headless top-level command has no
  such flags, so there it is env-var best-effort only.
- **`available_commands` noise** (~15KB × several per run) is dropped rather
  than logged and streamed.

Related: [README.md](../README.md), [docs/environment.md](environment.md).
