/**
 * Grok conversation compaction for Studio (phone + desktop).
 * This is the TUI `/compact [note]` path, not a local transcript summary.
 */
import { AcpClient } from "./acp-client.js";
import { updateSession } from "./sessions.js";

export function assertCanCompact(session) {
  if (!session) {
    const err = new Error("session not found");
    err.status = 404;
    throw err;
  }
  if (session.activeRunId) {
    const err = new Error("Cannot compact while a run is live");
    err.status = 409;
    throw err;
  }
  if (!session.grokSessionId) {
    const err = new Error("No Grok session to compact — send a turn first");
    err.status = 409;
    throw err;
  }
}

export function applyCompactResult(
  { tokensBefore, tokensAfter, note, trigger } = {},
) {
  const before = Number(tokensBefore) || 0;
  const after = Number(tokensAfter) || 0;
  const total = before > 0 ? before : after;
  const used = after;
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  return {
    used,
    total,
    percent,
    compactedAt: Date.now(),
    lastNote: note ? String(note) : null,
    trigger: trigger || "manual",
    tokensBefore: before || null,
    tokensAfter: after || null,
  };
}

export function sessionContext(session) {
  const ctx = session?.context || null;
  if (ctx && typeof ctx === "object") return ctx;
  return {
    used: null,
    total: null,
    percent: null,
    compactedAt: null,
    lastNote: null,
    trigger: null,
  };
}

/**
 * Load the stored Grok session and run ACP compact. Writes session.context.
 */
export async function compactGrokSession({
  dataDir,
  session,
  note,
  grokBin,
  cwd,
  env,
} = {}) {
  assertCanCompact(session);
  const client = new AcpClient({
    grokBin,
    cwd: cwd || session.cwd || process.cwd(),
    env: env || process.env,
  });
  client.start();
  try {
    await client.initialize();
    await client.loadSession({
      cwd: cwd || session.cwd || process.cwd(),
      sessionId: session.grokSessionId,
    });
    const raw = await client.compactConversation({ note });
    const context = applyCompactResult({
      tokensBefore: raw?.tokensBefore ?? raw?.preTokens,
      tokensAfter: raw?.tokensAfter ?? raw?.tokens,
      note,
      trigger: "manual",
    });
    const next = updateSession(dataDir, session.id, {
      grokSessionId: client.sessionId || session.grokSessionId,
      context,
    });
    return {
      ok: true,
      grokSessionId: next.grokSessionId,
      context,
      summary: raw?.summary || raw?.message || null,
    };
  } finally {
    client.dispose();
  }
}
