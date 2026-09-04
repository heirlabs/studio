# Heir Studio iOS — long-run chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iPhone a reliable spectator-and-steerer for a long Grok Build turn that already lives on the Mac — same session memory, compact, checkpoints, and live transcript the desktop and TUI already have — without inventing a second agent on the phone.

**Architecture:** The Mac remains the runtime (`grok` + Express on :3847). Phone and desktop are views of one session store, one run process, and one Grok conversation id. New server APIs wrap Grok ACP (`session/load`, `x.ai/compact_conversation`) and existing Studio checkpoints. iOS never summarizes, checkpoints, or budgets locally.

**Tech Stack:** Heir Studio Express (`server/`), Electron web UI (`public/`), SwiftUI iOS 17 (`ios/HeirStudio`), Grok Build ACP / headless JSON, APNs, Cloudflare tunnel.

## Global Constraints

- Session stays on this Mac. Tunnel or Tailscale is the only remote path.
- Do not deploy Heir Studio to Railway. The agent needs the local filesystem, `grok` login, git, worktrees, and APNs certs.
- Phone must not invent compact/checkpoint/worktree state. If the HTTP API is missing, add it to the server first.
- Remote clients cannot inherit `bypassPermissions` unless `allowBypassPermissions: true`.
- No AI attribution in commits. Conventional commits. Do not commit `.env`, certs, or `ios/certs/`.
- Tests exercise real Studio code (fake-grok child is allowed; mocks of `runs.js` / `sessions.js` are not).
- iOS `aps-environment` stays `development` in source; App Store export remaps to production.
- Do not stub, TODO, or leave a phone-only fake that desyncs from Grok.

## Research (what this is, and why)

### Goal, clarified

Logan uses Heir Studio on an iPhone away from the Mac. The current TestFlight app can start a turn and render markdown, but a long process is a fragile spectator: iOS kills SSE on lock, reattach can **duplicate tokens**, notifications **do not open the chat**, the composer is **locked until the Mac is idle**, and each interactive turn is an ACP `session/new` so **Grok memory does not accumulate**. Compact in the TUI (`/compact`, auto at 85%) has **no Studio HTTP surface**, so the phone cannot mirror it.

This work is not a new chat product. It is feature parity for *viewing, accessing, and continuing* a long Grok Build session from the phone, with the same actions appearing on the desktop.

### Constraints, dependencies, edge cases

| Constraint | Implication |
|---|---|
| iOS suspends long-lived HTTP | Server keeps generating. Phone re-syncs. Do not treat SSE drop as a failed run. |
| `UIBackgroundModes` is `remote-notification` only | No silent processing. Push + foreground reattach is the wake path. |
| EventSource cannot send Bearer | Keep `URLSession.bytes`. |
| ACP `session/new` every interactive turn | Compact is meaningless until `session/load` / `--resume` is wired for ACP. |
| Studio checkpoints ≠ Grok compact | Checkpoints snapshot GUI transcript + git porcelain. Compact rewrites Grok history. Both needed. |
| Replay dumps every event | Reattach after lock appends tokens already in `textAccumulator`. |
| `inboundRun` only consumed if ChatView is visible | Lock-screen Open lands on the list. |
| Autoscroll on every thought | Cannot read earlier output mid-run. |
| Railway | Rejected. Local spawn + cwd cannot move to a PaaS. |

### Patterns / APIs / libraries that apply

- **iOS:** Server-authoritative long jobs; `UIBackgroundTask` is only a grace window; Live Activity optional later; push categories already `HEIR_PERMISSION` / `HEIR_RUN`; scroll-follow latch (Messages / Slack).
- **Grok Build TUI:** `/compact [context]`, auto-compact 85%, `/context`, `/session-info`, `/rewind`, `/flush`, `compaction_checkpoints/`, ACP `x.ai/compact_conversation`, `x.ai/session_notification`.
- **Studio already:** `GET /api/sessions/:id/active-run`, stream replay, hub `/api/events`, checkpoints REST, history search, budget kill, worktrees, models, background jobs.
- **Cursor / Claude Code lesson:** Compact must run on the *agent* history, not a local UI summary. Tool results should stay re-fetchable (files on disk), not permanently deleted without a checkpoint.

### Architecture and data flow

```
iPhone / Electron  --Bearer-->  Studio Express :3847  --ACP/stdio or --resume-->  grok
                                      |                          |
                                      +-- data/chat-sessions     +-- ~/.grok/sessions
                                      +-- data/push-devices.json
                                      +-- hub SSE /api/events
                                      +-- run SSE /api/runs/:id/stream
```

1. Pairing stores host + token in Keychain.
2. `POST /api/sessions/:id/messages` appends user + assistant placeholder, `startRun`.
3. Interactive modes use ACP. After this plan: `session/load(grokSessionId)` if present, else `session/new`, persist `grokSessionId`.
4. Phone attaches `GET /api/runs/:id/stream?after=<seq>`. Server writes `id:` + `{seq}` on every event.
5. iOS suspend → stream dies → `recoverAfterDrop` polls `active-run` until finished or foreground. Never flips the run to failed because the socket died.
6. Push Open / hub `run.started` sets `inboundRun`; root navigation pushes that `ChatView`.
7. Compact: `POST /api/sessions/:id/compact` loads Grok session, calls `x.ai/compact_conversation`, publishes `studio.compact` on the hub. Desktop and phone both render a compact chip and refresh context %.
8. Auto-compact inside grok (if the resumed session hits 85%) is forwarded as the same `studio.compact` event.

### Unknowns and risks

1. Exact ACP `session/load` and `x.ai/compact_conversation` param names may differ by grok version — implement, probe with fake-grok + a live grok if present, and keep a documented fallback (`session/new` + warn) only when load is unsupported, not as a silent success.
2. Compact while a run is live is unsafe (two ACP clients on one session). Reject with 409 until the run ends.
3. If `session/load` fails (deleted grok session), surface that and start `session/new` so the user is not stuck.
4. Live Activities need a push token + ActivityKit entitlement — defer if the provisioning profile lacks it; lock-screen categories already exist.
5. TinyFish MCP was not connected in this session; research used Grok docs + Studio source + public iOS/SSE/compaction sources.

### Railway

**Do not Railway-up this app.** Heir Studio is a localhost orchestrator. Railway would have no Mac cwd, no grok credentials, and would expose a shell agent. Remote access is the existing named tunnel.

---

## Ten features (canonical todo)

| # | Feature | Why | Server first? |
|---|---|---|---|
| F1 | Live-run survival | SSE drop ≠ failed; reattach without duplicated text; recover until finished | Replay `seq` + `after=` |
| F2 | Thinking / tool / progress | Readable long turn: tool timeline, thought collapse, follow-tail latch | Forward `studio.plan` |
| F3 | Context compression | TUI `/compact` + auto-compact on phone and desktop | ACP load + compact API |
| F4 | Chat reading UX | Search in transcript, jump-to-latest, copy, diff quality | none |
| F5 | Session access | Search, last-message preview, continue-last, open from push | history already exists |
| F6 | Lock-screen continue | Notification opens the live chat; permission/stop already wired | inbound navigation |
| F7 | Composer mid-run | Queue next prompt; Stop actually unlocks if stream is dead | optional queue field |
| F8 | Checkpoints / rewind | List / restore Studio checkpoints on phone + desktop | already exists |
| F9 | Model / budget / worktree | Same flags desktop already posts | already exists |
| F10 | Desktop ↔ phone sync | Hub events for compact, checkpoint, context; both UIs stay aligned | hub payloads |

---

## File map

**Create**

- `server/lib/compact.js` — load grok session, call ACP compact, persist result
- `test/unit/compact.test.js`
- `ios/HeirStudio/ToolTimeline.swift`
- `ios/HeirStudio/CheckpointSheet.swift`
- `ios/HeirStudio/ContextSheet.swift`
- `ios/HeirStudio/SessionSearch.swift`
- `ios/HeirStudioTests/ChatSurvivalTests.swift`
- `ios/HeirStudioTests/CompactClientTests.swift`

**Modify**

- `server/lib/acp-client.js` — `loadSession`, compact RPC, session-notification → `studio.compact`
- `server/lib/runs.js` — seq on events, `after` replay, ACP resume, forward compact
- `server/app.js` — `POST /api/sessions/:id/compact`, `GET /api/sessions/:id/context`, health flag `compact`
- `server/lib/hub.js` / publishers — `compact` + richer session payload
- `test/fixtures/fake-grok.mjs` — `session/load`, `x.ai/compact_conversation`
- `test/integration/api.test.js` — compact + resume + after=
- `public/app.js`, `public/index.html` — compact button, context %, checkpoint already present (wire compact)
- `ios/HeirStudio/ChatModel.swift`, `ChatView.swift`, `AppModel.swift`, `SessionListView.swift`, `StudioClient.swift`, `Models.swift`, `PushService.swift`, `HeirStudioApp.swift`

---

### Task 1: ACP session load (unblocks F3 and real multi-turn memory)

**Files:**
- Modify: `server/lib/acp-client.js`
- Modify: `server/lib/runs.js` (spawn ACP path)
- Modify: `test/fixtures/fake-grok.mjs`
- Test: `test/unit/acp-budget-worktrees.test.js`, `test/integration/api.test.js`

**Interfaces:**
- Consumes: `session.grokSessionId`, `needsInteractiveApprovals`
- Produces: `AcpClient.loadSession({ cwd, sessionId })`, `runAcpAgent({ resumeSessionId })`

- [ ] **Step 1: Write the failing test** — fake-grok records `session/load` vs `session/new`; integration asserts the second interactive turn calls load with the first turn’s session id.

- [ ] **Step 2: Implement `loadSession`**

```js
async loadSession(opts) {
  const result = await this.request("session/load", {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    mcpServers: [],
  });
  this.sessionId = result.sessionId || opts.sessionId;
  return result;
}
```

In `runAcpAgent`, if `resumeSessionId` is set, try `loadSession`; on RPC error emit `{ type: "studio", event: "session_resume_failed", message }` then `newSession`.

- [ ] **Step 3: Persist `client.sessionId` into `finishedMeta.sessionId`** so the next turn can load it (already written via `finalizeAssistantMessage` / `grokSessionId`).

- [ ] **Step 4: Run** `node --test --test-concurrency=1 test/unit/acp-budget-worktrees.test.js test/integration/api.test.js`

- [ ] **Step 5: Commit** `fix(server): resume ACP sessions instead of session/new every turn`

---

### Task 2: Compact + context API (F3 + F10)

**Files:**
- Create: `server/lib/compact.js`, `test/unit/compact.test.js`
- Modify: `server/app.js`, `server/lib/acp-client.js`, `server/lib/sessions.js`, `public/app.js`, `public/index.html`

**Interfaces:**
- Consumes: `session.grokSessionId`, `activeRunId`
- Produces:
  - `POST /api/sessions/:id/compact` `{ note?: string }` → `{ ok, tokensBefore, tokensAfter, summary, grokSessionId }`
  - `GET /api/sessions/:id/context` → `{ used, total, percent, compactedAt, lastNote }`
  - Hub `{ type: "session", event: "compacted", sessionId, context }`
  - Stream `{ type: "studio", event: "compact", tokensBefore, tokensAfter, trigger: "manual"|"auto" }`

- [ ] **Step 1: Tests** — 409 if `activeRunId` set; 409 if no `grokSessionId`; 200 calls fake-grok compact; context percent stored on session.

- [ ] **Step 2: Implement** spawn short-lived ACP, `loadSession`, `request("x.ai/compact_conversation", { sessionId, context: note })`, write `session.context` + `session.compactedAt`.

- [ ] **Step 3: Forward grok `auto_compact_*` / `compact_boundary` / `x.ai/session_notification` as `studio.compact` during a live run.**

- [ ] **Step 4: Desktop** Compact button + context meter in the transcript header (same endpoints).

- [ ] **Step 5: Commit** `feat: compact and context APIs shared by phone and desktop`

---

### Task 3: Replay cursor (F1)

**Files:** `server/lib/runs.js`, `ios/HeirStudio/ChatModel.swift`, `test/unit/runs-build.test.js`

**Interfaces:**
- Every stored event gets `seq` (monotonic int, starting 1).
- `GET /api/runs/:id/stream?after=N` skips events with `seq <= N`.
- iOS tracks `lastSeq`; `attach` does not seed accumulators from message text **and** replay those tokens.

- [ ] **Step 1: Test** normalize/attach skips `after`.
- [ ] **Step 2: Server seq + after.**
- [ ] **Step 3: iOS `lastSeq`; on attach if `after` supported, do not pre-seed text from the message when replaying from 0 — prefer `after`.**
- [ ] **Step 4: `recoverAfterDrop` polls until `active-run.active === false` or 120s, then reloads session. Never marks the run failed because the socket died.**
- [ ] **Step 5: Commit** `fix: replay-safe run streams and longer recover`

---

### Task 4: Open the live chat (F5 + F6)

**Files:** `AppModel.swift`, `HeirStudioApp.swift`, `PushService.swift`, `SessionListView.swift`

- [ ] Root holds `NavigationPath` or `openedSession`.
- [ ] `applyOpen` / hub `run.started` / `permission` sets `inboundRun` **and** `openedSession`.
- [ ] Session list shows last user preview, relative time, green “live”, orange “needs you”.
- [ ] Wire `GET /api/history?q=` for search.
- [ ] Commit `feat(ios): open the live chat from push, hub, and search`

---

### Task 5: Reading a long turn (F2 + F4)

**Files:** `ChatView.swift`, `ChatModel.swift`, `ToolTimeline.swift`

- [ ] Follow-tail only when the user is near the bottom; “Jump to latest” when not.
- [ ] Tool cards (name, preview, error) — keep last 80 like desktop.
- [ ] Thinking expanded only for the in-flight assistant message.
- [ ] Transcript search (local filter) + copy message.
- [ ] Git sheet uses `DiffView`.
- [ ] Commit `feat(ios): follow-tail, tool timeline, transcript search`

---

### Task 6: Queue / Stop (F7)

**Files:** `ChatModel.swift`, `ChatView.swift`

- [ ] Composer enabled while running; Send enqueues one follow-up (replace if already queued).
- [ ] On `finished`, if a queue exists, `send()` it.
- [ ] `cancel()` sets local `isRunning = false` after the cancel POST if recover cannot see a live run.
- [ ] Commit `feat(ios): queue the next prompt during a live turn`

---

### Task 7: Checkpoints (F8)

**Files:** `CheckpointSheet.swift`, `StudioClient.swift`, desktop already has a picker — verify it uses the same restore route.

- [ ] List / create / restore / delete via existing REST.
- [ ] Restore reloads messages + `grokSessionId`; banner that files on disk are not reverted.
- [ ] Commit `feat: checkpoints on the phone`

---

### Task 8: Model / budget / worktree (F9)

**Files:** `StudioClient.SendOptions`, `ChatView` menu, `public/app.js` already has these — phone must send the same body keys.

- [ ] Fetch `/api/models`, `/api/budget`, `/api/worktrees?cwd=`.
- [ ] Persist last choices in UserDefaults (not as a second source of truth for the run — they are request flags).
- [ ] Commit `feat(ios): model, budget, and worktree flags`

---

### Task 9: Desktop mirror (F10)

**Files:** `public/app.js`, `public/index.html`, `public/styles.css`

- [ ] Compact control + context % + compact chip in the transcript (same as phone).
- [ ] Hub `compacted` refreshes the open session without a full reload.
- [ ] Commit `feat(desktop): compact and context meter`

---

### Task 10: Quality, tests, TestFlight notes

- [ ] Server unit + integration green.
- [ ] iOS unit tests for seq attach, compact decode, payload open, status text.
- [ ] LARP pass: no phone-local fake compact; no swallowed cancel; no mock of `runs.js`.
- [ ] Bump iOS to 1.0.6 when ready to upload (not in this PR unless asked).
- [ ] Do not merge until the user reviews.

---

## Deviations to flag if they happen

- If `session/load` is not implemented in the installed grok, say so in the compact/context UI (“Grok on this Mac cannot resume ACP sessions”) instead of pretending compact worked.
- If ActivityKit entitlement is missing, skip Live Activities; lock-screen categories stay.
- If a feature needs a new entitlement or ASC capability, stop and say so.

## Execution order

Server Tasks 1–3 are sequential (same files). Tasks 4–8 can fan out after 1–3 land. Task 9 can run in parallel with 4–8. Task 10 last.
