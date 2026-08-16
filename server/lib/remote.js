/**
 * Authenticated remote access (for the iOS client).
 *
 * Threat model: this server can run arbitrary shell commands in a project
 * directory. Reaching it must therefore require BOTH
 *   1. a source address inside an explicitly allowed range (default: the
 *      Tailscale CGNAT block — never the public internet), and
 *   2. a bearer token.
 *
 * Loopback keeps working with no token so the desktop UI is unchanged.
 */
import fs from "fs";
import path from "path";
import { randomBytes, createHash, timingSafeEqual } from "crypto";

/** Tailscale assigns v4 out of the CGNAT block and v6 out of this ULA prefix. */
export const TAILSCALE_CIDRS = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];

/** Common private LAN ranges, for users who opt into same-Wi-Fi access. */
export const PRIVATE_LAN_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fe80::/10",
];

function tokenPath(dataDir) {
  return path.join(dataDir, "remote-access.json");
}

/** Strip the IPv4-mapped-IPv6 prefix and any zone id. */
export function normalizeIp(ip) {
  let s = String(ip || "").trim();
  if (s.startsWith("::ffff:")) s = s.slice(7);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  return s;
}

function ipv4ToBytes(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function ipv6ToBytes(ip) {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const readGroups = (s) =>
    s
      ? s.split(":").filter((g) => g !== "").map((g) => {
          if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return NaN;
          return parseInt(g, 16);
        })
      : [];

  let groups;
  if (halves.length === 2) {
    const head = readGroups(halves[0]);
    const tail = readGroups(halves[1]);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    groups = readGroups(halves[0]);
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;

  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[i * 2] = (g >> 8) & 0xff;
    out[i * 2 + 1] = g & 0xff;
  });
  return out;
}

export function ipToBytes(ip) {
  const s = normalizeIp(ip);
  if (!s) return null;
  return s.includes(":") ? ipv6ToBytes(s) : ipv4ToBytes(s);
}

/**
 * Whether an address falls inside a CIDR block. IPv4 and IPv6 are compared in
 * their own family only — a v4 address never matches a v6 block.
 */
export function ipInCidr(ip, cidr) {
  const [range, bitsRaw] = String(cidr || "").split("/");
  const ipBytes = ipToBytes(ip);
  const rangeBytes = ipToBytes(range);
  if (!ipBytes || !rangeBytes) return false;
  if (ipBytes.length !== rangeBytes.length) return false;

  const maxBits = ipBytes.length * 8;
  const bits = bitsRaw == null || bitsRaw === "" ? maxBits : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return false;

  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== rangeBytes[i]) return false;
  }
  const rem = bits % 8;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (ipBytes[fullBytes] & mask) === (rangeBytes[fullBytes] & mask);
}

export function isAllowedRemoteIp(ip, cidrs = TAILSCALE_CIDRS) {
  return (cidrs || []).some((c) => ipInCidr(ip, c));
}

/** Compare secrets without leaking length or content through timing. */
export function secretsMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseBearer(header) {
  const m = String(header || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function parseCookieValue(header, name) {
  if (!header || !name) return null;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** Cloudflare-terminated requests carry at least one of these. */
export function requestLooksTunneled(req) {
  const get = (n) =>
    (typeof req?.get === "function" ? req.get(n) : null) ||
    req?.headers?.[n] ||
    req?.headers?.[n.toLowerCase()] ||
    "";
  return Boolean(get("cf-ray") || get("cf-connecting-ip") || get("cdn-loop"));
}

export function presentedToken({ authorization, cookie } = {}) {
  return parseBearer(authorization) || parseCookieValue(cookie, "heir_stream");
}

export function generateToken() {
  return randomBytes(32).toString("base64url");
}

/**
 * Read the persisted token, creating one on first use. Written 0600 — it is
 * equivalent to shell access on this machine.
 */
export function loadOrCreateToken(dataDir) {
  const p = tokenPath(dataDir);
  if (fs.existsSync(p)) {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed?.token) return parsed;
  }
  const record = { token: generateToken(), createdAt: Date.now() };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return record;
}

export function rotateToken(dataDir) {
  const p = tokenPath(dataDir);
  const record = { token: generateToken(), createdAt: Date.now() };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return record;
}

/**
 * Throttle repeated auth failures.
 *
 * Behind a tunnel every request arrives from 127.0.0.1, so per-IP counting
 * would be useless — this is deliberately a single global budget. A 256-bit
 * token is not brute-forceable, but the endpoint is internet-facing once
 * tunnelled and a misconfigured short token should not be free to guess.
 */
export function createAuthThrottle({
  maxFailures = 10,
  windowMs = 60_000,
  lockoutMs = 60_000,
} = {}) {
  let failures = [];
  let lockedUntil = 0;

  return {
    /** @returns {{ blocked: boolean, retryAfterMs: number }} */
    check(now = Date.now()) {
      if (now < lockedUntil) {
        return { blocked: true, retryAfterMs: lockedUntil - now };
      }
      return { blocked: false, retryAfterMs: 0 };
    },
    recordFailure(now = Date.now()) {
      failures = failures.filter((t) => now - t < windowMs);
      failures.push(now);
      if (failures.length >= maxFailures) {
        lockedUntil = now + lockoutMs;
        failures = [];
        return { locked: true, lockoutMs };
      }
      return { locked: false, remaining: maxFailures - failures.length };
    },
    recordSuccess() {
      failures = [];
      lockedUntil = 0;
    },
  };
}

/**
 * Find this machine's Tailscale address, so pairing can hand the phone a URL
 * that actually resolves from the tailnet.
 */
export function detectTailnetAddress(interfaces) {
  for (const addrs of Object.values(interfaces || {})) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family === "IPv4" && ipInCidr(a.address, "100.64.0.0/10")) {
        return a.address;
      }
    }
  }
  return null;
}

/**
 * Decide what to do with an incoming request.
 * @returns {{ allow: boolean, remote: boolean, status?: number, error?: string }}
 */
export function evaluateAccess({
  ip,
  authorization,
  cookie,
  isLoopbackIp,
  remoteEnabled,
  allowedCidrs,
  token,
  trustLoopback = true,
  viaTunnel = false,
}) {
  // Behind a local reverse proxy or tunnel every request arrives from
  // 127.0.0.1, so trusting loopback would hand the whole internet an
  // unauthenticated shell. Setting trustLoopback:false requires a token there
  // too, and skips the range check (the tunnel is the only peer).
  if (isLoopbackIp && trustLoopback && !viaTunnel) return { allow: true, remote: false };

  if (isLoopbackIp) {
    if (!remoteEnabled) {
      return {
        allow: false,
        remote: true,
        status: 403,
        error: "Remote access is not enabled.",
      };
    }
    const presented = presentedToken({ authorization, cookie });
    if (!presented) {
      return { allow: false, remote: true, status: 401, error: "Missing bearer token." };
    }
    if (!secretsMatch(presented, token)) {
      return { allow: false, remote: true, status: 401, error: "Invalid bearer token." };
    }
    // Direct Electron/browser on this Mac is local even if it sent the token
    // so EventSource can work. Only Cloudflare-terminated requests are remote.
    return { allow: true, remote: viaTunnel };
  }

  if (!remoteEnabled) {
    return {
      allow: false,
      remote: true,
      status: 403,
      error: "Heir Studio is local-only. Enable remote access to connect a device.",
    };
  }
  if (!isAllowedRemoteIp(ip, allowedCidrs)) {
    return {
      allow: false,
      remote: true,
      status: 403,
      error: `Address ${normalizeIp(ip)} is outside the allowed remote range.`,
    };
  }
  const presented = parseBearer(authorization);
  if (!presented) {
    return {
      allow: false,
      remote: true,
      status: 401,
      error: "Missing bearer token.",
    };
  }
  if (!secretsMatch(presented, token)) {
    return {
      allow: false,
      remote: true,
      status: 401,
      error: "Invalid bearer token.",
    };
  }
  return { allow: true, remote: true };
}
