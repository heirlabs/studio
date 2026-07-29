const $ = (sel) => document.querySelector(sel);

const state = {
  workflows: [],
  rhai: [],
  selectedWorkflow: "code-agent",
  uploads: [],
  selected: new Set(),
  sessions: [],
  activeSessionId: null,
  session: null,
  projectCwd: "",
  running: false,
  runId: null,
  es: null,
  streamingMsgId: null,
  permissionMode: "bypassPermissions",
  permissionModes: [],
  models: [],
  agents: [],
  sshConnections: [],
  keybindings: [],
  settings: null,
  extendedThinking: true,
  reasoningEffort: "high",
  modal: null,
  historyHits: [],
  historyIndex: 0,
  contexts: new Set(["global", "idle", "chat", "composer"]),
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = {};
  if (text) {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
      data = JSON.parse(text);
    } else {
      data = { text };
    }
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function isNative() {
  return Boolean(window.grokStudioNative?.isNative);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortPath(p) {
  if (!p) return "Select project…";
  const m = String(p).match(/^\/Users\/[^/]+(\/.*)$/);
  return m ? `~${m[1]}` : p;
}

function currentWorkflow() {
  return state.workflows.find((w) => w.id === state.selectedWorkflow);
}

function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (kind ? ` ${kind}` : "");
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

/** Minimal markdown → safe HTML for assistant messages */
function renderMarkdown(src) {
  let s = escapeHtml(src);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code.replace(/\n$/, "")}</code></pre>`;
  });
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  s = s.replace(/(?:^|\n)((?:- .+\n?)+)/g, (block) => {
    const items = block
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => `<li>${l.slice(2)}</li>`)
      .join("");
    return `\n<ul>${items}</ul>\n`;
  });
  const parts = s.split(/\n{2,}/).map((p) => {
    if (
      p.startsWith("<pre>") ||
      p.startsWith("<ul>") ||
      p.startsWith("<h") ||
      p.startsWith("<ol>")
    ) {
      return p;
    }
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  });
  return parts.join("");
}

function extractFileCards(text) {
  const cards = [];
  const re =
    /(?:Created|Wrote|Updated|Modified)\s+[`']?([^\s`']+\.[a-zA-Z0-9]+)[`']?(?:\s*([+-]\d+)(?:\s*([+-]\d+))?)?/gi;
  let m;
  while ((m = re.exec(text))) {
    cards.push({
      name: m[1],
      plus: m[2] || "",
      minus: m[3] || "",
    });
  }
  return cards;
}

// ── Key chords ──────────────────────────────────────

function normalizeKeyChord(chord) {
  const parts = String(chord)
    .toLowerCase()
    .replace(/\s+/g, "")
    .split(/[+\-]/)
    .filter(Boolean)
    .map((p) => {
      if (p === "cmd" || p === "command" || p === "super" || p === "win")
        return "meta";
      if (p === "control" || p === "ctl") return "ctrl";
      if (p === "option" || p === "opt") return "alt";
      if (p === "return") return "enter";
      if (p === "esc") return "escape";
      return p;
    });
  const mods = [];
  let key = "";
  for (const p of parts) {
    if (p === "ctrl" || p === "alt" || p === "shift" || p === "meta") {
      if (!mods.includes(p)) mods.push(p);
    } else key = p;
  }
  const order = ["ctrl", "alt", "shift", "meta"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, key].join("+");
}

function chordFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("meta");
  let key = String(e.key || "").toLowerCase();
  if (key === " ") key = "space";
  if (key.startsWith("arrow")) key = key.replace("arrow", "");
  return normalizeKeyChord([...mods, key].join("+"));
}

function activeContexts() {
  const ctx = new Set(["global"]);
  if (state.running) ctx.add("running");
  else ctx.add("idle");
  ctx.add("chat");
  if (document.activeElement === $("#prompt")) ctx.add("composer");
  if (state.modal === "history") ctx.add("historySearch");
  if (state.modal === "transcript") ctx.add("transcriptViewer");
  if (state.modal) {
    ctx.add("modal");
    if (state.modal === "settings") ctx.add("settings");
    if (state.modal === "ssh") ctx.add("sshManager");
    if (state.modal === "agents") ctx.add("agentPicker");
    if (state.modal === "checkpoints") ctx.add("checkpointPicker");
  }
  if (state.permissionMode === "plan") ctx.add("planMode");
  return [...ctx];
}

function resolveBinding(chord) {
  const key = normalizeKeyChord(chord);
  const contexts = activeContexts();
  const ordered = [
    ...contexts.filter((c) => c !== "global"),
    "global",
  ];
  for (const when of ordered) {
    const hit = state.keybindings.find(
      (b) => b.when === when && b.key === key,
    );
    if (hit) return hit;
  }
  return null;
}

function hasChordPrefix(buffer) {
  if (!buffer) return false;
  const prefix = normalizeKeyChord(buffer) + " ";
  const contexts = new Set(activeContexts());
  return state.keybindings.some(
    (b) =>
      contexts.has(b.when) &&
      String(b.key).includes(" ") &&
      b.key.startsWith(prefix),
  );
}

/** Multi-stroke chord sequence tracker (e.g. ctrl+k ctrl+s) */
const chordState = {
  buffer: "",
  lastAt: 0,
  timeoutMs: 1000,
  reset() {
    this.buffer = "";
    this.lastAt = 0;
  },
  feed(stroke) {
    const now = Date.now();
    if (this.buffer && now - this.lastAt > this.timeoutMs) this.reset();
    const strokeNorm = normalizeKeyChord(stroke);
    const candidate = this.buffer
      ? `${this.buffer} ${strokeNorm}`
      : strokeNorm;
    const exact = resolveBinding(candidate);
    if (exact) {
      this.reset();
      return { type: "match", binding: exact };
    }
    if (hasChordPrefix(candidate)) {
      this.buffer = candidate;
      this.lastAt = now;
      return { type: "prefix" };
    }
    if (this.buffer) {
      this.reset();
      const alone = resolveBinding(strokeNorm);
      if (alone) return { type: "match", binding: alone };
      if (hasChordPrefix(strokeNorm)) {
        this.buffer = strokeNorm;
        this.lastAt = now;
        return { type: "prefix" };
      }
    }
    return { type: "none" };
  },
};

// ── Health / project / settings ─────────────────────

async function refreshHealth() {
  const el = $("#health");
  const text = $("#health-text");
  const h = await api("/api/health");
  el.classList.toggle("ok", h.ok);
  el.classList.toggle("bad", !h.ok);
  text.textContent = h.ok ? h.grokVersion.split(" ")[1] || "ok" : "offline";
  el.title = `${h.grokBin}\nruns ${h.activeRuns}/${h.maxConcurrentRuns}`;
}

async function loadProject() {
  const data = await api("/api/project");
  state.projectCwd = data.current || "";
  $("#project-cwd").value = state.projectCwd;
  $("#project-label").textContent = shortPath(state.projectCwd);
}

async function setProject(cwd) {
  const path = String(cwd || "").trim();
  if (!path) throw new Error("Project folder required");
  const data = await api("/api/project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: path }),
  });
  state.projectCwd = data.current || path;
  $("#project-cwd").value = state.projectCwd;
  $("#project-label").textContent = shortPath(state.projectCwd);
  if (state.activeSessionId) {
    await api(`/api/sessions/${state.activeSessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: state.projectCwd }),
    });
  }
}

async function browseProject() {
  if (isNative() && window.grokStudioNative.openProject) {
    const p = await window.grokStudioNative.openProject();
    if (p) await setProject(p);
    return;
  }
  const p = window.prompt("Project folder path:", state.projectCwd || "");
  if (p) await setProject(p);
}

async function loadSettings() {
  const data = await api(
    `/api/settings?cwd=${encodeURIComponent(state.projectCwd || "")}`,
  );
  state.settings = data.settings;
  state.permissionMode = data.settings.permissionMode || "bypassPermissions";
  state.reasoningEffort = data.settings.reasoningEffort || "high";
  state.extendedThinking = data.settings.extendedThinking !== false;
  $("#yolo").checked = state.permissionMode === "bypassPermissions";
  $("#background").checked = Boolean(data.settings.background?.default);
  syncPermUi();
  syncThinkUi();
  if (data.settings.model) {
    const sel = $("#model");
    if ([...sel.options].some((o) => o.value === data.settings.model)) {
      sel.value = data.settings.model;
    }
  }
}

async function loadModels() {
  const data = await api("/api/models");
  state.models = data.models || [];
  const sel = $("#model");
  sel.innerHTML = "";
  for (const m of state.models) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.name || m.id;
    sel.appendChild(o);
  }
  if (!state.models.length) {
    const o = document.createElement("option");
    o.value = "grok-4.5";
    o.textContent = "Grok 4.5";
    sel.appendChild(o);
  }
}

async function loadAgents() {
  const q = state.projectCwd
    ? `?cwd=${encodeURIComponent(state.projectCwd)}`
    : "";
  const data = await api(`/api/agents${q}`);
  state.agents = data.agents || [];
  const sel = $("#agent-select");
  const prev = sel.value;
  sel.innerHTML = `<option value="">agent: default</option>`;
  for (const a of state.agents) {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = `${a.name} (${a.scope})`;
    sel.appendChild(o);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function loadSsh() {
  const data = await api("/api/ssh");
  state.sshConnections = data.connections || [];
  const sel = $("#ssh-select");
  const prev = sel.value;
  sel.innerHTML = `<option value="">local</option>`;
  for (const c of state.sshConnections) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name || `${c.user ? c.user + "@" : ""}${c.host}`;
    sel.appendChild(o);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function loadKeybindings() {
  const data = await api("/api/keybindings");
  state.keybindings = data.bindings || [];
}

async function loadPermissions() {
  const data = await api("/api/permissions");
  state.permissionModes = data.modes || [];
}

function syncPermUi() {
  const meta = state.permissionModes.find(
    (m) => m.id === state.permissionMode,
  );
  $("#perm-label").textContent = meta?.short || state.permissionMode;
  $("#perm-chip").dataset.mode = state.permissionMode;
  $("#perm-chip").title = `${meta?.label || state.permissionMode}: ${meta?.description || ""} (Shift+Tab)`;
  $("#yolo").checked = state.permissionMode === "bypassPermissions";
}

function syncThinkUi() {
  const chip = $("#think-chip");
  if (!state.extendedThinking) {
    $("#think-label").textContent = "think: off";
    chip.classList.add("think-off");
  } else {
    $("#think-label").textContent = `think: ${state.reasoningEffort || "high"}`;
    chip.classList.remove("think-off");
  }
}

async function cyclePermission() {
  const data = await api("/api/permissions/cycle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: state.permissionMode }),
  });
  state.permissionMode = data.mode;
  syncPermUi();
  await api("/api/settings/local", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ permissionMode: state.permissionMode }),
  });
  toast(`Permission: ${data.meta?.label || data.mode}`);
}

function toggleThinking() {
  if (!state.extendedThinking) {
    state.extendedThinking = true;
    state.reasoningEffort = state.reasoningEffort || "high";
  } else if (state.reasoningEffort === "high") {
    state.reasoningEffort = "medium";
  } else if (state.reasoningEffort === "medium") {
    state.reasoningEffort = "low";
  } else {
    state.extendedThinking = false;
    state.reasoningEffort = null;
  }
  syncThinkUi();
  api("/api/settings/local", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      extendedThinking: state.extendedThinking,
      reasoningEffort: state.reasoningEffort,
    }),
  });
  toast(
    state.extendedThinking
      ? `Thinking: ${state.reasoningEffort}`
      : "Thinking off",
  );
}

// ── Workflows ───────────────────────────────────────

function fillWorkflowSelect() {
  const sel = $("#workflow-select");
  sel.innerHTML = "";
  const code = state.workflows.filter((w) => (w.category || "code") === "code");
  const media = state.workflows.filter((w) => w.category === "media");

  const addGroup = (label, list) => {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const w of list) {
      const o = document.createElement("option");
      o.value = w.id;
      o.textContent = `${w.icon || ""} ${w.name}`.trim();
      g.appendChild(o);
    }
    sel.appendChild(g);
  };
  addGroup("Coding", code);
  if (media.length) addGroup("Media", media);
  sel.value = state.selectedWorkflow;
  syncModeUi();
}

function syncModeUi() {
  const wf = currentWorkflow();
  document.body.classList.toggle("mode-media", wf?.category === "media");
  document.body.classList.toggle("mode-code", wf?.category !== "media");
  $("#rhai-opts").classList.toggle(
    "hidden",
    state.selectedWorkflow !== "rhai-workflow",
  );
}

function fillRhai() {
  const sel = $("#rhai-name");
  sel.innerHTML = "";
  if (!state.rhai.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "(no .rhai workflows)";
    sel.appendChild(o);
    return;
  }
  for (const r of state.rhai) {
    const o = document.createElement("option");
    o.value = r.name;
    o.textContent = `${r.name} (${r.scope})`;
    sel.appendChild(o);
  }
}

// ── Sessions sidebar ────────────────────────────────

function renderSessionList() {
  const root = $("#session-list");
  root.innerHTML = "";
  if (!state.sessions.length) {
    root.innerHTML = `<div class="muted tiny" style="padding:8px">No chats yet</div>`;
    return;
  }
  for (const s of state.sessions) {
    const btn = document.createElement("div");
    const isRunning = Boolean(s.activeRunId);
    btn.className =
      "session-item" +
      (s.id === state.activeSessionId ? " active" : "") +
      (isRunning ? " running" : "");
    btn.innerHTML = `
      <div class="s-row">
        <span class="s-title">${escapeHtml(s.title || "New chat")}</span>
        <button type="button" class="s-del" title="Delete" data-id="${s.id}">×</button>
      </div>
      <div class="s-meta">${escapeHtml(shortPath(s.cwd || ""))}${
        isRunning ? " · running" : ""
      }</div>
    `;
    btn.addEventListener("click", (e) => {
      if (e.target.closest(".s-del")) return;
      openSession(s.id);
    });
    btn.querySelector(".s-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/sessions/${s.id}`, { method: "DELETE" });
      await refreshSessions();
      if (state.activeSessionId === s.id) {
        if (state.sessions[0]) await openSession(state.sessions[0].id);
        else await createAndOpenSession();
      }
    });
    root.appendChild(btn);
  }
}

async function refreshSessions() {
  const data = await api("/api/sessions");
  state.sessions = data.sessions || [];
  state.activeSessionId = data.activeId || state.activeSessionId;
  renderSessionList();
}

async function createAndOpenSession() {
  const session = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: state.projectCwd || undefined,
      workflowId: state.selectedWorkflow,
    }),
  });
  await refreshSessions();
  await openSession(session.id);
  return session;
}

async function openSession(id) {
  const session = await api(`/api/sessions/${id}`);
  await api("/api/sessions/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  state.session = session;
  state.activeSessionId = id;
  if (session.cwd) {
    state.projectCwd = session.cwd;
    $("#project-cwd").value = session.cwd;
    $("#project-label").textContent = shortPath(session.cwd);
  }
  if (session.workflowId) {
    state.selectedWorkflow = session.workflowId;
    $("#workflow-select").value = session.workflowId;
    syncModeUi();
  }
  $("#chat-title").textContent = session.title || "New chat";
  renderTranscript(session.messages || []);
  renderSessionList();
  closeStream();

  // Reattach to a live run when switching back to a busy session
  const active = await api(`/api/sessions/${id}/active-run`).catch(() => null);
  if (active?.live && active.runId) {
    const msgId =
      active.messageId ||
      [...(session.messages || [])]
        .reverse()
        .find((m) => m.role === "assistant" && m.runId === active.runId)?.id;
    state.runId = active.runId;
    state.streamingMsgId = msgId || null;
    setRunning(true);
    setRunBadge("running");
    streamRun(active.runId, msgId);
    toast("Reattached to running agent", "ok");
    return;
  }

  // Stale "running" assistant after process death — refresh from disk
  const stale = [...(session.messages || [])]
    .reverse()
    .find((m) => m.role === "assistant" && m.status === "running");
  if (stale?.runId) {
    const detail = await api(`/api/runs/${stale.runId}`).catch(() => null);
    if (detail?.meta?.status && detail.meta.status !== "running") {
      await getSessionAndRender(detail.meta.status);
    }
  }

  setRunning(false);
  setRunBadge("idle");
  state.runId = null;
  state.streamingMsgId = null;
}

// ── Transcript rendering ────────────────────────────

function renderTranscript(messages) {
  const root = $("#transcript");
  root.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "transcript-inner";
  root.appendChild(inner);

  if (!messages.length) {
    inner.innerHTML = `
      <div class="empty-state">
        <h2>What should we build?</h2>
        <p>Pick a project on the left, then describe a coding task. Attach screenshots if useful.</p>
        <p class="muted tiny">Shift+Tab permission · Ctrl+R history · Ctrl+O transcript · Alt+T thinking</p>
      </div>`;
    return;
  }

  for (const msg of messages) {
    inner.appendChild(renderMessage(msg));
  }
  root.scrollTop = root.scrollHeight;
}

function renderMessage(msg) {
  const el = document.createElement("div");
  el.className = `msg ${msg.role}`;
  el.dataset.msgId = msg.id;

  if (msg.role === "user") {
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.textContent = msg.text || "";
    if (msg.images?.length) {
      const row = document.createElement("div");
      row.className = "msg-images";
      for (const name of msg.images) {
        const img = document.createElement("img");
        img.src = name.startsWith("/")
          ? name
          : `/files/uploads/${encodeURIComponent(name)}`;
        img.alt = "";
        row.appendChild(img);
      }
      bubble.appendChild(row);
    }
    el.appendChild(bubble);
    return el;
  }

  if (msg.role === "system") {
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.textContent = msg.text || "";
    el.appendChild(bubble);
    return el;
  }

  const wrap = document.createElement("div");
  wrap.className = "msg-bubble";
  wrap.style.maxWidth = "100%";

  if (msg.thoughts) {
    const det = document.createElement("details");
    det.className = "thoughts";
    det.innerHTML = `<summary>Thinking</summary><div class="thoughts-body"></div>`;
    det.querySelector(".thoughts-body").textContent = msg.thoughts;
    wrap.appendChild(det);
  }

  const prose = document.createElement("div");
  prose.className =
    "prose" + (msg.status === "running" ? " streaming-cursor" : "");
  prose.innerHTML = renderMarkdown(
    msg.text || (msg.status === "running" ? "" : ""),
  );
  wrap.appendChild(prose);

  const cards = extractFileCards(msg.text || "");
  for (const c of cards) {
    const card = document.createElement("div");
    card.className = "file-card";
    const ext = (c.name.split(".").pop() || "file").slice(0, 4).toUpperCase();
    card.innerHTML = `
      <div class="fc-icon">${escapeHtml(ext)}</div>
      <div>
        <div class="fc-name">${escapeHtml(c.name)}</div>
        <div class="fc-meta"><span class="plus">${escapeHtml(c.plus)}</span> <span class="minus">${escapeHtml(c.minus)}</span></div>
      </div>`;
    wrap.appendChild(card);
  }

  if (msg.outputs?.length) {
    const outs = document.createElement("div");
    outs.className = "msg-outputs";
    for (const o of msg.outputs) {
      const a = document.createElement("a");
      a.href = o.url || "#";
      a.target = "_blank";
      a.rel = "noopener";
      if (o.kind === "video") {
        a.innerHTML = `<video src="${escapeHtml(o.url)}" muted></video>`;
      } else {
        a.innerHTML = `<img src="${escapeHtml(o.url)}" alt="" />`;
      }
      outs.appendChild(a);
    }
    wrap.appendChild(outs);
  }

  if (msg.status === "failed" || msg.status === "error") {
    const err = document.createElement("div");
    err.className = "err-inline";
    err.textContent = `Run ${msg.status}`;
    wrap.appendChild(err);
  }

  el.appendChild(wrap);
  return el;
}

function formatToolPayload(input, max = 240) {
  if (input == null) return "";
  let s;
  if (typeof input === "string") s = input;
  else {
    try {
      s = JSON.stringify(input, null, 0);
    } catch {
      s = String(input);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > max) return s.slice(0, max - 1) + "…";
  return s;
}

function toolEventLabel(evt) {
  if (typeof evt === "string") return { title: evt, detail: "" };
  const name = evt.name || "tool";
  const kind = evt.kind || "call";
  const prefix =
    kind === "result" ? "✓" : kind === "error" ? "!" : kind === "stderr" ? "⚠" : "▸";
  const detail = evt.detail || "";
  return {
    title: `${prefix} ${name}`,
    detail,
    kind,
  };
}

function updateStreamingAssistant(msgId, { text, thoughts, status, tools }) {
  const root = $("#transcript .transcript-inner");
  if (!root) return;
  let el = root.querySelector(`[data-msg-id="${msgId}"]`);
  if (!el) return;
  const msg = {
    id: msgId,
    role: "assistant",
    text: text || "",
    thoughts: thoughts || "",
    status: status || "running",
  };
  const next = renderMessage(msg);
  if (tools?.length) {
    const wrap = next.querySelector(".msg-bubble");
    const toolsHost = document.createElement("div");
    toolsHost.className = "tool-events";
    for (const t of tools) {
      const info = toolEventLabel(t);
      const div = document.createElement("div");
      div.className = `tool-event tool-${info.kind || "call"}`;
      div.innerHTML = `<div class="tool-title">${escapeHtml(info.title)}</div>${
        info.detail
          ? `<div class="tool-detail">${escapeHtml(info.detail)}</div>`
          : ""
      }`;
      toolsHost.appendChild(div);
    }
    const prose = wrap?.querySelector(".prose");
    if (prose) wrap.insertBefore(toolsHost, prose);
    else wrap?.appendChild(toolsHost);
  }
  el.replaceWith(next);
  $("#transcript").scrollTop = $("#transcript").scrollHeight;
}

// ── Attachments ─────────────────────────────────────

function isAttachableClientFile(f) {
  if (!f) return false;
  if (f.type?.startsWith("image/") || f.type?.startsWith("text/")) return true;
  if (
    /^(application\/(json|javascript|typescript|xml|x-yaml|yaml|x-sh|x-python))/i.test(
      f.type || "",
    )
  ) {
    return true;
  }
  return /\.(png|jpe?g|webp|gif|heic|avif|bmp|tiff?|txt|md|markdown|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|html|css|scss|xml|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|sql|graphql|vue|svelte|csv|log|diff|patch|lock)$/i.test(
    f.name || "",
  );
}

function renderAttachRow() {
  const row = $("#attach-row");
  row.innerHTML = "";
  for (const img of state.uploads) {
    if (!state.selected.has(img.name)) continue;
    const chip = document.createElement("div");
    chip.className = "chip selected-on" + (img.kind === "file" ? " chip-file" : "");
    const label =
      img.name.length > 28 ? img.name.slice(0, 24) + "…" : img.name;
    if (img.kind === "file") {
      const ext = (img.name.split(".").pop() || "file").slice(0, 4).toUpperCase();
      chip.innerHTML = `
        <div class="chip-file-icon">${escapeHtml(ext)}</div>
        <span title="${escapeHtml(img.name)}">${escapeHtml(label)}</span>
        <button type="button" class="x" title="Remove">×</button>
      `;
    } else {
      chip.innerHTML = `
        <img src="${escapeHtml(img.url)}" alt="" />
        <span title="${escapeHtml(img.name)}">${escapeHtml(label)}</span>
        <button type="button" class="x" title="Remove">×</button>
      `;
    }
    chip.querySelector(".x").addEventListener("click", async () => {
      state.selected.delete(img.name);
      await api(`/api/uploads/${encodeURIComponent(img.name)}`, {
        method: "DELETE",
      });
      await refreshUploads();
    });
    row.appendChild(chip);
  }
}

async function refreshUploads() {
  const data = await api("/api/uploads");
  state.uploads = data.files || data.images || [];
  const names = new Set(state.uploads.map((i) => i.name));
  for (const n of [...state.selected]) {
    if (!names.has(n)) state.selected.delete(n);
  }
  renderAttachRow();
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter(isAttachableClientFile);
  if (!files.length) {
    toast("No attachable files (images or text/code)");
    return;
  }
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const data = await api("/api/upload", { method: "POST", body: fd });
  for (const f of data.files || []) state.selected.add(f.name);
  await refreshUploads();
}

// ── Run / stream ────────────────────────────────────

function setRunBadge(status) {
  const b = $("#run-badge");
  b.textContent = status;
  b.className = "badge " + status;
}

function setRunning(on) {
  state.running = on;
  $("#btn-run").disabled = on;
  $("#btn-cancel").classList.toggle("hidden", !on);
}

function closeStream() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
}

async function sendMessage() {
  if (state.running) return;
  const text = $("#prompt").value.trim();
  if (!text) return;

  const sshId = $("#ssh-select").value;
  if (!sshId && !state.projectCwd) {
    await browseProject();
    if (!state.projectCwd) {
      alert("Open a project folder first.");
      return;
    }
  }

  if (!state.activeSessionId) {
    await createAndOpenSession();
  }

  if (!sshId && state.projectCwd) {
    try {
      await setProject(state.projectCwd);
    } catch (e) {
      alert(e.message);
      return;
    }
  }

  const images = [...state.selected];
  setRunning(true);
  setRunBadge("running");
  $("#prompt").value = "";
  autoSizePrompt();

  let body;
  try {
    body = await api(`/api/sessions/${state.activeSessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        images,
        workflowId: state.selectedWorkflow,
        cwd: state.projectCwd,
        model: $("#model").value.trim(),
        permissionMode: state.permissionMode,
        reasoningEffort: state.extendedThinking
          ? state.reasoningEffort
          : null,
        agent: $("#agent-select").value || null,
        background: $("#background").checked,
        sshConnectionId: sshId || null,
        aspect_ratio: $("#aspect").value,
        duration: $("#duration").value,
        resolution: $("#resolution").value,
        workflow_name: $("#rhai-name").value,
        workflow_args: $("#rhai-args").value || "{}",
      }),
    });
  } catch (e) {
    setRunning(false);
    setRunBadge("error");
    alert(e.message);
    return;
  }

  state.session = body.session;
  state.runId = body.run.id;
  state.streamingMsgId = body.assistantMessage.id;
  $("#chat-title").textContent = body.session.title;
  renderTranscript(body.session.messages);
  await refreshSessions();

  state.selected.clear();
  renderAttachRow();

  if (body.run.meta?.background) {
    toast("Running in background", "ok");
  }

  streamRun(body.run.id, body.assistantMessage.id);
  refreshHealth();
}

function streamRun(runId, assistantMsgId) {
  closeStream();
  let textAcc = "";
  let thoughtAcc = "";
  /** @type {{name:string,kind:string,detail:string}[]} */
  const tools = [];
  const es = new EventSource(`/api/runs/${runId}/stream`);
  state.es = es;
  let finished = false;

  const paint = (status = "running") => {
    if (!assistantMsgId) return;
    updateStreamingAssistant(assistantMsgId, {
      text: textAcc,
      thoughts: thoughtAcc,
      status,
      tools,
    });
  };

  const pushTool = (entry) => {
    tools.push(entry);
    // Cap UI list for long agent turns
    if (tools.length > 80) tools.splice(0, tools.length - 80);
  };

  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "text" && msg.data) {
      textAcc += msg.data;
      paint("running");
    } else if (msg.type === "thought" && msg.data) {
      thoughtAcc += msg.data;
      paint("running");
    } else if (msg.type === "tool_call" || msg.type === "tool") {
      const name =
        msg.name || msg.tool || msg.data?.name || msg.data?.tool || "tool";
      const input =
        msg.input ??
        msg.args ??
        msg.arguments ??
        msg.data?.input ??
        msg.data?.arguments ??
        msg.data?.args;
      pushTool({
        name,
        kind: "call",
        detail: formatToolPayload(input),
      });
      paint("running");
    } else if (msg.type === "tool_result" || msg.type === "tool_response") {
      const name = msg.name || msg.tool || msg.data?.name || "result";
      const result =
        msg.result ?? msg.output ?? msg.data?.result ?? msg.data ?? msg.content;
      pushTool({
        name,
        kind: "result",
        detail: formatToolPayload(result, 320),
      });
      paint("running");
    } else if (msg.type === "studio" && msg.event === "stderr" && msg.data) {
      const line = String(msg.data).trim();
      if (line) {
        pushTool({
          name: "stderr",
          kind: "stderr",
          detail: formatToolPayload(line, 200),
        });
        paint("running");
      }
    } else if (msg.type === "studio" && msg.event === "raw" && msg.data) {
      pushTool({
        name: "raw",
        kind: "call",
        detail: formatToolPayload(msg.data, 160),
      });
      paint("running");
    } else if (msg.type === "error") {
      const errMsg = msg.message || JSON.stringify(msg);
      textAcc += `\n\n[error] ${errMsg}`;
      pushTool({ name: "error", kind: "error", detail: formatToolPayload(errMsg) });
      paint("failed");
    } else if (msg.type === "studio" && msg.event === "finished") {
      finished = true;
      const status =
        msg.status || (msg.exitCode === 0 ? "completed" : "failed");
      // Prefer full session text; if reattached mid-stream, keep accumulated
      getSessionAndRender(status).then(() => {
        // If server final text is empty but we streamed, keep stream text visible
        if (assistantMsgId && textAcc) {
          const root = $("#transcript .transcript-inner");
          const el = root?.querySelector(`[data-msg-id="${assistantMsgId}"]`);
          const prose = el?.querySelector(".prose");
          if (prose && !prose.textContent?.trim()) {
            paint(status);
          }
        }
      });
      setRunning(false);
      setRunBadge(status);
      closeStream();
      refreshHealth();
      refreshSessions();
      if (isNative() && window.grokStudioNative?.notify) {
        window.grokStudioNative.notify({
          title: "Grok Studio",
          body: `Run ${status}`,
        });
      }
    }
  };

  es.onerror = () => {
    if (finished || !state.running) {
      closeStream();
      return;
    }
    api(`/api/runs/${runId}`).then((detail) => {
      if (detail.meta.status !== "running") {
        finished = true;
        getSessionAndRender(detail.meta.status);
        setRunning(false);
        setRunBadge(detail.meta.status);
        closeStream();
      }
    });
  };
}

async function getSessionAndRender(status) {
  if (!state.activeSessionId) return;
  const session = await api(`/api/sessions/${state.activeSessionId}`);
  state.session = session;
  $("#chat-title").textContent = session.title;
  const msgs = session.messages || [];
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant" && last.status === "running" && status) {
    last.status = status;
  }
  renderTranscript(msgs);
}

async function cancelRun() {
  if (!state.runId) return;
  await api(`/api/runs/${state.runId}/cancel`, { method: "POST" });
  toast("Cancel sent");
}

function autoSizePrompt() {
  const ta = $("#prompt");
  ta.style.height = "auto";
  ta.style.height = Math.min(160, Math.max(44, ta.scrollHeight)) + "px";
}

// ── Modals ──────────────────────────────────────────

function openModal(kind, title, html, { wide } = {}) {
  state.modal = kind;
  const root = $("#modal-root");
  root.classList.remove("hidden");
  root.setAttribute("aria-hidden", "false");
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#modal").classList.toggle("wide", Boolean(wide));
}

function closeModal() {
  state.modal = null;
  const root = $("#modal-root");
  root.classList.add("hidden");
  root.setAttribute("aria-hidden", "true");
  $("#modal-body").innerHTML = "";
}

async function openHistorySearch() {
  const data = await api("/api/history?limit=40");
  state.historyHits = data.hits || [];
  state.historyIndex = 0;
  openModal(
    "history",
    "History search",
    `
    <input type="search" class="history-input" id="history-q" placeholder="Search past prompts…" autocomplete="off" />
    <div class="history-list" id="history-list"></div>
    `,
  );
  const input = $("#history-q");
  const list = $("#history-list");
  const render = () => {
    list.innerHTML = "";
    if (!state.historyHits.length) {
      list.innerHTML = `<div class="muted tiny">No matches</div>`;
      return;
    }
    state.historyHits.forEach((h, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item" + (i === state.historyIndex ? " active" : "");
      btn.innerHTML = `
        <div>${escapeHtml(h.text.slice(0, 200))}</div>
        <div class="hi-meta">${escapeHtml(h.sessionTitle || "")} · ${escapeHtml(shortPath(h.cwd || ""))}</div>
      `;
      btn.addEventListener("click", () => {
        $("#prompt").value = h.text;
        autoSizePrompt();
        closeModal();
        $("#prompt").focus();
      });
      list.appendChild(btn);
    });
  };
  render();
  input.focus();
  input.addEventListener("input", async () => {
    const q = input.value.trim();
    const r = await api(
      `/api/history?q=${encodeURIComponent(q)}&limit=40`,
    );
    state.historyHits = r.hits || [];
    state.historyIndex = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      state.historyIndex = Math.min(
        state.historyHits.length - 1,
        state.historyIndex + 1,
      );
      render();
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      state.historyIndex = Math.max(0, state.historyIndex - 1);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = state.historyHits[state.historyIndex];
      if (h) {
        $("#prompt").value = h.text;
        autoSizePrompt();
        closeModal();
        $("#prompt").focus();
      }
    }
  });
}

async function openTranscriptViewer() {
  if (!state.activeSessionId) return;
  const data = await api(
    `/api/sessions/${state.activeSessionId}/transcript`,
  );
  const msgs = data.messages || [];
  const html = `<div class="transcript-view">
    ${msgs
      .map(
        (m) => `
      <div class="tv-msg">
        <div class="tv-role">${escapeHtml(m.role)}</div>
        <div class="tv-text">${escapeHtml(m.text || "")}</div>
        ${
          m.thoughts
            ? `<div class="tv-thoughts">${escapeHtml(m.thoughts)}</div>`
            : ""
        }
      </div>`,
      )
      .join("")}
    <div class="settings-actions">
      <a class="ghost" href="/api/sessions/${state.activeSessionId}/transcript?format=markdown" target="_blank" rel="noopener">Export Markdown</a>
    </div>
  </div>`;
  openModal("transcript", data.title || "Transcript", html, { wide: true });
}

async function openSettings() {
  const data = await api(
    `/api/settings?cwd=${encodeURIComponent(state.projectCwd || "")}`,
  );
  const s = data.settings;
  const budget = await api("/api/budget");
  openModal(
    "settings",
    "Settings",
    `
    <div class="settings-grid">
      <label>Permission</label>
      <select id="set-perm">
        ${(state.permissionModes.length ? state.permissionModes : [{ id: s.permissionMode, label: s.permissionMode }])
          .map(
            (m) =>
              `<option value="${m.id}" ${m.id === s.permissionMode ? "selected" : ""}>${escapeHtml(m.label || m.id)}</option>`,
          )
          .join("")}
      </select>
      <label>Model</label>
      <select id="set-model">
        ${state.models
          .map(
            (m) =>
              `<option value="${m.id}" ${m.id === s.model ? "selected" : ""}>${escapeHtml(m.name || m.id)}</option>`,
          )
          .join("")}
      </select>
      <label>Max turns</label>
      <input type="number" id="set-turns" min="1" max="500" placeholder="unlimited" value="${s.maxTurns ?? ""}" />
      <label>Max budget USD/day</label>
      <input type="number" id="set-budget" min="0" step="0.01" placeholder="unlimited" value="${s.maxBudgetUsd ?? ""}" />
      <label>Sandbox</label>
      <input type="text" id="set-sandbox" placeholder="none | read-only | workspace-write" value="${s.sandbox ?? ""}" />
      <label>Gateway URL</label>
      <input type="text" id="set-gateway" placeholder="https://…" value="${s.provider?.gatewayUrl ?? ""}" />
      <label>API base URL</label>
      <input type="text" id="set-api-base" placeholder="https://…" value="${s.provider?.xaiApiBaseUrl ?? ""}" />
    </div>
    <div class="budget-bar">
      Today: $${Number(budget.spentUsd || 0).toFixed(4)} spent
      ${
        budget.remainingUsd != null
          ? ` · $${budget.remainingUsd.toFixed(4)} remaining`
          : " · no cap"
      }
      · ${budget.turns || 0} turns · ${budget.runs || 0} runs
    </div>
    <div class="settings-actions">
      <button type="button" class="ghost" id="set-cancel">Cancel</button>
      <button type="button" class="primary" id="set-save">Save local</button>
    </div>
    `,
  );
  $("#set-cancel").onclick = () => closeModal();
  $("#set-save").onclick = async () => {
    const turns = $("#set-turns").value;
    const budgetV = $("#set-budget").value;
    await api("/api/settings/local", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissionMode: $("#set-perm").value,
        model: $("#set-model").value,
        maxTurns: turns === "" ? null : Number(turns),
        maxBudgetUsd: budgetV === "" ? null : Number(budgetV),
        sandbox: $("#set-sandbox").value || null,
        provider: {
          gatewayUrl: $("#set-gateway").value || null,
          xaiApiBaseUrl: $("#set-api-base").value || null,
        },
      }),
    });
    await loadSettings();
    if ($("#set-model").value) $("#model").value = $("#set-model").value;
    closeModal();
    toast("Settings saved", "ok");
  };
}

async function openCheckpoints() {
  if (!state.activeSessionId) return;
  const data = await api(
    `/api/sessions/${state.activeSessionId}/checkpoints`,
  );
  const list = data.checkpoints || [];
  openModal(
    "checkpoints",
    "Checkpoints",
    `
    <div class="settings-actions" style="justify-content:flex-start;margin-top:0;margin-bottom:12px">
      <button type="button" class="primary" id="cp-create">Create checkpoint</button>
    </div>
    <div class="checkpoint-list" id="cp-list">
      ${
        list.length
          ? list
              .map(
                (c) => `
        <div class="checkpoint-row" data-id="${c.id}">
          <div>
            <div>${escapeHtml(c.label)}</div>
            <div class="cp-meta">${new Date(c.createdAt).toLocaleString()} · ${c.messageCount} msgs · ${escapeHtml(c.reason || "")}</div>
          </div>
          <button type="button" class="ghost cp-restore" data-id="${c.id}">Restore</button>
        </div>`,
              )
              .join("")
          : `<div class="muted tiny">No checkpoints yet</div>`
      }
    </div>
    `,
  );
  $("#cp-create").onclick = async () => {
    await api(`/api/sessions/${state.activeSessionId}/checkpoints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Manual checkpoint" }),
    });
    toast("Checkpoint created", "ok");
    openCheckpoints();
  };
  for (const btn of document.querySelectorAll(".cp-restore")) {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const r = await api(
        `/api/sessions/${state.activeSessionId}/checkpoints/${id}/restore`,
        { method: "POST" },
      );
      state.session = r.session;
      renderTranscript(r.session.messages || []);
      closeModal();
      toast("Checkpoint restored", "ok");
    });
  }
}

function openKeybindingsHelp() {
  const rows = state.keybindings
    .filter((b) => !b.hardcoded || b.command === "forceCancel")
    .map(
      (b) =>
        `<tr><td><code>${escapeHtml(b.key)}</code></td><td>${escapeHtml(b.command)}</td><td>${escapeHtml(b.when)}</td></tr>`,
    )
    .join("");
  openModal(
    "keybindings",
    "Keyboard shortcuts",
    `
    <p class="muted tiny">Customize via <code>~/.grok-studio/keybindings.json</code>. forceCancel and emergencyStop are hardcoded.</p>
    <table class="kb-table">
      <thead><tr><th>Key</th><th>Command</th><th>Context</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    `,
    { wide: true },
  );
}

// ── Commands map ────────────────────────────────────

const commands = {
  cancelTurn: () => {
    if (state.running) cancelRun();
  },
  forceCancel: () => {
    if (state.running) cancelRun();
  },
  emergencyStop: () => {
    if (state.running) cancelRun();
  },
  historySearch: () => openHistorySearch(),
  openTranscriptViewer: () => openTranscriptViewer(),
  toggleExtendedThinking: () => toggleThinking(),
  cyclePermissionMode: () => cyclePermission(),
  newSession: () => createAndOpenSession(),
  focusComposer: () => $("#prompt").focus(),
  openSettings: () => openSettings(),
  toggleBackground: () => {
    $("#background").checked = !$("#background").checked;
    toast($("#background").checked ? "Background on" : "Background off");
  },
  createCheckpoint: () => openCheckpoints(),
  showKeybindingsHelp: () => openKeybindingsHelp(),
  sendMessage: () => {
    sendMessage().catch((e) => alert(e.message));
  },
  insertNewline: () => {},
  closeModal: () => closeModal(),
  historyAccept: () => {},
  historyPrev: () => {},
  historyNext: () => {},
  openSshManager: () => openSshManager(),
  openAgentPicker: () => {
    $("#agent-select").focus();
  },
  commandPalette: () => openKeybindingsHelp(),
};

async function openSshManager() {
  await loadSsh();
  const list = state.sshConnections;
  openModal(
    "ssh",
    "SSH connections",
    `
    <div class="settings-grid">
      <label>Name</label><input id="ssh-name" type="text" placeholder="prod" />
      <label>Host</label><input id="ssh-host" type="text" placeholder="example.com" />
      <label>User</label><input id="ssh-user" type="text" placeholder="deploy" />
      <label>Port</label><input id="ssh-port" type="number" value="22" min="1" max="65535" />
      <label>Remote cwd</label><input id="ssh-cwd" type="text" value="~" />
      <label>Remote grok</label><input id="ssh-bin" type="text" value="grok" />
      <label>Identity file</label><input id="ssh-id" type="text" placeholder="/Users/…/.ssh/id_ed25519" />
    </div>
    <div class="settings-actions">
      <button type="button" class="primary" id="ssh-add">Add connection</button>
    </div>
    <div class="checkpoint-list" id="ssh-list" style="margin-top:14px">
      ${
        list.length
          ? list
              .map(
                (c) => `
        <div class="checkpoint-row" data-id="${c.id}">
          <div>
            <div>${escapeHtml(c.name || c.host)}</div>
            <div class="cp-meta">${escapeHtml(
              (c.user ? c.user + "@" : "") + c.host + ":" + (c.port || 22),
            )} · ${escapeHtml(c.remoteCwd || "~")}${
              c.lastTestOk === true
                ? " · ok"
                : c.lastTestOk === false
                  ? " · fail"
                  : ""
            }</div>
          </div>
          <div style="display:flex;gap:6px">
            <button type="button" class="ghost ssh-use" data-id="${c.id}">Use</button>
            <button type="button" class="ghost ssh-test" data-id="${c.id}">Test</button>
            <button type="button" class="ghost ssh-del" data-id="${c.id}">Delete</button>
          </div>
        </div>`,
              )
              .join("")
          : `<div class="muted tiny">No SSH profiles yet</div>`
      }
    </div>
    `,
  );
  $("#ssh-add").onclick = async () => {
    const host = $("#ssh-host").value.trim();
    if (!host) {
      alert("Host is required");
      return;
    }
    await api("/api/ssh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("#ssh-name").value.trim() || undefined,
        host,
        user: $("#ssh-user").value.trim() || undefined,
        port: Number($("#ssh-port").value) || 22,
        remoteCwd: $("#ssh-cwd").value.trim() || "~",
        remoteGrokBin: $("#ssh-bin").value.trim() || "grok",
        identityFile: $("#ssh-id").value.trim() || null,
      }),
    });
    await loadSsh();
    toast("SSH connection added", "ok");
    openSshManager();
  };
  for (const btn of document.querySelectorAll(".ssh-use")) {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if ($("#ssh-select")) $("#ssh-select").value = id;
      toast("SSH profile selected");
      closeModal();
    });
  }
  for (const btn of document.querySelectorAll(".ssh-test")) {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const r = await api(`/api/ssh/${id}/test`, { method: "POST" });
      toast(r.ok ? "SSH ok" : `SSH failed: ${r.error || "error"}`, r.ok ? "ok" : "");
      openSshManager();
    });
  }
  for (const btn of document.querySelectorAll(".ssh-del")) {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      await api(`/api/ssh/${id}`, { method: "DELETE" });
      await loadSsh();
      openSshManager();
    });
  }
}

// ── Wire UI ─────────────────────────────────────────

function wireDrop() {
  const overlay = $("#drop-overlay");
  let dragDepth = 0;

  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    overlay.classList.remove("hidden");
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.add("hidden");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add("hidden");
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  });

  window.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });

  $("#file-input").addEventListener("change", () => {
    if ($("#file-input").files?.length) uploadFiles($("#file-input").files);
    $("#file-input").value = "";
  });
}

function wireKeybindings() {
  window.addEventListener(
    "keydown",
    (e) => {
      // Plain character keys without modifiers: never intercept (typing)
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.length === 1 &&
        !e.shiftKey
      ) {
        return;
      }
      // Shift alone with printable still types (Shift+A etc.)
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.length === 1 &&
        e.shiftKey
      ) {
        return;
      }

      const stroke = chordFromEvent(e);
      // Single-key Escape / Enter / Tab with only shift may still bind
      const result = chordState.feed(stroke);
      if (result.type === "prefix") {
        e.preventDefault();
        return;
      }
      if (result.type !== "match") return;
      const binding = result.binding;

      // Don't steal Enter from history search input (handled there)
      if (
        binding.command === "sendMessage" &&
        state.modal === "history"
      ) {
        return;
      }

      // Composer: Enter sends, Shift+Enter newline (default browser for shift+enter)
      if (binding.command === "insertNewline") {
        return; // allow default
      }

      // When typing in history search, only allow history* + close + nav
      if (
        state.modal === "history" &&
        document.activeElement?.id === "history-q"
      ) {
        if (
          ![
            "closeModal",
            "historyAccept",
            "historyPrev",
            "historyNext",
          ].includes(binding.command) &&
          binding.command !== "historySearch"
        ) {
          // still allow global cancel etc when running
          if (!["cancelTurn", "forceCancel", "emergencyStop"].includes(binding.command)) {
            return;
          }
        }
      }

      const fn = commands[binding.command];
      if (!fn) return;
      e.preventDefault();
      fn();
    },
    true,
  );
}

async function init() {
  wireDrop();
  wireKeybindings();

  $("#btn-new-session").addEventListener("click", () => createAndOpenSession());
  $("#btn-run").addEventListener("click", () => {
    sendMessage().catch((e) => {
      setRunning(false);
      setRunBadge("error");
      alert(e.message);
    });
  });
  $("#btn-cancel").addEventListener("click", () => {
    cancelRun().catch((e) => alert(e.message));
  });
  $("#btn-project").addEventListener("click", () => {
    browseProject().catch((e) => alert(e.message));
  });
  $("#btn-attach").addEventListener("click", () => {
    if (isNative()) window.grokStudioNative.openImages();
    else $("#file-input").click();
  });
  $("#btn-history").addEventListener("click", () => openHistorySearch());
  $("#btn-transcript").addEventListener("click", () => openTranscriptViewer());
  $("#btn-checkpoint").addEventListener("click", () => openCheckpoints());
  $("#btn-settings").addEventListener("click", () => openSettings());
  $("#perm-chip").addEventListener("click", () => cyclePermission());
  $("#think-chip").addEventListener("click", () => toggleThinking());
  $("#modal-close").addEventListener("click", () => closeModal());
  $("#modal-backdrop").addEventListener("click", () => closeModal());
  $("#yolo").addEventListener("change", () => {
    state.permissionMode = $("#yolo").checked
      ? "bypassPermissions"
      : "default";
    syncPermUi();
    api("/api/settings/local", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: state.permissionMode }),
    });
  });
  $("#prompt").addEventListener("input", autoSizePrompt);
  $("#prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage().catch((err) => alert(err.message));
    }
  });
  $("#workflow-select").addEventListener("change", () => {
    state.selectedWorkflow = $("#workflow-select").value;
    syncModeUi();
    if (state.activeSessionId) {
      api(`/api/sessions/${state.activeSessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: state.selectedWorkflow }),
      });
    }
  });

  if (isNative()) {
    document.body.classList.add("native");
    for (const el of document.querySelectorAll(".native-only")) {
      el.classList.remove("hidden");
    }
    $("#btn-open-native")?.addEventListener("click", () => {
      window.grokStudioNative.openImages();
    });
    $("#btn-reveal-out")?.addEventListener("click", () => {
      window.grokStudioNative.revealOutputs();
    });
    window.grokStudioNative.onImagesImported?.(async (files) => {
      for (const f of files || []) state.selected.add(f.name);
      await refreshUploads();
    });
    window.grokStudioNative.onProjectOpened?.(async (p) => {
      await setProject(p);
    });
  }

  await refreshHealth();
  await loadProject();
  await loadPermissions();
  await loadModels();
  await loadKeybindings();
  await loadSettings();
  await loadAgents();
  await loadSsh();

  const wf = await api("/api/workflows");
  state.workflows = wf.workflows || [];
  state.rhai = wf.rhai || [];
  state.selectedWorkflow =
    state.workflows.find((w) => w.id === "code-agent")?.id ||
    state.workflows[0]?.id ||
    "code-agent";
  fillWorkflowSelect();
  fillRhai();

  await refreshUploads();
  await refreshSessions();

  if (state.activeSessionId) {
    await openSession(state.activeSessionId);
  } else if (state.sessions[0]) {
    await openSession(state.sessions[0].id);
  } else {
    await createAndOpenSession();
  }

  autoSizePrompt();
}

init().catch((e) => {
  console.error(e);
  $("#health-text").textContent = e.message;
  $("#health").classList.add("bad");
});
