import express from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { createConfig, isLoopback, isUuid } from "./lib/config.js";
import { loadCatalog, listRhaiWorkflows } from "./lib/catalog.js";
import {
  listMediaInDir,
  listAttachmentsInDir,
  isAttachmentUpload,
} from "./lib/media.js";
import { safeName } from "./lib/template.js";
import { createRunManager } from "./lib/runs.js";
import { getProject, setProject } from "./lib/projects.js";
import { listDirectories, listEntries, readFileText } from "./lib/fs-browse.js";
import {
  status as gitStatus,
  diff as gitDiff,
  commit as gitCommit,
  push as gitPush,
} from "./lib/git-ops.js";
import {
  registerDevice,
  removeDevice,
  attachPushHooks,
} from "./lib/push.js";
import {
  listSessions,
  getSession,
  createSession,
  updateSession,
  setActiveSession,
  deleteSession,
  appendUserMessage,
  appendAssistantPlaceholder,
  attachRunToAssistantMessage,
  finalizeAssistantMessage,
  failAssistantMessage,
  restoreSessionFromCheckpoint,
  searchMessageHistory,
  listRecentUserPrompts,
  setSessionActiveRun,
  findRunningAssistant,
} from "./lib/sessions.js";
import { createLogger } from "./lib/logger.js";
import {
  PERMISSION_MODES,
  PERMISSION_META,
  cyclePermissionMode,
  normalizePermissionMode,
} from "./lib/permissions.js";
import { listModels, selectModelForTask } from "./lib/models.js";
import {
  loadKeybindings,
  saveKeybindings,
  resolveKeybindingsPath,
  KEYBINDING_CONTEXTS,
  HARDCODED_ACTIONS,
  DEFAULT_KEYBINDINGS,
} from "./lib/keybindings.js";
import { loadSettings, saveSettings } from "./lib/settings.js";
import { listAgents, getAgent, writeAgent } from "./lib/agents.js";
import {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
} from "./lib/ssh.js";
import {
  createCheckpoint,
  listCheckpoints,
  getCheckpoint,
  loadCheckpointForRestore,
  deleteCheckpoint,
} from "./lib/checkpoints.js";
import { getBudgetStatus } from "./lib/budget.js";
import {
  compactGrokSession,
  sessionContext,
} from "./lib/compact.js";
import { SANDBOX_PROFILES } from "./lib/sandbox.js";
import {
  listBackgroundJobs,
  listNotifications,
} from "./lib/background.js";
import { describeProvider } from "./lib/providers.js";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  isGitRepo,
} from "./lib/worktrees.js";
import { needsInteractiveApprovals } from "./lib/acp-client.js";
import {
  readCliApprovalPolicy,
  describeApprovalConflict,
} from "./lib/cli-config.js";
import {
  TAILSCALE_CIDRS,
  evaluateAccess,
  loadOrCreateToken,
  rotateToken,
  normalizeIp,
  detectTailnetAddress,
  createAuthThrottle,
  requestLooksTunneled,
} from "./lib/remote.js";
import { createHub, sessionHubPayload } from "./lib/hub.js";

/**
 * The mode a remote-originated run actually runs in, given that bypass is
 * downgraded unless explicitly requested. Kept next to runOptionsFromBody's
 * rule so the two cannot drift.
 */
export function effectiveRemotePermissionMode(settingsMode) {
  return settingsMode === "bypassPermissions" ? "default" : settingsMode;
}

/** Concrete next steps when the phone cannot connect yet. */
export function buildPairingHints(cfg, tailnetIp) {
  const hints = [];
  if (!cfg.remoteEnabled) {
    hints.push("Remote access is off. Start with HEIR_STUDIO_REMOTE=1.");
  }
  if (!tailnetIp) {
    hints.push(
      "No Tailscale address on this Mac. Install Tailscale and sign in on both the Mac and the phone.",
    );
  } else if (cfg.host !== tailnetIp && cfg.host !== "0.0.0.0") {
    hints.push(
      `Server is bound to ${cfg.host}, so the phone cannot reach it. Restart with HEIR_STUDIO_HOST=${tailnetIp}.`,
    );
  }
  return hints;
}

/**
 * Build the Express app. Exportable for tests without listening.
 */
export function createApp(overrides = {}) {
  const cfg = createConfig(overrides);
  const log = overrides.log || createLogger();
  const runs = createRunManager(cfg, log);
  attachPushHooks(runs, { dataDir: cfg.data, log });
  const hub = createHub();

  const app = express();
  app.disable("x-powered-by");
  app.locals.cfg = cfg;
  app.locals.runs = runs;
  app.locals.hub = hub;
  app.locals.log = log;

  app.use(express.json({ limit: "4mb" }));

  // Remote access is opt-in and requires a source address inside an allowed
  // range *and* a bearer token. Loopback is unchanged and needs neither.
  const remoteAllowedCidrs = cfg.remoteAllowedCidrs || TAILSCALE_CIDRS;
  const remoteToken = cfg.remoteEnabled ? loadOrCreateToken(cfg.data).token : null;
  const authThrottle = createAuthThrottle();

  // A local reverse proxy or tunnel makes every request look like loopback, so
  // trusting loopback while remote access is on would expose an unauthenticated
  // shell to whatever the proxy is fronting. Say so, loudly, at startup.
  if (cfg.remoteEnabled && cfg.trustLoopback !== false) {
    log.warn("remote.loopback_trusted", {
      warning:
        "Remote access is enabled while loopback is trusted. If you front this " +
        "server with a tunnel or reverse proxy, its requests will bypass the " +
        "token entirely. Set HEIR_STUDIO_TRUST_LOOPBACK=0 for that setup.",
    });
  }

  app.use((req, res, next) => {
    const ip = normalizeIp(req.socket.remoteAddress || "");
    const isLoopbackIp = isLoopback(req.socket.remoteAddress || "");

    // Only throttle the authenticated path; a trusted local UI is never gated.
    const gated = !isLoopbackIp || cfg.trustLoopback === false;
    if (gated) {
      const { blocked, retryAfterMs } = authThrottle.check();
      if (blocked) {
        res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
        res.status(429).json({ error: "Too many failed attempts." });
        return;
      }
    }

    const verdict = evaluateAccess({
      ip,
      authorization: req.get("authorization"),
      cookie: req.get("cookie"),
      isLoopbackIp,
      remoteEnabled: Boolean(cfg.remoteEnabled),
      allowedCidrs: remoteAllowedCidrs,
      token: remoteToken,
      trustLoopback: cfg.trustLoopback !== false,
      viaTunnel: requestLooksTunneled(req),
    });
    if (!verdict.allow) {
      if (gated && verdict.status === 401) {
        const { locked } = authThrottle.recordFailure();
        if (locked) log.warn("remote.auth_locked_out", { ip });
      }
      log.warn("reject.access", { ip, path: req.path, status: verdict.status });
      res.status(verdict.status).json({ error: verdict.error });
      return;
    }
    if (gated) authThrottle.recordSuccess();
    req.isRemoteClient = verdict.remote;
    next();
  });

  app.use(express.static(cfg.publicDir));
  app.use("/files", express.static(cfg.data));

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, cfg.uploads),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".png";
      const base = path.basename(file.originalname, ext);
      cb(null, `${Date.now()}-${safeName(base)}${ext.toLowerCase()}`);
    },
  });
  const upload = multer({
    storage,
    limits: {
      fileSize: cfg.maxUploadBytes,
      files: cfg.maxUploadFiles,
    },
    fileFilter: (_req, file, cb) => {
      if (isAttachmentUpload(file)) cb(null, true);
      else
        cb(
          new Error(
            "Only images and text/code files are accepted as attachments",
          ),
        );
    },
  });

  function projectCwdFromReq(req) {
    const bodyCwd = req.body?.cwd || req.query?.cwd;
    if (bodyCwd) return String(bodyCwd);
    const proj = getProject(cfg.data, cfg.defaultProjectCwd || null);
    return proj.current;
  }

  function settingsCtx(req) {
    return {
      dataDir: cfg.data,
      projectCwd: projectCwdFromReq(req),
      home: cfg.settingsHome || cfg.home,
    };
  }

  function runOptionsFromBody(body, settings, { remote = false } = {}) {
    const s = settings || loadSettings(settingsCtx({ body })).settings;
    let permissionMode =
      body.permissionMode != null
        ? normalizePermissionMode(body.permissionMode)
        : body.yolo === false
          ? "default"
          : body.yolo === true
            ? "bypassPermissions"
            : s.permissionMode;

    // A remote client must not get blanket auto-approval by inheriting the
    // local default — if its token ever leaked that would be a remote shell.
    // Bypass stays possible, but only when asked for explicitly.
    let permissionDowngradedFrom = null;
    if (
      remote &&
      permissionMode === "bypassPermissions" &&
      body.allowBypassPermissions !== true
    ) {
      permissionDowngradedFrom = permissionMode;
      permissionMode = "default";
    }

    let model = body.model != null ? String(body.model).trim() : s.model;
    let reasoningEffort =
      body.reasoningEffort != null
        ? body.reasoningEffort
        : s.extendedThinking === false
          ? null
          : s.reasoningEffort;

    if (body.autoModel && body.prompt) {
      const pick = selectModelForTask(body.prompt, {
        cachePath: cfg.modelsCachePath,
      });
      if (!model) model = pick.model;
      if (reasoningEffort == null && s.extendedThinking !== false) {
        reasoningEffort = pick.reasoningEffort;
      }
    }

    return {
      model: model || "",
      yolo: permissionMode === "bypassPermissions",
      permissionMode,
      reasoningEffort: reasoningEffort || null,
      maxTurns: body.maxTurns != null ? body.maxTurns : s.maxTurns,
      maxBudgetUsd:
        body.maxBudgetUsd != null ? body.maxBudgetUsd : s.maxBudgetUsd,
      sandbox: body.sandbox != null ? body.sandbox : s.sandbox,
      allowRules: body.allowRules || s.allowRules || [],
      denyRules: body.denyRules || s.denyRules || [],
      agent: body.agent != null ? body.agent : s.agent,
      disableWebSearch:
        body.disableWebSearch != null
          ? Boolean(body.disableWebSearch)
          : s.disableWebSearch,
      noSubagents:
        body.noSubagents != null ? Boolean(body.noSubagents) : s.noSubagents,
      provider: body.provider || s.provider || {},
      background:
        body.background != null
          ? Boolean(body.background)
          : Boolean(s.background?.default),
      sshConnectionId:
        body.sshConnectionId != null
          ? body.sshConnectionId
          : s.ssh?.defaultConnectionId || null,
      worktree:
        body.worktree != null
          ? Boolean(body.worktree)
          : Boolean(s.worktree?.default),
      worktreeName:
        body.worktreeName != null
          ? String(body.worktreeName)
          : s.worktree?.name || null,
      interactive:
        body.interactive != null
          ? Boolean(body.interactive)
          : needsInteractiveApprovals(permissionMode),
      permissionDowngradedFrom,
    };
  }

  // `grok --version` is a synchronous subprocess that blocks the event loop for
  // up to 5s. The UI polls health on load and after every run, so cache it.
  const GROK_PROBE_TTL_MS = 30_000;
  let grokProbe = null;

  function probeGrok() {
    if (grokProbe && Date.now() - grokProbe.at < GROK_PROBE_TTL_MS) {
      return grokProbe;
    }
    let version;
    let ok;
    try {
      version = execFileSync(cfg.grokBin, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      ok = true;
    } catch (e) {
      version = `error: ${e.message}`;
      ok = false;
    }
    grokProbe = { version, ok, at: Date.now() };
    return grokProbe;
  }

  app.get("/api/health", (req, res) => {
    const { version, ok: grokOk } = probeGrok();
    const cliApproval = readCliApprovalPolicy(cfg.settingsHome || cfg.home);
    const { settings } = loadSettings({
      dataDir: cfg.data,
      home: cfg.settingsHome || cfg.home,
    });
    res.json({
      ok: grokOk,
      host: cfg.host,
      port: cfg.port,
      grokBin: cfg.grokBin,
      grokVersion: version,
      cwd: cfg.root,
      localOnly: true,
      activeRuns: runs.countRunning(),
      maxConcurrentRuns: cfg.maxConcurrentRuns,
      permissionModes: PERMISSION_MODES,
      features: {
        permissionModes: true,
        keybindings: true,
        checkpoints: true,
        ssh: true,
        subagents: true,
        background: true,
        budget: true,
        sandbox: true,
        providers: true,
        compact: true,
      },
      settingsSummary: {
        permissionMode: settings.permissionMode,
        model: settings.model,
        maxTurns: settings.maxTurns,
        maxBudgetUsd: settings.maxBudgetUsd,
      },
      cliApproval,
      // `grok agent stdio` takes no --permission-mode, so a config-level
      // always-approve silently wins over the selected mode. Say so.
      //
      // For a remote client, evaluate the mode its runs would ACTUALLY get
      // after the bypass downgrade — otherwise a Mac defaulting to
      // bypassPermissions reports "no conflict" while the downgrade it relies
      // on for safety is being silently overridden.
      approvalConflict: describeApprovalConflict(
        req.isRemoteClient
          ? effectiveRemotePermissionMode(settings.permissionMode)
          : settings.permissionMode,
        cliApproval,
      ),
    });
  });

  app.get("/api/workflows", (_req, res) => {
    const catalog = loadCatalog(cfg.catalogPath);
    res.json({
      workflows: catalog.workflows,
      rhai: listRhaiWorkflows([
        { dir: cfg.userWorkflowsDir, scope: "user" },
        { dir: cfg.studioWorkflowsDir, scope: "studio" },
      ]),
    });
  });

  app.get("/api/project", (_req, res) => {
    res.json(getProject(cfg.data, cfg.defaultProjectCwd || null));
  });

  app.post("/api/project", (req, res) => {
    try {
      const state = setProject(cfg.data, req.body?.cwd);
      log.info("project.set", { cwd: state.current });
      res.json(state);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // Browse this Mac so a phone can pick a project cwd or inspect a file.
  app.get("/api/fs", (req, res) => {
    try {
      const includeFiles =
        req.query?.files === "1" || req.query?.files === "true";
      res.json(
        includeFiles
          ? listEntries(req.query?.path)
          : listDirectories(req.query?.path),
      );
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.get("/api/file", (req, res) => {
    try {
      res.json(readFileText(req.query?.path));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.get("/api/git/status", (req, res) => {
    try {
      res.json(gitStatus(req.query?.cwd || projectCwdFromReq(req)));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.get("/api/git/diff", (req, res) => {
    try {
      const staged =
        req.query?.staged === "1" || req.query?.staged === "true";
      const filePath = req.query?.path ? String(req.query.path) : undefined;
      res.json(
        gitDiff(req.query?.cwd || projectCwdFromReq(req), {
          staged,
          path: filePath,
        }),
      );
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.post("/api/git/commit", (req, res) => {
    try {
      const body = req.body || {};
      res.json(
        gitCommit(body.cwd || projectCwdFromReq(req), {
          message: body.message,
          paths: body.paths,
        }),
      );
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.post("/api/git/push", (req, res) => {
    try {
      const body = req.body || {};
      res.json(
        gitPush(body.cwd || projectCwdFromReq(req), {
          remote: body.remote,
          branch: body.branch,
        }),
      );
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.post("/api/device/push", (req, res) => {
    try {
      const rec = registerDevice(cfg.data, {
        token: req.body?.token,
        bundleId: req.body?.bundleId,
      });
      log.info("push.register", { suffix: rec.token.slice(-8) });
      res.json({ ok: true, device: rec });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.delete("/api/device/push", (req, res) => {
    try {
      const token = req.body?.token || req.query?.token;
      res.json(removeDevice(cfg.data, token));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ── Chat sessions (multi-tab drawer) ──────────────────────────────
  app.get("/api/sessions", (_req, res) => {
    res.json(listSessions(cfg.data));
  });

  app.post("/api/sessions", (req, res) => {
    const body = req.body || {};
    let cwd = body.cwd;
    if (!cwd) {
      const proj = getProject(cfg.data, cfg.defaultProjectCwd || null);
      cwd = proj.current;
    }
    const session = createSession(cfg.data, {
      title: body.title,
      cwd,
      workflowId: body.workflowId || "code-agent",
    });
    log.info("session.create", { id: session.id, cwd });
    hub.publish({
      type: "session",
      event: "created",
      session: sessionHubPayload(session),
    });
    res.status(201).json(session);
  });

  app.get("/api/sessions/:id", (req, res) => {
    if (!isUuid(req.params.id)) {
      res.status(400).json({ error: "invalid session id" });
      return;
    }
    const session = getSession(cfg.data, req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(session);
  });

  app.patch("/api/sessions/:id", (req, res) => {
    try {
      const session = updateSession(cfg.data, req.params.id, req.body || {});
      hub.publish({
        type: "session",
        event: "updated",
        session: sessionHubPayload(session),
      });
      res.json(session);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.post("/api/sessions/active", (req, res) => {
    try {
      res.json(setActiveSession(cfg.data, req.body?.id || null));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.delete("/api/sessions/:id", (req, res) => {
    try {
      const out = deleteSession(cfg.data, req.params.id);
      hub.publish({
        type: "session",
        event: "deleted",
        session: { id: req.params.id },
      });
      res.json(out);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  /**
   * Post a user message into a chat session and start a grok run.
   * Body: { text, images, workflowId, cwd, model, permissionMode, ... }
   */
  app.post("/api/sessions/:id/messages", (req, res) => {
    const sessionId = req.params.id;
    if (!isUuid(sessionId)) {
      res.status(400).json({ error: "invalid session id" });
      return;
    }
    const session = getSession(cfg.data, sessionId);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }

    const body = req.body || {};
    const text = String(body.text || "").trim();
    if (!text && body.workflowId !== "rhai-workflow") {
      res.status(400).json({ error: "Message text is required." });
      return;
    }

    const catalog = loadCatalog(cfg.catalogPath);
    const workflowId = body.workflowId || session.workflowId || "code-agent";
    const wf = catalog.workflows.find((w) => w.id === workflowId);
    if (!wf) {
      res.status(400).json({ error: `Unknown workflow: ${workflowId}` });
      return;
    }

    let cwd = body.cwd || session.cwd;
    if (!cwd) {
      const proj = getProject(cfg.data, cfg.defaultProjectCwd || null);
      cwd = proj.current;
    }
    if (cwd) {
      setProject(cfg.data, cwd);
      updateSession(cfg.data, sessionId, { cwd, workflowId });
    }

    // Auto-checkpoint before each agent turn
    if (body.checkpoint !== false) {
      const snap = getSession(cfg.data, sessionId);
      createCheckpoint(cfg.data, sessionId, {
        label: `pre-run ${new Date().toISOString()}`,
        session: snap,
        reason: "pre-run",
      });
    }

    const images = body.images || [];
    const { message: userMsg } = appendUserMessage(cfg.data, sessionId, {
      text,
      images,
    });

    // Create assistant placeholder *before* spawn so onFinish never races
    // against a null message id (fast runs finish in the same tick).
    const { message: asst } = appendAssistantPlaceholder(cfg.data, sessionId, {});
    const assistantMsgId = asst.id;

    try {
      const { settings } = loadSettings({
        dataDir: cfg.data,
        projectCwd: cwd,
        home: cfg.settingsHome || cfg.home,
      });
      const runOpts = runOptionsFromBody(
        { ...body, prompt: text },
        settings,
        { remote: req.isRemoteClient },
      );

      const { id, meta } = runs.startRun({
        wf,
        prompt: text,
        images,
        aspect_ratio: body.aspect_ratio ?? "auto",
        duration: body.duration ?? "6",
        resolution: body.resolution ?? "480p",
        workflow_name: body.workflow_name ?? "",
        workflow_args: body.workflow_args ?? "{}",
        ...runOpts,
        cwd,
        resumeGrokSessionId: body.resume === false ? null : session.grokSessionId,
        chatSessionId: sessionId,
        onFinish: ({ meta: finishedMeta, text: accText, thoughts }) => {
          finalizeAssistantMessage(cfg.data, sessionId, assistantMsgId, {
            text: accText || "",
            thoughts: thoughts || "",
            status: finishedMeta.status,
            outputs: finishedMeta.outputs || [],
            grokSessionId: finishedMeta.sessionId,
          });
          setSessionActiveRun(cfg.data, sessionId, null);
          hub.publish({
            type: "run",
            event: "finished",
            sessionId,
            runId: id,
            messageId: assistantMsgId,
            status: finishedMeta.status,
            session: sessionHubPayload(getSession(cfg.data, sessionId)),
          });
        },
      });

      attachRunToAssistantMessage(cfg.data, sessionId, assistantMsgId, id);
      setSessionActiveRun(cfg.data, sessionId, id);
      hub.publish({
        type: "run",
        event: "started",
        sessionId,
        runId: id,
        messageId: assistantMsgId,
        session: sessionHubPayload(getSession(cfg.data, sessionId)),
      });

      const updated = getSession(cfg.data, sessionId);
      const assistantMessage =
        updated.messages.find((m) => m.id === assistantMsgId) || asst;
      log.info("session.message", {
        sessionId,
        runId: id,
        resume: Boolean(session.grokSessionId),
        permissionMode: meta.permissionMode,
        background: meta.background,
      });
      res.status(201).json({
        ok: true,
        session: updated,
        userMessage: userMsg,
        assistantMessage,
        run: { id, meta },
        permissionDowngradedFrom: runOpts.permissionDowngradedFrom,
      });
    } catch (e) {
      const status = e.status || 500;
      failAssistantMessage(cfg.data, sessionId, assistantMsgId, {
        text: e.message || "Run failed to start",
        status: "error",
      });
      setSessionActiveRun(cfg.data, sessionId, null);
      log.warn("session.message.reject", { status, message: e.message });
      res.status(status).json({ error: e.message });
    }
  });

  /**
   * Reattach helper: is this session's run still live?
   */
  app.get("/api/sessions/:id/active-run", (req, res) => {
    if (!isUuid(req.params.id)) {
      res.status(400).json({ error: "invalid session id" });
      return;
    }
    const session = getSession(cfg.data, req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const liveMeta = runs.getActiveRunForSession(req.params.id);
    const runningMsg = findRunningAssistant(session);
    const runId =
      liveMeta?.id || session.activeRunId || runningMsg?.runId || null;
    if (!runId) {
      res.json({ active: false, runId: null, messageId: null });
      return;
    }
    const live = runs.isLive(runId);
    const detail = runs.getRun(runId);
    res.json({
      active: live,
      runId,
      messageId: runningMsg?.id || null,
      meta: detail?.meta || liveMeta || null,
      live,
    });
  });

  app.get("/api/uploads", (_req, res) => {
    const files = listAttachmentsInDir(cfg.uploads, cfg.data);
    res.json({
      images: files, // legacy key — includes images + text/code
      files,
    });
  });

  app.get("/api/outputs", (_req, res) => {
    res.json({ images: listMediaInDir(cfg.outputs, cfg.data) });
  });

  app.post("/api/upload", (req, res) => {
    upload.array("files", cfg.maxUploadFiles)(req, res, (err) => {
      if (err) {
        log.warn("upload.error", { message: err.message });
        res.status(400).json({ error: err.message });
        return;
      }
      const files = (req.files || []).map((f) => {
        const ext = path.extname(f.filename || f.originalname || "").toLowerCase();
        const isImg = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|avif)$/i.test(ext);
        const isVid = /\.(mp4|webm|mov)$/i.test(ext);
        return {
          name: f.filename,
          originalName: f.originalname,
          path: f.path,
          url: `/files/uploads/${f.filename}`,
          size: f.size,
          kind: isVid ? "video" : isImg ? "image" : "file",
        };
      });
      log.info("upload.ok", { count: files.length });
      res.json({ ok: true, files });
    });
  });

  app.delete("/api/uploads/:name", (req, res) => {
    const name = path.basename(req.params.name);
    if (!name || name === "." || name === "..") {
      res.status(400).json({ error: "invalid name" });
      return;
    }
    const full = path.join(cfg.uploads, name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(cfg.uploads) + path.sep)) {
      res.status(400).json({ error: "invalid name" });
      return;
    }
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
      log.info("upload.delete", { name });
    }
    res.json({ ok: true });
  });

  app.get("/api/runs", (_req, res) => {
    res.json({ runs: runs.listRuns(50) });
  });

  app.get("/api/runs/:id", (req, res) => {
    if (!isUuid(req.params.id)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    const detail = runs.getRun(req.params.id);
    if (!detail) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(detail);
  });

  app.post("/api/runs", (req, res) => {
    const body = req.body || {};
    const catalog = loadCatalog(cfg.catalogPath);
    const workflowId = body.workflowId || "code-agent";
    const wf = catalog.workflows.find((w) => w.id === workflowId);
    if (!wf) {
      res.status(400).json({ error: `Unknown workflow: ${workflowId}` });
      return;
    }
    try {
      let cwd = body.cwd;
      if (!cwd) {
        const proj = getProject(cfg.data, cfg.defaultProjectCwd || null);
        cwd = proj.current;
      }
      if (cwd) setProject(cfg.data, cwd);
      const { settings } = loadSettings({
        dataDir: cfg.data,
        projectCwd: cwd,
        home: cfg.settingsHome || cfg.home,
      });
      const runOpts = runOptionsFromBody(body, settings, {
        remote: req.isRemoteClient,
      });
      const { id, meta } = runs.startRun({
        wf,
        prompt: body.prompt ?? "",
        images: body.images ?? [],
        aspect_ratio: body.aspect_ratio ?? "auto",
        duration: body.duration ?? "6",
        resolution: body.resolution ?? "480p",
        workflow_name: body.workflow_name ?? "",
        workflow_args: body.workflow_args ?? "{}",
        ...runOpts,
        cwd,
        resumeGrokSessionId: body.resumeGrokSessionId || null,
        chatSessionId: body.chatSessionId || null,
      });
      res.status(201).json({
        ok: true,
        id,
        meta,
        permissionDowngradedFrom: runOpts.permissionDowngradedFrom,
      });
    } catch (e) {
      const status = e.status || 500;
      log.warn("run.reject", { status, message: e.message });
      res.status(status).json({ error: e.message });
    }
  });

  app.get("/api/runs/:id/stream", (req, res) => {
    const result = runs.attachStream(req.params.id, res, {
      after: req.query.after,
    });
    if (result.error) {
      if (!res.headersSent) {
        res.status(result.status || 500).json({ error: result.error });
      }
    }
  });

  // Live session/run fan-out. Clients keep this open and attach to a
  // run stream only when a turn starts on a chat they have open.
  app.get("/api/events", (req, res) => {
    hub.attach(res);
  });

  app.post("/api/runs/:id/cancel", (req, res) => {
    try {
      res.json(runs.cancel(req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.post("/api/runs/:id/permissions/:permId", (req, res) => {
    try {
      const decision = req.body || {};
      res.json(
        runs.respondPermission(req.params.id, req.params.permId, decision),
      );
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.post("/api/runs/reconcile", (_req, res) => {
    const result = runs.reconcileStaleRuns();
    log.info("runs.reconcile", { count: result.reconciled.length });
    res.json(result);
  });

  // ── Remote pairing (loopback only — a phone must never read the token) ──
  function requireLocal(req, res) {
    if (req.isRemoteClient) {
      res.status(403).json({ error: "pairing is available on this Mac only" });
      return false;
    }
    return true;
  }

  function pairingPayload() {
    const tailnetIp = detectTailnetAddress(os.networkInterfaces());
    const record = cfg.remoteEnabled ? loadOrCreateToken(cfg.data) : null;
    const host = tailnetIp || cfg.host;
    return {
      enabled: Boolean(cfg.remoteEnabled),
      boundHost: cfg.host,
      port: cfg.port,
      tailnetIp,
      // What the phone should be pointed at. Null when there is nothing
      // reachable yet (remote off, or Tailscale not up on this Mac).
      url:
        cfg.remoteEnabled && tailnetIp ? `http://${tailnetIp}:${cfg.port}` : null,
      token: record?.token || null,
      createdAt: record?.createdAt || null,
      allowedCidrs: remoteAllowedCidrs,
      listeningOnTailnet: Boolean(tailnetIp) && cfg.host === tailnetIp,
      hints: buildPairingHints(cfg, tailnetIp),
    };
  }

  app.get("/api/remote/pairing", (req, res) => {
    if (!requireLocal(req, res)) return;
    res.json(pairingPayload());
  });

  app.post("/api/remote/rotate", (req, res) => {
    if (!requireLocal(req, res)) return;
    if (!cfg.remoteEnabled) {
      res.status(400).json({ error: "remote access is not enabled" });
      return;
    }
    rotateToken(cfg.data);
    log.warn("remote.token_rotated", {});
    // Existing devices are cut off until they re-pair; that is the point.
    res.json({ ...pairingPayload(), rotated: true, restartRequired: true });
  });

  // ── Worktrees ────────────────────────────────────────────────────
  app.get("/api/worktrees", (req, res) => {
    const cwd = projectCwdFromReq(req);
    if (!cwd) {
      res.json({ worktrees: [], git: false });
      return;
    }
    res.json({
      git: isGitRepo(cwd),
      worktrees: listWorktrees(cwd),
      cwd,
    });
  });

  app.post("/api/worktrees", (req, res) => {
    try {
      const cwd = projectCwdFromReq(req) || req.body?.cwd;
      if (!cwd) {
        res.status(400).json({ error: "project cwd required" });
        return;
      }
      const wt = createWorktree(cwd, {
        name: req.body?.name,
        baseRef: req.body?.baseRef,
      });
      log.info("worktree.create", { path: wt.path, name: wt.name });
      res.status(201).json(wt);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code });
    }
  });

  app.delete("/api/worktrees/:name", (req, res) => {
    try {
      const cwd = projectCwdFromReq(req) || req.body?.cwd;
      if (!cwd) {
        res.status(400).json({ error: "project cwd required" });
        return;
      }
      res.json(removeWorktree(cwd, req.params.name));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── Settings (user / project / local) ─────────────────────────────
  app.get("/api/settings", (req, res) => {
    const result = loadSettings(settingsCtx(req));
    res.json(result);
  });

  app.put("/api/settings/:scope", (req, res) => {
    const scope = req.params.scope;
    try {
      const result = saveSettings(scope, req.body || {}, settingsCtx(req));
      log.info("settings.save", { scope });
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── Permission modes ─────────────────────────────────────────────
  app.get("/api/permissions", (_req, res) => {
    res.json({
      modes: PERMISSION_MODES.map((id) => PERMISSION_META[id]),
      default: "default",
    });
  });

  app.post("/api/permissions/cycle", (req, res) => {
    const current = req.body?.mode ?? "default";
    const next = cyclePermissionMode(current);
    res.json({ mode: next, meta: PERMISSION_META[next] });
  });

  // ── Models ───────────────────────────────────────────────────────
  app.get("/api/models", (_req, res) => {
    res.json({
      models: listModels({ cachePath: cfg.modelsCachePath }),
    });
  });

  app.post("/api/models/select", (req, res) => {
    const pick = selectModelForTask(req.body?.prompt || "", {
      cachePath: cfg.modelsCachePath,
    });
    res.json(pick);
  });

  // ── Keybindings ──────────────────────────────────────────────────
  app.get("/api/keybindings", (_req, res) => {
    const filePath = resolveKeybindingsPath(cfg);
    const result = loadKeybindings(filePath);
    res.json({
      ...result,
      contexts: KEYBINDING_CONTEXTS,
      hardcoded: [...HARDCODED_ACTIONS],
      defaults: DEFAULT_KEYBINDINGS,
    });
  });

  app.put("/api/keybindings", (req, res) => {
    const filePath = resolveKeybindingsPath(cfg);
    try {
      const bindings = Array.isArray(req.body)
        ? req.body
        : req.body?.bindings;
      const result = saveKeybindings(filePath, bindings || []);
      log.info("keybindings.save", { path: filePath, count: result.bindings.length });
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── Agents / subagents ───────────────────────────────────────────
  app.get("/api/agents", (req, res) => {
    const projectCwd = projectCwdFromReq(req);
    res.json({
      agents: listAgents({
        projectCwd,
        dataDir: cfg.data,
        home: cfg.home,
      }),
    });
  });

  app.get("/api/agents/:id", (req, res) => {
    const agent = getAgent(req.params.id, {
      projectCwd: projectCwdFromReq(req),
      dataDir: cfg.data,
      home: cfg.home,
    });
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(agent);
  });

  app.post("/api/agents", (req, res) => {
    try {
      const agent = writeAgent(req.body || {}, {
        scope: req.body?.scope || "studio",
        projectCwd: projectCwdFromReq(req),
        dataDir: cfg.data,
        home: cfg.home,
      });
      res.status(201).json(agent);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── SSH connections ──────────────────────────────────────────────
  app.get("/api/ssh", (_req, res) => {
    res.json({ connections: listConnections(cfg.data) });
  });

  app.post("/api/ssh", (req, res) => {
    try {
      const conn = createConnection(cfg.data, req.body || {});
      log.info("ssh.create", { id: conn.id, host: conn.host });
      res.status(201).json(conn);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.get("/api/ssh/:id", (req, res) => {
    const conn = getConnection(cfg.data, req.params.id);
    if (!conn) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(conn);
  });

  app.patch("/api/ssh/:id", (req, res) => {
    try {
      res.json(updateConnection(cfg.data, req.params.id, req.body || {}));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.delete("/api/ssh/:id", (req, res) => {
    try {
      res.json(deleteConnection(cfg.data, req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.post("/api/ssh/:id/test", (req, res) => {
    try {
      res.json(testConnection(cfg.data, req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── Checkpoints ──────────────────────────────────────────────────
  app.get("/api/sessions/:id/checkpoints", (req, res) => {
    try {
      res.json({ checkpoints: listCheckpoints(cfg.data, req.params.id) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.post("/api/sessions/:id/checkpoints", (req, res) => {
    try {
      const session = getSession(cfg.data, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const cp = createCheckpoint(cfg.data, req.params.id, {
        label: req.body?.label,
        session,
        reason: req.body?.reason || "manual",
        includeGit: req.body?.includeGit !== false,
      });
      res.status(201).json(cp);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.get("/api/sessions/:id/checkpoints/:cpId", (req, res) => {
    const cp = getCheckpoint(cfg.data, req.params.id, req.params.cpId);
    if (!cp) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(cp);
  });

  app.post("/api/sessions/:id/checkpoints/:cpId/restore", (req, res) => {
    try {
      const cp = loadCheckpointForRestore(
        cfg.data,
        req.params.id,
        req.params.cpId,
      );
      const session = restoreSessionFromCheckpoint(cfg.data, req.params.id, cp);
      log.info("checkpoint.restore", {
        sessionId: req.params.id,
        checkpointId: req.params.cpId,
      });
      res.json({ ok: true, session, checkpoint: { id: cp.id, label: cp.label } });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.delete("/api/sessions/:id/checkpoints/:cpId", (req, res) => {
    try {
      res.json(deleteCheckpoint(cfg.data, req.params.id, req.params.cpId));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.get("/api/sessions/:id/context", (req, res) => {
    const session = getSession(cfg.data, req.params.id);
    if (!session) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.json({
      grokSessionId: session.grokSessionId || null,
      active: Boolean(session.activeRunId),
      context: sessionContext(session),
    });
  });

  app.post("/api/sessions/:id/compact", async (req, res) => {
    try {
      const session = getSession(cfg.data, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const result = await compactGrokSession({
        dataDir: cfg.data,
        session,
        note: req.body?.note || req.body?.context || "",
        grokBin: cfg.grokBin,
        cwd: session.cwd || cfg.root,
        env: process.env,
      });
      const next = getSession(cfg.data, req.params.id);
      hub.publish({
        type: "session",
        event: "compacted",
        sessionId: req.params.id,
        context: result.context,
        session: sessionHubPayload(next),
      });
      log.info("session.compact", {
        sessionId: req.params.id,
        percent: result.context.percent,
      });
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── History search (Ctrl+R) ──────────────────────────────────────
  app.get("/api/history", (req, res) => {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(100, Number(req.query.limit) || 40);
    if (!q) {
      res.json({ hits: listRecentUserPrompts(cfg.data, { limit }) });
      return;
    }
    res.json({ hits: searchMessageHistory(cfg.data, q, { limit }) });
  });

  // ── Budget ───────────────────────────────────────────────────────
  app.get("/api/budget", (req, res) => {
    const { settings } = loadSettings({
      dataDir: cfg.data,
      home: cfg.settingsHome || cfg.home,
    });
    res.json(
      getBudgetStatus(cfg.data, {
        maxBudgetUsd: settings.maxBudgetUsd,
        sessionId: req.query.sessionId || null,
      }),
    );
  });

  // ── Sandbox profiles ─────────────────────────────────────────────
  app.get("/api/sandbox", (_req, res) => {
    res.json({
      profiles: Object.values(SANDBOX_PROFILES),
    });
  });

  // ── Background jobs + notifications ──────────────────────────────
  app.get("/api/background", (req, res) => {
    res.json({
      jobs: listBackgroundJobs(cfg.data, {
        status: req.query.status || undefined,
      }),
    });
  });

  app.get("/api/notifications", (req, res) => {
    res.json({
      notifications: listNotifications(cfg.data, {
        limit: Number(req.query.limit) || 50,
      }),
    });
  });

  // ── Provider status ──────────────────────────────────────────────
  app.get("/api/provider", (req, res) => {
    const { settings } = loadSettings(settingsCtx(req));
    res.json(describeProvider(settings.provider));
  });

  // ── Transcript export (viewer) ───────────────────────────────────
  app.get("/api/sessions/:id/transcript", (req, res) => {
    if (!isUuid(req.params.id)) {
      res.status(400).json({ error: "invalid session id" });
      return;
    }
    const session = getSession(cfg.data, req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const format = String(req.query.format || "json");
    if (format === "markdown") {
      const lines = [
        `# ${session.title || "Transcript"}`,
        "",
        `cwd: \`${session.cwd || ""}\``,
        `session: ${session.id}`,
        "",
      ];
      for (const m of session.messages || []) {
        lines.push(`## ${m.role}`, "", m.text || "", "");
        if (m.thoughts) lines.push("<details><summary>Thinking</summary>", "", m.thoughts, "", "</details>", "");
      }
      res.type("text/markdown").send(lines.join("\n"));
      return;
    }
    res.json({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      messages: session.messages,
      grokSessionId: session.grokSessionId,
    });
  });

  app.use((err, _req, res, _next) => {
    log.error("http.error", { message: err.message });
    res.status(400).json({ error: err.message || "request failed" });
  });

  return app;
}
