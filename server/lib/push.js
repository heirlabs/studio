/**
 * APNs device registry and HTTP/2 sender.
 * Missing keys or an empty registry must not take a run down with them.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import http2 from "node:http2";

export const DEVICES_FILE = "push-devices.json";

export const PUSH_CATEGORY = {
  PERMISSION: "HEIR_PERMISSION",
  RUN: "HEIR_RUN",
};

export const DEFAULT_APNS_KEY_PATHS = [
  "/Users/futjr/.appstoreconnect/private_keys/AuthKey_629PDCXMGR.p8",
  "/Users/futjr/Downloads/Certificates/AuthKey_XN32LKUVMM.p8",
];

export const DEFAULT_APNS_KEY_ID = "629PDCXMGR";
export const DEFAULT_APNS_TEAM_ID = "2Y8MR5FHTC";
export const DEFAULT_APNS_BUNDLE_ID = "com.heir.studio.mobile";
export const DEFAULT_APNS_SANDBOX_HOST = "api.sandbox.push.apple.com";
export const DEFAULT_APNS_PRODUCTION_HOST = "api.push.apple.com";

function devicesPath(dataDir) {
  return path.join(dataDir, DEVICES_FILE);
}

export function normalizeDeviceToken(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/[\s<>]/g, "");
  if (!s) {
    const err = new Error("Device token is required");
    err.status = 400;
    throw err;
  }
  if (/^[0-9a-fA-F]+$/.test(s) && s.length >= 64 && s.length % 2 === 0) {
    return s.toLowerCase();
  }
  const buf = Buffer.from(s, "base64");
  if (buf.length >= 32) return buf.toString("hex");
  const err = new Error("Invalid APNs device token");
  err.status = 400;
  throw err;
}

export function loadDevices(dataDir) {
  const file = devicesPath(dataDir);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed : [];
}

function saveDevices(dataDir, devices) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = devicesPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function registerDevice(dataDir, { token, bundleId } = {}) {
  const normalized = normalizeDeviceToken(token);
  const devices = loadDevices(dataDir);
  const bid =
    bundleId || process.env.HEIR_STUDIO_APNS_BUNDLE_ID || DEFAULT_APNS_BUNDLE_ID;
  const existing = devices.find((d) => d.token === normalized);
  if (existing) {
    existing.bundleId = bid;
    saveDevices(dataDir, devices);
    return existing;
  }
  const rec = {
    token: normalized,
    addedAt: new Date().toISOString(),
    bundleId: bid,
  };
  devices.push(rec);
  saveDevices(dataDir, devices);
  return rec;
}

export function removeDevice(dataDir, token) {
  const normalized = normalizeDeviceToken(token);
  const devices = loadDevices(dataDir);
  const next = devices.filter((d) => d.token !== normalized);
  saveDevices(dataDir, next);
  return { ok: true, removed: next.length !== devices.length };
}

export function resolveApnsConfig(env = process.env) {
  const fromEnv = env.HEIR_STUDIO_APNS_KEY_PATH;
  const keyPath =
    (fromEnv && fs.existsSync(fromEnv) && fromEnv) ||
    DEFAULT_APNS_KEY_PATHS.find((p) => fs.existsSync(p)) ||
    null;
  if (!keyPath) return null;

  const fromName = path.basename(keyPath).match(/AuthKey_([A-Z0-9]+)\.p8$/i);
  const production = env.HEIR_STUDIO_APNS_PRODUCTION === "1";
  return {
    keyPath,
    keyId:
      env.HEIR_STUDIO_APNS_KEY_ID ||
      (fromName && fromName[1]) ||
      DEFAULT_APNS_KEY_ID,
    teamId: env.HEIR_STUDIO_APNS_TEAM_ID || DEFAULT_APNS_TEAM_ID,
    bundleId: env.HEIR_STUDIO_APNS_BUNDLE_ID || DEFAULT_APNS_BUNDLE_ID,
    production,
    host:
      env.HEIR_STUDIO_APNS_HOST ||
      (production ? DEFAULT_APNS_PRODUCTION_HOST : DEFAULT_APNS_SANDBOX_HOST),
  };
}

export function createApnsJwt({ keyPem, keyId, teamId, now } = {}) {
  if (!keyPem || !keyId || !teamId) {
    const err = new Error("APNs JWT requires keyPem, keyId, and teamId");
    err.status = 503;
    throw err;
  }
  const iat = now ?? Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: String(keyId) }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: String(teamId), iat }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const key = crypto.createPrivateKey(keyPem);
  const sig = crypto.sign("sha256", Buffer.from(unsigned), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${sig.toString("base64url")}`;
}

function connectApns(host) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    const onError = (e) => {
      const err = new Error(e.message || "APNs connection failed");
      err.status = 502;
      reject(err);
    };
    client.once("error", onError);
    client.once("connect", () => {
      client.off("error", onError);
      resolve(client);
    });
  });
}

function postApns(client, { token, jwt, topic, body }) {
  return new Promise((resolve) => {
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "0",
      "content-type": "application/json",
    });
    let status = 0;
    let data = "";
    req.on("response", (headers) => {
      status = Number(headers[":status"] || 0);
    });
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      resolve({ ok: status === 200, status, token, body: data });
    });
    req.on("error", (e) => {
      resolve({ ok: false, status: 0, token, error: e.message });
    });
    req.end(body);
  });
}

function buildApsBody({ title, body, category, payload }) {
  const extra = payload && typeof payload === "object" ? payload : {};
  return JSON.stringify({
    aps: {
      alert: { title: String(title || ""), body: String(body || "") },
      sound: "default",
      category: category || undefined,
    },
    sessionId: extra.sessionId ?? null,
    runId: extra.runId ?? null,
    permissionId: extra.permissionId ?? null,
    optionAllow: extra.optionAllow ?? null,
    optionDeny: extra.optionDeny ?? null,
    ...extra,
  });
}

export async function sendPush({
  devices,
  title,
  body,
  category,
  payload,
  keyPath,
  keyId,
  teamId,
  bundleId,
  production,
  host,
} = {}) {
  const list = Array.isArray(devices) ? devices : [];
  if (!list.length) return { sent: 0, failed: 0, results: [] };

  const resolvedHost =
    host ||
    (production ? DEFAULT_APNS_PRODUCTION_HOST : DEFAULT_APNS_SANDBOX_HOST);
  if (!keyPath || !fs.existsSync(keyPath)) {
    const err = new Error("APNs key not configured");
    err.status = 503;
    throw err;
  }
  if (!keyId || !teamId) {
    const err = new Error("APNs keyId and teamId are required");
    err.status = 503;
    throw err;
  }

  const jwt = createApnsJwt({
    keyPem: fs.readFileSync(keyPath, "utf8"),
    keyId,
    teamId,
  });
  const topic = bundleId || DEFAULT_APNS_BUNDLE_ID;
  const json = buildApsBody({ title, body, category, payload });

  let client;
  try {
    client = await connectApns(resolvedHost);
  } catch (e) {
    const err = new Error(e.message || "APNs connection failed");
    err.status = e.status || 502;
    throw err;
  }

  try {
    const results = [];
    for (const device of list) {
      const token = normalizeDeviceToken(device.token || device);
      results.push(await postApns(client, { token, jwt, topic, body: json }));
    }
    const sent = results.filter((r) => r.ok).length;
    return { sent, failed: results.length - sent, results };
  } finally {
    client.close();
  }
}

function pickAllow(options) {
  const list = Array.isArray(options) ? options : [];
  return (
    list.find((o) => o.kind === "allow_once") ||
    list.find((o) => o.kind === "allow_always") ||
    list.find((o) => /allow|approve|yes/i.test(o.name || o.optionId || "")) ||
    null
  );
}

function pickDeny(options) {
  const list = Array.isArray(options) ? options : [];
  return (
    list.find((o) => o.kind === "reject_once") ||
    list.find((o) => o.kind === "reject_always") ||
    list.find((o) => /deny|reject|cancel|no/i.test(o.name || o.optionId || "")) ||
    null
  );
}

function fireSend(send, args, log) {
  Promise.resolve()
    .then(() => send(args))
    .catch((err) => {
      log?.warn?.("push.fail", { message: err.message, category: args.category });
    });
}

function deliver({ dataDir, log, send, resolveConfig, title, body, category, payload }) {
  const devices = loadDevices(dataDir);
  if (!devices.length) {
    log?.warn?.("push.skip", { reason: "no devices", category });
    return { skipped: "no devices" };
  }
  const apns = resolveConfig();
  if (!apns || !apns.keyPath) {
    log?.warn?.("push.skip", { reason: "no apns key", category });
    return { skipped: "no apns key" };
  }
  fireSend(
    send,
    {
      devices,
      title,
      body,
      category,
      payload,
      keyPath: apns.keyPath,
      keyId: apns.keyId,
      teamId: apns.teamId,
      bundleId: apns.bundleId,
      production: apns.production,
      host: apns.host,
    },
    log,
  );
  return { queued: true };
}

/**
 * Wrap startRun so permission_request and run finish always attempt a push.
 */
export function attachPushHooks(
  runs,
  {
    dataDir,
    log,
    send = sendPush,
    resolveConfig = () => resolveApnsConfig(),
  } = {},
) {
  const inner = runs.startRun.bind(runs);
  runs.startRun = (opts = {}) => {
    let runId = null;
    const out = inner({
      ...opts,
      onEvent(evt) {
        if (evt && evt.type === "studio" && evt.event === "started" && evt.id) {
          runId = evt.id;
        }
        if (evt && evt.type === "studio" && evt.event === "permission_request") {
          const options = evt.options || [];
          const allow = pickAllow(options);
          const deny = pickDeny(options);
          const tool = evt.toolCall || {};
          deliver({
            dataDir,
            log,
            send,
            resolveConfig,
            title: "Permission needed",
            body: tool.title || tool.kind || "The agent wants to run a tool",
            category: PUSH_CATEGORY.PERMISSION,
            payload: {
              sessionId: opts.chatSessionId || evt.sessionId || null,
              runId,
              permissionId: evt.id != null ? String(evt.id) : null,
              optionAllow: allow?.optionId || null,
              optionDeny: deny?.optionId || null,
            },
          });
        }
        if (typeof opts.onEvent === "function") opts.onEvent(evt);
      },
      onFinish(result) {
        const status = result?.meta?.status || "finished";
        const preview = String(opts.prompt || "").trim().slice(0, 120);
        deliver({
          dataDir,
          log,
          send,
          resolveConfig,
          title: status === "completed" ? "Run finished" : `Run ${status}`,
          body: preview || status,
          category: PUSH_CATEGORY.RUN,
          payload: {
            sessionId: opts.chatSessionId || result?.meta?.chatSessionId || null,
            runId,
            permissionId: null,
            optionAllow: null,
            optionDeny: null,
            status,
          },
        });
        if (typeof opts.onFinish === "function") opts.onFinish(result);
      },
    });
    runId = out.id;
    return out;
  };
  return runs;
}
