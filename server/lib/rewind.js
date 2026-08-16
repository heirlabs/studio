/**
 * TUI `/rewind` for Studio (phone + desktop).
 * Truncates the GUI transcript and asks Grok to drop later turns.
 * Does not revert files on disk.
 */
import { AcpClient } from "./acp-client.js";
import { rewindToMessage } from "./sessions.js";

export async function rewindGrokSession({
  dataDir,
  session,
  messageId,
  grokBin,
  cwd,
  env,
} = {}) {
  const { session: next, userIndex } = rewindToMessage(
    dataDir,
    session.id,
    messageId,
  );

  let grokRewound = false;
  let grokError = null;
  if (next.grokSessionId) {
    const client = new AcpClient({
      grokBin,
      cwd: cwd || next.cwd || process.cwd(),
      env: env || process.env,
    });
    client.start();
    try {
      await client.initialize();
      await client.loadSession({
        cwd: cwd || next.cwd || process.cwd(),
        sessionId: next.grokSessionId,
      });
      await client.rewindConversation({ userMessageIndex: userIndex });
      grokRewound = true;
    } catch (e) {
      grokError = e.message || String(e);
    } finally {
      client.dispose();
    }
  }

  return {
    ok: true,
    session: next,
    userIndex,
    grokRewound,
    grokError,
    filesReverted: false,
  };
}
