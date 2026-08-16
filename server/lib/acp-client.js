/**
 * Grok Agent Client Protocol (ACP) client over stdio.
 * Enables interactive session/request_permission for non-bypass permission modes.
 *
 * Transport: JSON-RPC 2.0, one message per line on stdin/stdout.
 * Spec: https://agentclientprotocol.com
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { createRequire } from "module";
import { evaluateToolPolicy } from "./sandbox.js";
import { providerToAgentCliArgs } from "./providers.js";

const { version: STUDIO_VERSION } = createRequire(import.meta.url)(
  "../../package.json",
);

/**
 * Whether this permission mode needs an interactive approval channel (ACP).
 * bypass / dontAsk / plan / auto work headless without user prompts mid-tool.
 */
export function needsInteractiveApprovals(permissionMode) {
  const m = String(permissionMode || "default");
  return m === "default" || m === "acceptEdits";
}

/**
 * ACP toolCall.kind values that `acceptEdits` approves without prompting.
 * Anything that shells out or reaches the network ("execute", "fetch") still asks.
 */
const AUTO_APPROVED_KINDS = new Set(["edit", "read", "search"]);
const AUTO_APPROVED_TITLE_RE =
  /^(edit|write|create|read|apply|patch|str_replace|search|grep|glob|list)/i;

/**
 * Whether a tool call is a file edit/read that `acceptEdits` may auto-approve.
 * Falls back to the title when the agent omits `kind`.
 */
export function isAutoApprovableToolCall(toolCall) {
  const kind = String(toolCall?.kind || "").toLowerCase();
  if (kind) return AUTO_APPROVED_KINDS.has(kind);
  return AUTO_APPROVED_TITLE_RE.test(String(toolCall?.title || ""));
}

/**
 * Pick the option representing "allow" from an ACP permission option list.
 */
export function pickAllowOption(options = []) {
  return (
    options.find((o) => o.kind === "allow_once") ||
    options.find((o) => o.kind === "allow_always") ||
    options.find((o) => /allow|approve|yes/i.test(o.name || o.optionId || "")) ||
    null
  );
}

/**
 * Decide a permission request without the user when studio policy already
 * determines the answer. Pure — the transport applies the result.
 *
 * @returns {{ action: "allow"|"deny"|"ask", optionId?: string, reason?: string }}
 */
export function decidePermission({
  permissionMode,
  sandbox,
  toolCall,
  options = [],
} = {}) {
  const toolName = toolCall?.title || toolCall?.kind || "";
  const policy = evaluateToolPolicy(toolName, { permissionMode, sandbox });
  if (!policy.allowed) {
    return { action: "deny", reason: policy.reason };
  }
  if (permissionMode === "acceptEdits" && isAutoApprovableToolCall(toolCall)) {
    const opt = pickAllowOption(options);
    if (opt) {
      return {
        action: "allow",
        optionId: opt.optionId,
        reason: `acceptEdits auto-approved ${toolName || "tool"}`,
      };
    }
  }
  return { action: "ask" };
}

/**
 * Map studio permission mode → session/new _meta flags.
 */
export function permissionModeToAcpMeta(permissionMode) {
  const m = String(permissionMode || "default");
  if (m === "bypassPermissions") return { yoloMode: true };
  if (m === "auto") return { autoMode: true };
  return {};
}

/**
 * Map ACP session/update notifications → studio streaming-json-like events.
 */
export function acpUpdateToStudioEvents(update) {
  if (!update || typeof update !== "object") return [];
  const kind = update.sessionUpdate || update.type;
  const out = [];
  if (kind === "agent_message_chunk") {
    const text =
      update.content?.text ??
      (typeof update.content === "string" ? update.content : "") ??
      update.text ??
      "";
    if (text) out.push({ type: "text", data: text });
  } else if (kind === "agent_thought_chunk") {
    const text =
      update.content?.text ??
      (typeof update.content === "string" ? update.content : "") ??
      update.text ??
      "";
    if (text) out.push({ type: "thought", data: text });
  } else if (kind === "tool_call") {
    // Naming and toolCallId correlation are normalizeStreamEvent's job, so
    // both transports label cards the same way — pass the raw fields through.
    out.push({
      type: "tool_call",
      title: update.title || update.kind || null,
      toolCallId: update.toolCallId || update.id || null,
      kind: update.kind || null,
      input: update.rawInput ?? update.input ?? update.arguments ?? null,
      status: update.status || "pending",
      acp: true,
    });
  } else if (kind === "tool_call_update") {
    // An ACP update's `title` is prose ("Read `/abs/path.txt`"), not a tool
    // name — keep it as detail and let the update inherit its call's name.
    out.push({
      type: "tool_result",
      toolCallId: update.toolCallId || update.id || null,
      detail: update.title || null,
      result: update.rawOutput ?? update.content ?? update.status ?? null,
      status: update.status || "completed",
      acp: true,
    });
  } else if (kind === "plan") {
    out.push({
      type: "studio",
      event: "plan",
      data: update,
    });
  }
  return out;
}

/**
 * Build a JSON-RPC request/response envelope.
 */
export function jsonRpcRequest(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

export function jsonRpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * argv for `grok agent … stdio`. Options precede the subcommand, per
 * `grok agent [OPTIONS] [COMMAND]`. Shared so a run's recorded meta.args is
 * exactly what was spawned.
 */
export function buildAcpArgs({ alwaysApprove, model, extraArgs = [] } = {}) {
  const args = ["agent"];
  if (alwaysApprove) args.push("--always-approve");
  if (model) args.push("-m", String(model));
  args.push(...extraArgs);
  args.push("--no-leader", "stdio");
  return args;
}

/**
 * Long-lived ACP connection to `grok agent stdio`.
 */
export class AcpClient extends EventEmitter {
  /**
   * @param {{ grokBin: string, cwd: string, env?: object, alwaysApprove?: boolean, model?: string }} opts
   */
  constructor(opts) {
    super();
    this.grokBin = opts.grokBin;
    this.cwd = opts.cwd;
    this.env = opts.env || process.env;
    this.alwaysApprove = Boolean(opts.alwaysApprove);
    this.model = opts.model || null;
    this.extraArgs = opts.extraArgs || [];
    this.proc = null;
    this.sessionId = null;
    this.nextId = 1;
    /** @type {Map<number|string, {resolve:Function, reject:Function}>} */
    this.pending = new Map();
    /** @type {Map<number|string, {request:object, createdAt:number}>} */
    this.pendingPermissions = new Map();
    this.stdoutBuf = "";
    this.closed = false;
    this.exitCode = null;
    this.signal = null;
  }

  start() {
    if (this.proc) {
      throw new Error("ACP client already started");
    }
    const args = buildAcpArgs({
      alwaysApprove: this.alwaysApprove,
      model: this.model,
      extraArgs: this.extraArgs,
    });

    this.proc = spawn(this.grokBin, args, {
      cwd: this.cwd,
      env: { ...this.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk);
    });
    this.proc.on("error", (err) => {
      this.emit("error", err);
      this._failAll(err);
    });
    this.proc.on("close", (code, signal) => {
      this.closed = true;
      this.exitCode = code;
      this.signal = signal;
      this._failAll(
        new Error(`ACP process exited code=${code} signal=${signal || ""}`),
      );
      this.emit("close", { code, signal });
    });

    return this;
  }

  _failAll(err) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
    for (const [id] of this.pendingPermissions) {
      this.emit("permission_timeout", { id });
    }
    this.pendingPermissions.clear();
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("raw", line);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to our request
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(
            msg.error.message || JSON.stringify(msg.error),
          );
          err.code = msg.error.code;
          err.data = msg.error.data;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Server → client request (permission)
    if (msg.method && msg.id != null) {
      if (msg.method === "session/request_permission") {
        const permissionId = String(msg.id);
        this.pendingPermissions.set(permissionId, {
          request: msg,
          createdAt: Date.now(),
        });
        const params = msg.params || {};
        this.emit("permission_request", {
          id: permissionId,
          sessionId: params.sessionId,
          toolCall: params.toolCall || {},
          options: params.options || [],
          raw: msg,
        });
        return;
      }
      // Unhandled server request — cancel
      this._write(
        jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`),
      );
      return;
    }

    // Notification
    if (msg.method === "session/update") {
      this.emit("session_update", msg.params || {});
      return;
    }
    if (msg.method) {
      this.emit("notification", msg);
    }
  }

  _write(obj) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed || this.closed) {
      return false;
    }
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   */
  request(method, params, { timeoutMs = 600_000 } = {}) {
    if (this.closed) {
      return Promise.reject(new Error("ACP client closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      if (!this._write(jsonRpcRequest(id, method, params))) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("ACP process stdin not available"));
      }
    });
  }

  /**
   * Notify (no response expected).
   */
  notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "heir-studio",
        version: STUDIO_VERSION,
      },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
  }

  /**
   * @param {{ cwd: string, yoloMode?: boolean, autoMode?: boolean, rules?: string }} opts
   */
  async newSession(opts) {
    const meta = {};
    if (opts.yoloMode) meta.yoloMode = true;
    if (opts.autoMode) meta.autoMode = true;
    if (opts.rules) meta.rules = opts.rules;
    const result = await this.request("session/new", {
      cwd: opts.cwd,
      mcpServers: [],
      _meta: Object.keys(meta).length ? meta : undefined,
    });
    this.sessionId = result.sessionId;
    return result;
  }

  /**
   * Resume a previous ACP conversation so the next prompt sees prior turns.
   * Interactive Studio used to call session/new every time, which made
   * compact and multi-turn memory a no-op.
   */
  async loadSession(opts) {
    const result = await this.request("session/load", {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: [],
    });
    this.sessionId = result.sessionId || opts.sessionId;
    return result;
  }

  /**
   * TUI `/compact [note]` over ACP. Requires an already-loaded session.
   */
  async compactConversation({ note } = {}) {
    if (!this.sessionId) {
      throw new Error("No ACP session — call loadSession or newSession first");
    }
    return this.request("x.ai/compact_conversation", {
      sessionId: this.sessionId,
      context: note || undefined,
    });
  }

  /**
   * Send a user prompt. Streams session/update via events until the RPC returns.
   */
  async prompt(text, { attachments = [] } = {}) {
    if (!this.sessionId) {
      throw new Error("No ACP session — call newSession first");
    }
    const blocks = [{ type: "text", text: String(text || "") }];
    for (const a of attachments) {
      if (a?.path) {
        blocks.push({
          type: "resource_link",
          uri: `file://${a.path}`,
          name: a.name || a.path,
        });
      }
    }
    return this.request(
      "session/prompt",
      {
        sessionId: this.sessionId,
        prompt: blocks,
      },
      { timeoutMs: 3_600_000 },
    );
  }

  /**
   * Respond to a pending session/request_permission.
   * @param {string} permissionId JSON-RPC id of the request
   * @param {{ outcome: 'selected'|'cancelled', optionId?: string }} decision
   */
  respondPermission(permissionId, decision) {
    const pending = this.pendingPermissions.get(String(permissionId));
    if (!pending) {
      throw new Error(`No pending permission request: ${permissionId}`);
    }
    this.pendingPermissions.delete(String(permissionId));
    let outcome;
    if (decision.outcome === "cancelled" || decision.cancelled) {
      outcome = { outcome: "cancelled" };
    } else {
      outcome = {
        outcome: "selected",
        optionId: decision.optionId,
      };
    }
    // Wire format per ACP: result.outcome is RequestPermissionOutcome
    const ok = this._write(
      jsonRpcResponse(pending.request.id, {
        outcome,
      }),
    );
    if (!ok) {
      throw new Error("ACP process stdin not available");
    }
    this.emit("permission_resolved", {
      id: permissionId,
      decision,
    });
  }

  /**
   * Cancel the current prompt turn.
   */
  cancelSession() {
    if (!this.sessionId || this.closed) return;
    this.notify("session/cancel", { sessionId: this.sessionId });
  }

  kill(signal = "SIGTERM") {
    if (this.proc && !this.proc.killed) {
      this.proc.kill(signal);
    }
  }

  dispose() {
    this.pendingPermissions.clear();
    if (!this.closed) {
      this.cancelSession();
      if (this.proc?.stdin && !this.proc.stdin.destroyed) {
        this.proc.stdin.end();
      }
      this.kill("SIGTERM");
      // unref so a lingering agent never holds the process open
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.kill("SIGKILL");
      }, 3000).unref();
    }
    this.closed = true;
  }
}

/**
 * Run a single-shot ACP turn for studio, mapping events through onEvent.
 * Returns a handle with cancel / respondPermission.
 */
export function runAcpTurn({
  grokBin,
  cwd,
  env,
  model,
  permissionMode,
  sandbox,
  provider,
  prompt,
  attachments,
  resumeSessionId,
  onEvent,
  onPermissionRequest,
}) {
  const alwaysApprove =
    permissionMode === "bypassPermissions" || permissionMode == null;
  const client = new AcpClient({
    grokBin,
    cwd,
    env,
    alwaysApprove,
    model,
    extraArgs: providerToAgentCliArgs(provider),
  });

  // AcpClient is an EventEmitter: an "error" event with no listener is rethrown
  // and takes the whole server down. Own it here — the failure still surfaces
  // through `done`, because _failAll rejects every in-flight request.
  client.on("error", (err) => {
    onEvent?.({ type: "error", message: err.message });
  });

  client.start();

  const meta = permissionModeToAcpMeta(permissionMode);

  client.on("session_update", (params) => {
    const update = params.update || params;
    for (const evt of acpUpdateToStudioEvents(update)) {
      onEvent?.(evt);
    }
  });

  client.on("stderr", (chunk) => {
    onEvent?.({ type: "studio", event: "stderr", data: chunk });
  });

  client.on("permission_request", (req) => {
    const verdict = decidePermission({
      permissionMode,
      sandbox,
      toolCall: req.toolCall,
      options: req.options,
    });
    if (verdict.action !== "ask") {
      onEvent?.({
        type: "studio",
        event: "permission_auto",
        id: req.id,
        decision: verdict.action,
        reason: verdict.reason,
        toolCall: req.toolCall,
      });
      client.respondPermission(
        req.id,
        verdict.action === "allow"
          ? { outcome: "selected", optionId: verdict.optionId }
          : { outcome: "cancelled" },
      );
      return;
    }
    onEvent?.({
      type: "studio",
      event: "permission_request",
      id: req.id,
      toolCall: req.toolCall,
      options: req.options,
      sessionId: req.sessionId,
    });
    onPermissionRequest?.(req);
  });

  const done = (async () => {
    await client.initialize();
    let resumed = false;
    if (resumeSessionId) {
      try {
        await client.loadSession({ cwd, sessionId: resumeSessionId });
        resumed = true;
      } catch (err) {
        onEvent?.({
          type: "studio",
          event: "session_resume_failed",
          message: err.message,
          grokSessionId: resumeSessionId,
        });
        await client.newSession({
          cwd,
          yoloMode: Boolean(meta.yoloMode),
          autoMode: Boolean(meta.autoMode),
        });
      }
    } else {
      await client.newSession({
        cwd,
        yoloMode: Boolean(meta.yoloMode),
        autoMode: Boolean(meta.autoMode),
      });
    }
    onEvent?.({
      type: "studio",
      event: "acp_session",
      sessionId: client.sessionId,
      resumed,
    });
    const result = await client.prompt(prompt, { attachments });
    onEvent?.({
      type: "end",
      stopReason: result?.stopReason || "EndTurn",
      sessionId: client.sessionId,
      acpResult: result,
    });
    return result;
  })();

  // Always tear the agent down — a failed turn used to leave `grok agent stdio`
  // running forever. Two handlers (not .finally) so this derived promise always
  // resolves; the caller owns `done` and its rejection.
  done.then(
    () => {
      // brief grace so trailing session/update notifications flush
      setTimeout(() => client.dispose(), 100).unref();
    },
    () => client.dispose(),
  );

  return {
    client,
    done,
    cancel() {
      client.cancelSession();
      client.kill("SIGTERM");
    },
    respondPermission(id, decision) {
      client.respondPermission(id, decision);
    },
  };
}
