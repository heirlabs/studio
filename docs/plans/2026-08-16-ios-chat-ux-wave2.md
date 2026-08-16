# Heir Studio iOS — chat UX wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a long Grok Build turn on this Mac readable, steerable, and continuable from the iPhone the way the TUI already is — compact, rewind, context meter, slash commands, and a transcript you can actually read while tools run — with the same actions on desktop.

**Architecture:** The Mac is still the only runtime. Phone and Electron are views of one session store and one Grok ACP conversation. New HTTP surfaces wrap TUI verbs (`/compact [keep]`, `/rewind`, `/context`). iOS never invents a second history.

**Tech Stack:** Express `server/`, Electron `public/`, SwiftUI iOS 17, Grok ACP (`session/load`, `x.ai/compact_conversation`, `x.ai/rewind`).

## Global Constraints

- Session stays on this Mac. Tunnel `studio.heir.es` or Tailscale. **Do not Railway-up the agent.**
- Compact and rewind must hit Grok, not a local UI summary.
- Remote clients cannot inherit `bypassPermissions`.
- No AI attribution in commits. Do not commit `.env`, certs, pairing files.
- Tests hit real Studio modules (fake-grok child is allowed).
- TinyFish MCP was not connected this session; research used Grok user-guide docs + Studio source + public SwiftUI long-list guidance (WWDC26 lazy stacks: keep surviving state in the model, not in scrolled-off views).

---

## Research

### (1) Goal

Logan uses Heir Studio on an iPhone away from the Mac. Wave 1 already added compact HTTP, replay `after=`, queued send, follow-tail, checkpoints, and hub sync. What still hurts during a *long* process:

- Compact is buried in a menu and has no “what to keep” field (TUI is `/compact keep the auth`).
- There is no `/rewind`.
- Context % is not visible while reading.
- The composer is a free-text box; TUI users think in slash commands.
- Thinking stays expanded and the tail yanks the scroll.
- A rotated token 401-stormed the global lockout (partially fixed on the server).
- Session list does not offer “continue last” as a first-class action.

### (2) Constraints and edge cases

| Constraint | Implication |
|---|---|
| iOS suspends SSE | Reattach with `after=lastSeq`. Drop ≠ failed. |
| Compact while live | 409 until the run ends (already). |
| Rewind does not revert files | Copy must say so. Same as TUI. |
| ACP rewind method is `x.ai/rewind/*` | Probe `x.ai/rewind`; if load/rewind fails, truncate Studio transcript and surface that Grok history may still be long. |
| 256-bit token + old phone retrying | Valid token must never be locked out (done). Hub must stop on 401. |
| LazyVStack recycles rows | Thinking-open state lives in ChatModel, not `@State` in the row. |

### (3) Patterns / APIs

- TUI: `/compact [context]`, auto-compact at 85%, `/context`, `/rewind` / Esc Esc, `/session-info`, memory flush before compact ([17-sessions](https://github.com), local `~/.grok/docs/user-guide/17-sessions.md`).
- ACP: `session/load`, `x.ai/compact_conversation`, `x.ai/rewind`, `x.ai/session_notification` (auto-compact).
- iOS: server-authoritative jobs, `URLSession.bytes`, follow-tail latch (Messages/Slack), push categories already `HEIR_PERMISSION` / `HEIR_RUN`.
- WWDC26 lazy stacks: do not store “expanded thinking” only in the row; keep it in the model.

### (4) Data flow

```
composer /compact keep X
  → POST /api/sessions/:id/compact { note }
  → AcpClient.loadSession + compactConversation
  → session.context + hub session compacted
  → phone + desktop refresh meter

composer /rewind  or Rewind sheet
  → GET  /api/sessions/:id/rewinds   (user turns)
  → POST /api/sessions/:id/rewind { messageId }
  → truncate Studio messages after that user turn
  → AcpClient.loadSession + x.ai/rewind
  → hub session rewind
```

### (5) Unknowns / risks

- Exact `x.ai/rewind` params may differ by grok version. Implement, cover with fake-grok, do not silently claim Grok history was rewound if the RPC errors.
- Live Activities still need an ActivityKit entitlement + push. Deferred unless the profile already has it.
- Railway remains rejected.

---

## Ten features (wave 2)

| # | Feature | Why | Server first? |
|---|---|---|---|
| W1 | Slash commands | TUI muscle memory: `/compact`, `/rewind`, `/context`, `/stop` | none if APIs exist |
| W2 | Compact keep-note | TUI `/compact [context]` | already has `note` |
| W3 | Always-on context meter | See 85% while reading | already has context |
| W4 | Conversation rewind | TUI `/rewind` | **yes** |
| W5 | In-transcript search | Find a decision mid-run | none |
| W6 | Long-run strip | Elapsed + last tool + ctx% | none |
| W7 | Session continue-last | One tap back into the live chat | none |
| W8 | 401 / lockout UX | Rotated token must not spin | done on server; iOS stop + unpair |
| W9 | Desktop rewind + meter | Same verbs on Electron | rewind API |
| W10 | Tests + LARP | Prove rewind/compact/slash, not theater | fake-grok rewind |

Wave 1 (already shipped, do not rebuild): replay seq, compact HTTP, queued send, follow-tail, checkpoints, run settings, hub compact event.

---

## File map

**Create**

- `ios/HeirStudio/RewindSheet.swift`
- `ios/HeirStudio/CompactSheet.swift`
- `ios/HeirStudio/TranscriptSearch.swift`
- `test/unit/rewind.test.js`

**Modify**

- `server/lib/sessions.js` — `listRewindPoints`, `rewindToMessage`
- `server/lib/acp-client.js` — `rewindConversation`
- `server/lib/compact.js` or new `server/lib/rewind.js`
- `server/app.js` — GET/POST rewind
- `test/fixtures/fake-grok.mjs` — `x.ai/rewind`
- `ios/HeirStudio/ChatView.swift`, `ChatModel.swift`, `StudioClient.swift`, `SessionListView.swift`, `AppModel.swift`
- `public/app.js` / `public/index.html` — rewind button
- `ios/HeirStudioTests/ClientTests.swift`

---

## Tasks

### Task 1: Rewind API

- [ ] `listRewindPoints(session)` → user messages `{ id, text, createdAt, index }`
- [ ] `rewindToMessage(dataDir, sessionId, messageId)` rejects if live run (409); keeps messages through that user message; drops later; lastPreview from last remaining user text
- [ ] ACP `x.ai/rewind` with `{ sessionId, userMessageIndex }` after `session/load`
- [ ] GET `/api/sessions/:id/rewinds`, POST `/api/sessions/:id/rewind` `{ messageId }`
- [ ] Hub `{ type: "session", event: "rewound" }`
- [ ] Tests: rewind drops later turns; 409 while running; pairing/auth unchanged

### Task 2: iOS slash + compact keep + meter + rewind + search + strip + continue + 401

- [ ] Composer: if text starts with `/`, handle locally (`/compact`, `/compact …`, `/rewind`, `/context`, `/stop`)
- [ ] Compact sheet: optional keep note
- [ ] Nav title accessory: `ctx 42%`
- [ ] Rewind sheet from `/rewind` or menu
- [ ] Transcript filter field
- [ ] ActivityStrip elapsed from `runStartedAt`
- [ ] Session list: first row “Continue” if any live or most-recent
- [ ] Hub 401: banner + stop reconnect (already started)

### Task 3: Desktop

- [ ] Rewind button next to compact
- [ ] Context badge already exists — keep it updated on rewind

### Task 4: Quality / tests / no Railway

- [ ] Node tests for rewind + compact 409
- [ ] iOS unit tests for slash parse + rewind payload
- [ ] Honest LARP: fake-grok rewind is the ACP stand-in; live grok rewind is best-effort
