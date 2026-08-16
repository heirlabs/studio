/**
 * In-process fan-out so every connected client (desktop UI, phone) sees
 * session and run lifecycle as it happens on this Mac.
 */

export function createHub({ heartbeatMs = 15000 } = {}) {
  const clients = new Set();
  let timer = null;

  function sweep() {
    for (const res of [...clients]) {
      if (res.writableEnded || res.destroyed) clients.delete(res);
    }
    if (!clients.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function attach(res) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
    if (!timer) {
      timer = setInterval(() => {
        for (const c of [...clients]) {
          if (c.writableEnded || c.destroyed) {
            clients.delete(c);
            continue;
          }
          c.write(`: ping\n\n`);
        }
        sweep();
      }, heartbeatMs);
      timer.unref?.();
    }
    const onClose = () => {
      clients.delete(res);
      sweep();
    };
    res.on("close", onClose);
    res.on("error", onClose);
    return { ok: true };
  }

  function publish(evt) {
    const payload = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of [...clients]) {
      if (res.writableEnded || res.destroyed) {
        clients.delete(res);
        continue;
      }
      res.write(payload);
    }
  }

  return {
    attach,
    publish,
    get size() {
      return clients.size;
    },
  };
}

export function sessionHubPayload(session) {
  if (!session) return null;
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    activeRunId: session.activeRunId || null,
    updatedAt: session.updatedAt,
    messageCount: Array.isArray(session.messages) ? session.messages.length : undefined,
  };
}
