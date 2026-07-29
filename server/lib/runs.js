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
import { providerToEnv } from "./providers.js";
import { assertBudgetAllows, recordRunUsage } from "./budget.js";
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
    fs.writeFileSync(
      path.join(runDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
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
    };
  }

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
    if (sshConn) {
      workDir = sshConn.remoteCwd || "~";
    } else {
      workDir = resolveProjectCwd(cwd, cfg.defaultProjectCwd);
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
      workDir: sshConn ? workDir : workDir,
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

    const state = {
      id,
      proc: null,
      clients: new Set(),
      status: "running",
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
    };
    active.set(id, state);

    const broadcast = (evt) => {
      state.events.push(evt);
      if (!logStream.destroyed) {
        logStream.write(JSON.stringify(evt) + "\n");
      }
      if (typeof onEvent === "function") onEvent(evt);
      const payload = `data: ${JSON.stringify(evt)}\n\n`;
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
    });

    const { env: spawnEnv } = providerToEnv(provider || {}, {
      ...process.env,
      NO_COLOR: "1",
    });

    let proc;
    if (sshConn) {
      // Upload prompt to remote tmp and run grok there
      const remotePrompt = `/tmp/grok-studio-prompt-${id}.txt`;
      try {
        uploadFileViaScp(sshConn, promptFile, remotePrompt);
      } catch (e) {
        const msg = (e.stderr || e.message || String(e)).toString().trim();
        meta.status = "error";
        meta.error = `SSH upload failed: ${msg}`;
        meta.finishedAt = Date.now();
        writeMeta(runDir, meta);
        state.status = "error";
        broadcast({ type: "error", message: meta.error });
        if (!logStream.destroyed) logStream.end();
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
        if (evt.type === "text" && evt.data) state.textAcc += evt.data;
        if (evt.type === "thought" && evt.data) state.thoughtAcc += evt.data;
        if (evt.type === "tool_call" || evt.type === "tool") {
          state.turnCount += 1;
          meta.turnCount = state.turnCount;
        }
        if (evt.type === "end" && evt.sessionId) {
          meta.sessionId = evt.sessionId;
        }
        broadcast(evt);
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      broadcast({ type: "studio", event: "stderr", data: chunk });
    });

    proc.on("error", (err) => {
      log.error("run.spawn_error", { id, message: err.message });
      broadcast({ type: "error", message: err.message });
      meta.status = "error";
      meta.error = err.message;
      meta.finishedAt = Date.now();
      writeMeta(runDir, meta);
      state.status = "error";
      if (state.background) {
        finishBackgroundJob(cfg.data, id, {
          status: "error",
          summary: err.message,
        });
      }
      finishClients(state, null);
    });

    proc.on("close", (code, signal) => {
      if (stdoutBuf.trim()) {
        try {
          const evt = JSON.parse(stdoutBuf.trim());
          if (evt.type === "text" && evt.data) state.textAcc += evt.data;
          if (evt.type === "thought" && evt.data) state.thoughtAcc += evt.data;
          if (evt.type === "end" && evt.sessionId) meta.sessionId = evt.sessionId;
          broadcast(evt);
        } catch {
          broadcast({ type: "studio", event: "raw", data: stdoutBuf.trim() });
        }
      }

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

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        meta.status = "cancelled";
      } else {
        meta.status = code === 0 ? "completed" : "failed";
      }
      meta.exitCode = code;
      meta.signal = signal || null;
      meta.finishedAt = Date.now();
      meta.outputs = listMediaInDir(runOut, cfg.data);
      meta.turnCount = state.turnCount;
      writeMeta(runDir, meta);

      recordRunUsage(cfg.data, {
        runId: id,
        sessionId: chatSessionId || null,
        turns: Math.max(1, state.turnCount || 1),
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
      });

      state.status = meta.status;
      state.proc = null;
      if (typeof onFinish === "function") {
        onFinish({
          meta,
          text: state.textAcc,
          thoughts: state.thoughtAcc,
          events: state.events,
        });
      }
      finishClients(state, 400);
    });

    return { id, meta };
  }

  function finishClients(state, delayMs) {
    const close = () => {
      for (const res of state.clients) {
        res.end();
      }
      state.clients.clear();
      state.logStream.end();
      active.delete(state.id);
    };
    if (delayMs && delayMs > 0) setTimeout(close, delayMs);
    else close();
  }

  function attachStream(id, res) {
    if (!isUuid(id)) return { error: "invalid run id", status: 400 };
    const state = active.get(id);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (state) {
      for (const evt of state.events) {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      state.clients.add(res);
      res.on("close", () => state.clients.delete(res));
      return { ok: true, live: true };
    }

    const detail = getRun(id);
    if (!detail) return { error: "not found", status: 404 };
    for (const evt of detail.events) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
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
    if (!state?.proc) {
      const err = new Error("not running");
      err.status = 404;
      throw err;
    }
    log.info("run.cancel", { id });
    state.proc.kill("SIGTERM");
    // escalate if needed
    setTimeout(() => {
      if (state.proc && !state.proc.killed) {
        state.proc.kill("SIGKILL");
      }
    }, 3000);
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
  };
}
