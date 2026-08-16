import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { renderTemplate, safeName } from "./template.js";
import {
  listMediaInDir,
  harvestFromText,
  harvestFromSession,
} from "./media.js";
import { isUuid } from "./config.js";
import { permissionModeToCliArgs, normalizePermissionMode } from "./permissions.js";
import { normalizeReasoningEffort } from "./models.js";
import { sandboxToCliArgs } from "./sandbox.js";
import { agentToCliArgs } from "./agents.js";
import { providerToEnv, providerToAgentCliArgs } from "./providers.js";
import { assertBudgetAllows, recordRunUsage } from "./budget.js";
import {
  createRunBudgetTracker,
  costFromEndEvent,
} from "./budget-runtime.js";
import {
  registerBackgroundJob,
  finishBackgroundJob,
} from "./background.js";
import {
  getConnection,
  uploadFileViaScp,
  buildRemoteGrokCommand,
  spawnRemoteCommand,
} from "./ssh.js";
import {
  buildAcpArgs,
  needsInteractiveApprovals,
  pickAllowOption,
  runAcpTurn,
} from "./acp-client.js";
import { resolveRunCwd } from "./worktrees.js";

/**
 * Resolve image references to absolute existing paths under uploads (or abs).
 */
export function resolveImages(images, uploadsDir) {
  const uploadsRoot = path.resolve(uploadsDir);
  const out = [];
  for (const ref of images || []) {
    if (ref == null || ref === "") continue;
    const s = String(ref);
    let candidate;
    let mustStayInUploads = false;

    if (s.includes("/uploads/")) {
      // UI url form: /files/uploads/<name> (absolute-looking but not a real path)
      candidate = path.join(uploadsDir, path.basename(s.split("/uploads/").pop()));
      mustStayInUploads = true;
    } else if (path.isAbsolute(s)) {
      candidate = s;
    } else {
      candidate = path.join(uploadsDir, path.basename(s));
      mustStayInUploads = true;
    }

    const resolved = path.resolve(candidate);
    if (mustStayInUploads) {
      if (
        resolved !== uploadsRoot &&
        !resolved.startsWith(uploadsRoot + path.sep)
      ) {
        throw new Error(`invalid image ref: ${s}`);
      }
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`image not found: ${s}`);
    }
    out.push(resolved);
  }
  return out;
}

/**
 * Resolve the project working directory for a grok run.
 * Must be an absolute path to an existing directory.
 */
export function resolveProjectCwd(cwd, fallback) {
  const raw = String(cwd || fallback || "").trim();
  if (!raw) {
    const err = new Error("Project folder is required.");
    err.status = 400;
    throw err;
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`Project folder not found: ${resolved}`);
    err.status = 400;
    throw err;
  }
  if (!fs.statSync(resolved).isDirectory()) {
    const err = new Error(`Project path is not a directory: ${resolved}`);
    err.status = 400;
    throw err;
  }
  return resolved;
}

export function buildPrompt({
  wf,
  prompt,
  staged,
  aspect_ratio,
  duration,
  resolution,
  workflow_name,
  workflow_args,
  cwd,
}) {
  const imageList = staged.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const body = renderTemplate(wf.promptTemplate, {
    prompt: String(prompt).trim() || "(no extra instruction)",
    images: imageList,
    aspect_ratio: aspect_ratio || "auto",
    duration: String(duration || "6"),
    resolution: resolution || "480p",
    workflow_name: workflow_name || "",
    workflow_args:
      typeof workflow_args === "string"
        ? workflow_args
        : JSON.stringify(workflow_args || {}),
    cwd: cwd || "",
  });
  const attach = staged.map((p) => `@${p}`).join("\n");
  return [attach, body].filter(Boolean).join("\n\n");
}

/**
 * Build full grok CLI argv from run options (pure — no I/O).
 * Used by startRun and unit tests.
 */
export function buildGrokArgs({
  promptFile,
  workDir,
  model,
  permissionMode,
  yolo,
  reasoningEffort,
  maxTurns,
  sandbox,
  allowRules,
  denyRules,
  agent,
  agentOptions,
  resumeGrokSessionId,
  disableWebSearch,
  noSubagents,
  disallowedTools,
  tools,
  rules,
  verbatim,
  provider,
}) {
  if (!promptFile) {
    const err = new Error("promptFile is required");
    err.status = 400;
    throw err;
  }
  if (!workDir) {
    const err = new Error("workDir is required");
    err.status = 400;
    throw err;
  }

  const args = [
    "--prompt-file",
    promptFile,
    "--cwd",
    workDir,
    "--output-format",
    "streaming-json",
  ];

  // Permission: explicit mode wins; legacy yolo=true → bypass
  let mode = permissionMode;
  if (mode == null && yolo === true) mode = "bypassPermissions";
  if (mode == null && yolo === false) mode = "default";
  if (mode != null) {
    const perm = permissionModeToCliArgs(mode);
    args.push(...perm.args);
  } else {
    // Studio default historically was always-approve
    args.push("--always-approve");
  }

  if (model) args.push("-m", String(model));

  const effort = normalizeReasoningEffort(reasoningEffort, null);
  if (effort) args.push("--reasoning-effort", effort);

  if (maxTurns != null && maxTurns !== "") {
    const n = Number(maxTurns);
    if (!Number.isInteger(n) || n < 1) {
      const err = new Error("maxTurns must be a positive integer");
      err.status = 400;
      throw err;
    }
    args.push("--max-turns", String(n));
  }

  const sand = sandboxToCliArgs({
    sandbox,
    allowRules: allowRules || [],
    denyRules: denyRules || [],
  });
  args.push(...sand.args);

  if (agent) {
    args.push(...agentToCliArgs(agent, agentOptions || {}));
  }

  if (resumeGrokSessionId) {
    args.push("--resume", String(resumeGrokSessionId));
  }

  if (disableWebSearch) args.push("--disable-web-search");
  if (noSubagents) args.push("--no-subagents");

  if (disallowedTools) {
    const list = Array.isArray(disallowedTools)
      ? disallowedTools.filter(Boolean).join(",")
      : String(disallowedTools).trim();
    if (list) args.push("--disallowed-tools", list);
  }
  if (tools) {
    const list = Array.isArray(tools)
      ? tools.filter(Boolean).join(",")
      : String(tools).trim();
    if (list) args.push("--tools", list);
  }
  if (rules) {
    const r = String(rules).trim();
    if (r) args.push("--rules", r);
  }
  if (verbatim) args.push("--verbatim");

  // Provider routing is env-only (see providerToEnv); keep for signature completeness
  void provider;

  return args;
}

/**
 * Normalize a headless `--output-format streaming-json` event.
 *
 * Verified against grok 0.2.117, which emits:
 *   tool_call          { toolCallId, title, kind, status, toolName, rawInput, … }
 *   tool_call_update   { toolCallId, status, content/rawOutput }  — no title
 *   available_commands { tools: [...], commands: [...] }   ~15KB, ~4 per run
 *
 * Studio's stream contract is {name, input} / {name, result}, which is also
 * what the ACP transport produces — so both transports render identically.
 *
 * @param toolNames Map of toolCallId → name, carried across a run so that
 *   updates (which omit the title) can be labelled with their call's tool.
 * @returns the normalized event, or null when it should not be kept.
 */
export function normalizeStreamEvent(evt, toolNames = new Map()) {
  if (!evt || typeof evt !== "object") return evt;

  // Pure capability advertisement: large, repeated, and unused by the UI.
  if (evt.type === "available_commands") return null;

  if (evt.type === "tool_call" || evt.type === "tool") {
    const name = evt.name || evt.title || evt.toolName || "tool";
    if (evt.toolCallId) toolNames.set(evt.toolCallId, name);
    return {
      ...evt,
      type: "tool_call",
      name,
      input: evt.input ?? evt.rawInput ?? evt.args ?? evt.arguments ?? null,
    };
  }

  if (evt.type === "tool_call_update" || evt.type === "tool_result") {
    // An in-flight update carries `content: []`; report its status rather than
    // rendering an empty array as the result payload.
    const content =
      Array.isArray(evt.content) && evt.content.length === 0
        ? null
        : evt.content;
    return {
      ...evt,
      type: "tool_result",
      name:
        evt.name ||
        evt.title ||
        evt.toolName ||
        toolNames.get(evt.toolCallId) ||
        "tool",
      result: evt.result ?? evt.rawOutput ?? content ?? evt.status ?? null,
      status: evt.status || "completed",
    };
  }

  return evt;
}

/**
 * Apply mid-run budget + turn accounting to a streaming event.
 * Returns { kill: boolean, reason?: string, evt }.
 */
export function processRunEventForBudget(budget, evt) {
  if (!evt || !budget) return { kill: false, evt };
  if (evt.type === "tool_call" || evt.type === "tool") {
    const r = budget.onTurn();
    if (!r.allow) return { kill: true, reason: r.reason, evt };
  }
  if (evt.type === "end") {
    const cost = costFromEndEvent(evt);
    if (cost != null) budget.onActualCost(cost);
  }
  return { kill: false, evt };
}

export function createRunManager(cfg, log) {
  /** @type {Map<string, any>} */
  const active = new Map();

  function countRunning() {
    let n = 0;
    for (const s of active.values()) {
      if (s.status === "running") n++;
    }
    return n;
  }

  function writeMeta(runDir, meta) {
    // Called from child-process close handlers, where a throw is an uncaught
    // exception that takes the server down. The run directory can legitimately
    // vanish underneath us — the documented rollback is to delete data/runs —
    // so failing to persist must degrade, not crash.
    try {
      fs.writeFileSync(
        path.join(runDir, "meta.json"),
        JSON.stringify(meta, null, 2),
      );
      return true;
    } catch (e) {
      log.error("run.meta_write_failed", { runDir, message: e.message });
      return false;
    }
  }

  function listRuns(limit = 50) {
    if (!fs.existsSync(cfg.runs)) return [];
    return fs
      .readdirSync(cfg.runs)
      .filter((id) => fs.existsSync(path.join(cfg.runs, id, "meta.json")))
      .map((id) => {
        const raw = fs.readFileSync(path.join(cfg.runs, id, "meta.json"), "utf8");
        return JSON.parse(raw);
      })
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, limit);
  }

  function getRun(id) {
    if (!isUuid(id)) return null;
    const dir = path.join(cfg.runs, id);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const logPath = path.join(dir, "events.jsonl");
    const events = [];
    if (fs.existsSync(logPath)) {
      for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        events.push(JSON.parse(line));
      }
    }
    return {
      meta,
      events,
      outputs: listMediaInDir(path.join(dir, "outputs"), cfg.data),
      live: active.has(id) && active.get(id).status === "running",
    };
  }

  /**
   * Mark on-disk runs stuck as "running" without a live process as aborted.
   * Called on manager start and via API for crash recovery.
   */
  function reconcileStaleRuns({ maxAgeMs = 0 } = {}) {
    if (!fs.existsSync(cfg.runs)) return { reconciled: [] };
    const reconciled = [];
    const now = Date.now();
    for (const id of fs.readdirSync(cfg.runs)) {
      if (!isUuid(id)) continue;
      if (active.has(id)) continue;
      const metaPath = path.join(cfg.runs, id, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.status !== "running") continue;
      if (maxAgeMs > 0 && meta.startedAt && now - meta.startedAt < maxAgeMs) {
        continue;
      }
      meta.status = "aborted";
      meta.error = meta.error || "Process lost (server restart or crash)";
      meta.finishedAt = now;
      meta.exitCode = meta.exitCode ?? -1;
      writeMeta(path.join(cfg.runs, id), meta);
      reconciled.push({ id, previousStatus: "running", status: "aborted" });
      log.warn("run.reconcile", { id, reason: "stale_running" });
    }
    return { reconciled };
  }

  function isLive(id) {
    const s = active.get(id);
    return Boolean(s && s.status === "running" && s.proc);
  }

  function getActiveRunForSession(chatSessionId) {
    if (!chatSessionId) return null;
    for (const s of active.values()) {
      if (s.status !== "running") continue;
      if (s.meta?.chatSessionId === chatSessionId) return s.meta;
    }
    return null;
  }

  // Recover stuck metas from prior process crashes
  reconcileStaleRuns();

  function startRun({
    wf,
    prompt,
    images,
    aspect_ratio,
    duration,
    resolution,
    workflow_name,
    workflow_args,
    model,
    yolo,
    permissionMode,
    reasoningEffort,
    maxTurns,
    maxBudgetUsd,
    sandbox,
    allowRules,
    denyRules,
    agent,
    disableWebSearch,
    noSubagents,
    provider,
    background,
    sshConnectionId,
    cwd,
    resumeGrokSessionId,
    chatSessionId,
    worktree,
    worktreeName,
    interactive,
    onEvent,
    onFinish,
  }) {
    if (countRunning() >= cfg.maxConcurrentRuns) {
      const err = new Error(
        `max concurrent runs (${cfg.maxConcurrentRuns}) reached`,
      );
      err.status = 429;
      throw err;
    }

    // Budget gate (daily)
    assertBudgetAllows(cfg.data, {
      maxBudgetUsd,
      sessionId: chatSessionId || null,
      estimatedTurns: maxTurns != null ? Math.min(Number(maxTurns), 5) : 1,
    });

    const sshConn = sshConnectionId
      ? getConnection(cfg.data, sshConnectionId)
      : null;
    if (sshConnectionId && !sshConn) {
      const err = new Error(`SSH connection not found: ${sshConnectionId}`);
      err.status = 400;
      throw err;
    }

    // Local project cwd required unless SSH remote (remote uses remoteCwd)
    let workDir;
    let worktreeInfo = null;
    if (sshConn) {
      workDir = sshConn.remoteCwd || "~";
    } else {
      const projectRoot = resolveProjectCwd(cwd, cfg.defaultProjectCwd);
      if (worktree) {
        const resolved = resolveRunCwd({
          projectCwd: projectRoot,
          worktree: true,
          worktreeName: worktreeName || chatSessionId?.slice(0, 8),
        });
        workDir = resolved.cwd;
        worktreeInfo = resolved.worktree;
      } else {
        workDir = projectRoot;
      }
    }

    let absImages;
    try {
      absImages = resolveImages(images, cfg.uploads);
    } catch (e) {
      e.status = 400;
      throw e;
    }

    if (wf.requiresImages > 0 && absImages.length < wf.requiresImages) {
      const err = new Error(
        `Workflow "${wf.name}" needs at least ${wf.requiresImages} image(s); got ${absImages.length}.`,
      );
      err.status = 400;
      throw err;
    }

    if (!String(prompt || "").trim() && wf.id !== "rhai-workflow") {
      const err = new Error("Prompt is required.");
      err.status = 400;
      throw err;
    }

    if (wf.id === "rhai-workflow" && !String(workflow_name || "").trim()) {
      const err = new Error("workflow_name is required for Rhai workflow runs.");
      err.status = 400;
      throw err;
    }

    let resolvedMode = permissionMode;
    if (resolvedMode == null && yolo !== undefined) {
      resolvedMode = yolo === false ? "default" : "bypassPermissions";
    }
    if (resolvedMode != null) {
      resolvedMode = normalizePermissionMode(resolvedMode);
    }

    const id = randomUUID();
    const runDir = path.join(cfg.runs, id);
    const runOut = path.join(runDir, "outputs");
    fs.mkdirSync(runOut, { recursive: true });

    const staged = [];
    for (const img of absImages) {
      const dest = path.join(runDir, safeName(path.basename(img)));
      fs.copyFileSync(img, dest);
      staged.push(dest);
    }

    const finalPrompt = buildPrompt({
      wf,
      prompt,
      staged,
      aspect_ratio,
      duration,
      resolution,
      workflow_name,
      workflow_args,
      cwd: workDir,
    });
    const promptFile = path.join(runDir, "prompt.txt");
    fs.writeFileSync(promptFile, finalPrompt, "utf8");

    const agentOptions = {
      projectCwd: sshConn ? null : workDir,
      home: cfg.home,
      dataDir: cfg.data,
    };

    const localArgs = buildGrokArgs({
      promptFile,
      workDir,
      model,
      permissionMode: resolvedMode,
      yolo,
      reasoningEffort,
      maxTurns,
      sandbox,
      allowRules,
      denyRules,
      agent,
      agentOptions,
      resumeGrokSessionId,
      disableWebSearch,
      noSubagents,
      provider,
    });

    const meta = {
      id,
      workflowId: wf.id,
      workflowName: wf.name,
      category: wf.category || null,
      prompt: String(prompt || ""),
      cwd: workDir,
      images: staged,
      startedAt: Date.now(),
      status: "running",
      sessionId: null,
      chatSessionId: chatSessionId || null,
      resumeGrokSessionId: resumeGrokSessionId || null,
      exitCode: null,
      model: model || null,
      permissionMode: resolvedMode || null,
      reasoningEffort: reasoningEffort || null,
      maxTurns: maxTurns != null ? Number(maxTurns) : null,
      maxBudgetUsd: maxBudgetUsd != null ? Number(maxBudgetUsd) : null,
      sandbox: sandbox || null,
      agent: agent || null,
      background: Boolean(background),
      sshConnectionId: sshConnectionId || null,
      worktree: worktreeInfo
        ? {
            name: worktreeInfo.name,
            path: worktreeInfo.path,
            branch: worktreeInfo.branch,
          }
        : null,
      transport: null,
      grokBin: cfg.grokBin,
      args: localArgs,
      error: null,
      outputs: [],
      turnCount: 0,
    };
    writeMeta(runDir, meta);

    const logStream = fs.createWriteStream(path.join(runDir, "events.jsonl"), {
      flags: "a",
    });

    const budget = createRunBudgetTracker({
      dataDir: cfg.data,
      maxBudgetUsd,
      sessionId: chatSessionId || null,
    });

    const state = {
      id,
      proc: null,
      acpHandle: null,
      clients: new Set(),
      status: "running",
      finalized: false,
      spawnError: null,
      events: [],
      textAcc: "",
      thoughtAcc: "",
      turnCount: 0,
      startedMs: Date.now(),
      runDir,
      runOut,
      meta,
      logStream,
      background: Boolean(background),
      budget,
      pendingPermissions: new Map(),
      /** toolCallId → tool name, so updates can be labelled */
      toolNames: new Map(),
    };
    active.set(id, state);

    const broadcast = (evt) => {
      const stamped = { ...evt, seq: state.events.length + 1 };
      state.events.push(stamped);
      if (!logStream.destroyed && !logStream.writableEnded) {
        logStream.write(JSON.stringify(stamped) + "\n");
      }
      if (typeof onEvent === "function") onEvent(stamped);
      const payload = `data: ${JSON.stringify(stamped)}\n\n`;
      for (const res of [...state.clients]) {
        if (res.writableEnded || res.destroyed) {
          state.clients.delete(res);
          continue;
        }
        const ok = res.write(payload);
        if (ok === false) {
          res.once("drain", () => {});
        }
      }
    };

    const killForBudget = (reason) => {
      meta.status = "budget_exceeded";
      meta.error = reason;
      meta.finishedAt = Date.now();
      writeMeta(runDir, meta);
      broadcast({
        type: "studio",
        event: "budget_exceeded",
        message: reason,
        budget: budget.status(),
      });
      if (state.acpHandle) {
        state.acpHandle.cancel();
      } else if (state.proc) {
        state.proc.kill("SIGTERM");
        setTimeout(() => {
          if (state.proc && !state.proc.killed) state.proc.kill("SIGKILL");
        }, 2000).unref();
      }
    };

    const handleStreamEvent = (raw) => {
      const evt = normalizeStreamEvent(raw, state.toolNames);
      if (evt === null) return { kill: false, evt: null };
      if (evt.type === "text" && evt.data) state.textAcc += evt.data;
      if (evt.type === "thought" && evt.data) state.thoughtAcc += evt.data;
      if (evt.type === "tool_call" || evt.type === "tool") {
        state.turnCount += 1;
        meta.turnCount = state.turnCount;
      }
      if (evt.type === "end" && evt.sessionId) {
        meta.sessionId = evt.sessionId;
      }
      if (evt.type === "studio" && evt.event === "acp_session" && evt.sessionId) {
        meta.sessionId = evt.sessionId;
      }
      if (evt.type === "studio" && evt.event === "permission_request") {
        state.pendingPermissions.set(String(evt.id), evt);
      }
      if (
        raw?.type === "auto_compact" ||
        raw?.subtype === "compact_boundary" ||
        (raw?.type === "system" && raw?.subtype === "compact_boundary")
      ) {
        broadcast({
          type: "studio",
          event: "compact",
          trigger: "auto",
          tokensBefore: raw.preTokens || raw.tokensBefore || null,
          tokensAfter: raw.tokensAfter || null,
        });
      }
      const budgetCheck = processRunEventForBudget(budget, evt);
      broadcast(evt);
      if (budgetCheck.kill) {
        killForBudget(budgetCheck.reason);
      }
      return budgetCheck;
    };

    broadcast({
      type: "studio",
      event: "started",
      id,
      workflow: wf.name,
      promptPreview: String(prompt || "").slice(0, 200),
      images: staged,
      permissionMode: meta.permissionMode,
      model: meta.model,
      background: meta.background,
      sshConnectionId: meta.sshConnectionId,
    });

    if (background) {
      registerBackgroundJob(cfg.data, {
        runId: id,
        sessionId: chatSessionId,
        title: wf.name,
        promptPreview: String(prompt || ""),
      });
    }

    log.info("run.start", {
      id,
      workflow: wf.id,
      cwd: workDir,
      images: staged.length,
      permissionMode: meta.permissionMode,
      background: meta.background,
      ssh: Boolean(sshConn),
      worktree: Boolean(worktreeInfo),
    });

    const { env: spawnEnv } = providerToEnv(provider || {}, {
      ...process.env,
      NO_COLOR: "1",
    });

    // A spawn failure emits both "error" and "close"; ACP resolves and may also
    // be cancelled. Finalize exactly once or we write to a closed log stream and
    // double-charge the budget ledger.
    const finalizeRun = (code, signal) => {
      if (state.finalized) return;
      state.finalized = true;

      const seenSources = new Set();
      const sessionCwd = sshConn ? cfg.root : meta.cwd || cfg.root;
      const harvested = [
        ...harvestFromText(state.textAcc, runOut, seenSources),
        ...harvestFromSession({
          sessionsRoot: cfg.sessionsRoot,
          cwd: sessionCwd,
          sessionId: meta.sessionId,
          sinceMs: state.startedMs - 2000,
          destDir: runOut,
          seenSources,
        }),
      ];

      for (const f of harvested) {
        const gallery = path.join(
          cfg.outputs,
          `${id.slice(0, 8)}-${safeName(path.basename(f))}`,
        );
        if (!fs.existsSync(gallery)) fs.copyFileSync(f, gallery);
      }

      if (meta.status === "budget_exceeded") {
        // keep
      } else if (state.spawnError) {
        meta.status = "error";
      } else if (signal === "SIGTERM" || signal === "SIGKILL") {
        meta.status = "cancelled";
      } else {
        meta.status = code === 0 ? "completed" : "failed";
      }
      meta.exitCode = code;
      meta.signal = signal || null;
      meta.finishedAt = Date.now();
      meta.outputs = listMediaInDir(runOut, cfg.data);
      meta.turnCount = state.turnCount;
      meta.budget = budget.status();
      writeMeta(runDir, meta);

      const costUsd = budget.status().actualCostUsd;
      recordRunUsage(cfg.data, {
        runId: id,
        sessionId: chatSessionId || null,
        turns: Math.max(1, state.turnCount || 1),
        costUsd: costUsd != null ? costUsd : undefined,
        status: meta.status,
      });

      if (state.background) {
        finishBackgroundJob(cfg.data, id, {
          status: meta.status,
          summary: state.textAcc.slice(0, 280),
        });
      }

      log.info("run.finish", {
        id,
        status: meta.status,
        exitCode: code,
        outputs: meta.outputs.length,
        sessionId: meta.sessionId,
        turns: meta.turnCount,
        transport: meta.transport,
      });

      broadcast({
        type: "studio",
        event: "finished",
        exitCode: code,
        signal: signal || null,
        status: meta.status,
        outputs: meta.outputs,
        sessionId: meta.sessionId,
        turnCount: meta.turnCount,
        budget: meta.budget,
      });

      state.status = meta.status;
      state.proc = null;
      state.acpHandle = null;
      if (typeof onFinish === "function") {
        onFinish({
          meta,
          text: state.textAcc,
          thoughts: state.thoughtAcc,
          events: state.events,
        });
      }
      finishClients(state, 400);
    };

    // Interactive permission modes → ACP (session/request_permission).
    // Headless streaming-json cannot prompt; stdin was ignored.
    const useAcp =
      !sshConn &&
      (interactive === true ||
        (interactive !== false && needsInteractiveApprovals(resolvedMode)));

    if (useAcp) {
      meta.transport = "acp";
      // record what is actually spawned, not an approximation of it
      meta.args = buildAcpArgs({
        alwaysApprove:
          resolvedMode === "bypassPermissions" || resolvedMode == null,
        model,
        extraArgs: providerToAgentCliArgs(provider),
      });
      writeMeta(runDir, meta);
      broadcast({
        type: "studio",
        event: "transport",
        transport: "acp",
        permissionMode: resolvedMode,
      });

      const handle = runAcpTurn({
        grokBin: cfg.grokBin,
        cwd: workDir,
        env: spawnEnv,
        model: model || undefined,
        permissionMode: resolvedMode || "default",
        sandbox,
        provider,
        prompt: finalPrompt,
        attachments: staged.map((p) => ({ path: p, name: path.basename(p) })),
        resumeSessionId: resumeGrokSessionId || undefined,
        onEvent: (evt) => {
          handleStreamEvent(evt);
        },
      });
      state.acpHandle = handle;
      // Synthetic proc-like for cancel compatibility
      state.proc = {
        kill(sig) {
          handle.cancel();
          handle.client.kill(sig || "SIGTERM");
        },
        killed: false,
      };

      handle.done.then(
        () => {
          if (meta.status === "budget_exceeded") {
            finalizeRun(1, null);
          } else {
            finalizeRun(0, null);
          }
        },
        (err) => {
          if (meta.status !== "budget_exceeded" && meta.status !== "cancelled") {
            meta.error = err.message;
            broadcast({ type: "error", message: err.message });
          }
          finalizeRun(1, null);
        },
      );

      return { id, meta };
    }

    meta.transport = "headless";
    writeMeta(runDir, meta);

    let proc;
    if (sshConn) {
      // Upload prompt to remote tmp and run grok there
      const remotePrompt = `/tmp/heir-studio-prompt-${id}.txt`;
      try {
        uploadFileViaScp(sshConn, promptFile, remotePrompt);
      } catch (e) {
        const msg = (e.stderr || e.message || String(e)).toString().trim();
        meta.status = "error";
        meta.error = `SSH upload failed: ${msg}`;
        meta.finishedAt = Date.now();
        writeMeta(runDir, meta);
        state.status = "error";
        state.finalized = true;
        broadcast({ type: "error", message: meta.error });
        if (!logStream.writableEnded) logStream.end();
        active.delete(id);
        if (background) {
          finishBackgroundJob(cfg.data, id, {
            status: "error",
            summary: meta.error,
          });
        }
        const err = new Error(meta.error);
        err.status = 502;
        throw err;
      }
      const remoteArgs = buildGrokArgs({
        promptFile: remotePrompt,
        workDir: sshConn.remoteCwd || "~",
        model,
        permissionMode: resolvedMode,
        yolo,
        reasoningEffort,
        maxTurns,
        sandbox,
        allowRules,
        denyRules,
        agent,
        agentOptions: {},
        resumeGrokSessionId,
        disableWebSearch,
        noSubagents,
        provider,
      });
      meta.args = remoteArgs;
      writeMeta(runDir, meta);
      const remoteCmd = buildRemoteGrokCommand(sshConn, remoteArgs);
      proc = spawnRemoteCommand(sshConn, remoteCmd);
    } else {
      proc = spawn(cfg.grokBin, localArgs, {
        cwd: workDir,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    state.proc = proc;

    let stdoutBuf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          broadcast({ type: "studio", event: "raw", data: line });
          continue;
        }
        handleStreamEvent(evt);
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      broadcast({ type: "studio", event: "stderr", data: chunk });
    });

    proc.on("error", (err) => {
      log.error("run.spawn_error", { id, message: err.message });
      state.spawnError = err;
      meta.error = err.message;
      broadcast({ type: "error", message: err.message });
      // finalizeRun does the meta write, ledger entry, background job and client
      // teardown; it is idempotent, so the trailing "close" event is a no-op.
      finalizeRun(null, null);
    });

    proc.on("close", (code, signal) => {
      if (stdoutBuf.trim()) {
        try {
          const evt = JSON.parse(stdoutBuf.trim());
          handleStreamEvent(evt);
        } catch {
          broadcast({ type: "studio", event: "raw", data: stdoutBuf.trim() });
        }
      }
      finalizeRun(code, signal);
    });

    return { id, meta };
  }

  function finishClients(state, delayMs) {
    const close = () => {
      for (const res of state.clients) {
        res.end();
      }
      state.clients.clear();
      if (!state.logStream.writableEnded) state.logStream.end();
      active.delete(state.id);
    };
    if (delayMs && delayMs > 0) setTimeout(close, delayMs).unref();
    else close();
  }

  function attachStream(id, res, { after = 0 } = {}) {
    if (!isUuid(id)) return { error: "invalid run id", status: 400 };
    const afterSeq = Math.max(0, Number(after) || 0);
    const state = active.get(id);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const replay = (events) => {
      events.forEach((evt, i) => {
        const seq = evt.seq || i + 1;
        if (seq <= afterSeq) return;
        res.write(`data: ${JSON.stringify({ ...evt, seq })}\n\n`);
      });
    };

    if (state) {
      replay(state.events);
      state.clients.add(res);
      res.on("close", () => state.clients.delete(res));
      return { ok: true, live: true, after: afterSeq };
    }

    const detail = getRun(id);
    if (!detail) return { error: "not found", status: 404 };
    replay(detail.events);
    res.write(
      `data: ${JSON.stringify({
        type: "studio",
        event: "finished",
        replay: true,
        status: detail.meta.status,
        exitCode: detail.meta.exitCode,
        outputs: detail.outputs,
        sessionId: detail.meta.sessionId,
      })}\n\n`,
    );
    res.end();
    return { ok: true, live: false };
  }

  function cancel(id) {
    if (!isUuid(id)) {
      const err = new Error("invalid run id");
      err.status = 400;
      throw err;
    }
    const state = active.get(id);
    if (!state?.proc && !state?.acpHandle) {
      const err = new Error("not running");
      err.status = 404;
      throw err;
    }
    log.info("run.cancel", { id });
    state.meta.status = "cancelled";
    if (state.acpHandle) {
      state.acpHandle.cancel();
    }
    if (state.proc) {
      state.proc.kill("SIGTERM");
      setTimeout(() => {
        if (state.proc && !state.proc.killed) {
          state.proc.kill("SIGKILL");
        }
      }, 3000).unref();
    }
    return { ok: true };
  }

  /**
   * Respond to a pending ACP permission request for a live run.
   */
  function respondPermission(runId, permissionId, decision) {
    if (!isUuid(runId)) {
      const err = new Error("invalid run id");
      err.status = 400;
      throw err;
    }
    const state = active.get(runId);
    if (!state?.acpHandle) {
      const err = new Error("run is not an interactive ACP run or not live");
      err.status = 404;
      throw err;
    }
    if (decision?.deny || decision?.cancelled) {
      state.acpHandle.respondPermission(permissionId, {
        outcome: "cancelled",
        cancelled: true,
      });
    } else {
      const options =
        state.pendingPermissions.get(String(permissionId))?.options || [];
      const optionId =
        decision?.optionId ||
        decision?.option ||
        pickAllowOption(options)?.optionId ||
        options[0]?.optionId;
      if (!optionId) {
        const err = new Error("optionId required to approve");
        err.status = 400;
        throw err;
      }
      state.acpHandle.respondPermission(permissionId, {
        outcome: "selected",
        optionId,
      });
    }
    state.pendingPermissions.delete(String(permissionId));
    const payload = {
      type: "studio",
      event: "permission_resolved",
      id: permissionId,
      decision,
      seq: state.events.length + 1,
    };
    state.events.push(payload);
    if (!state.logStream.destroyed && !state.logStream.writableEnded) {
      state.logStream.write(JSON.stringify(payload) + "\n");
    }
    for (const res of state.clients) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    }
    return { ok: true };
  }

  return {
    active,
    countRunning,
    listRuns,
    getRun,
    startRun,
    attachStream,
    cancel,
    respondPermission,
    reconcileStaleRuns,
    isLive,
    getActiveRunForSession,
  };
}
