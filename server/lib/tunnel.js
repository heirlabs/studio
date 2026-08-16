/**
 * Decide how to run cloudflared.
 *
 * Named tunnels (a real Cloudflare account + your own hostname) are the
 * supported path: the URL is stable, so the phone pairs once instead of
 * re-pairing after every restart. Quick tunnels are throwaway and must be asked
 * for explicitly.
 *
 * Pure — the script does the spawning.
 */

/**
 * @param {{ env: object, certExists: boolean, port: number }} input
 * @returns {{ mode?: "token"|"named"|"quick", url?: string|null, hostname?: string|null,
 *             args?: string[], error?: string, hints?: string[] }}
 */
export function resolveTunnelPlan({ env = {}, certExists = false, port = 3847 } = {}) {
  const hostname = (env.HEIR_STUDIO_TUNNEL_HOSTNAME || "").trim();
  const token = (env.CLOUDFLARE_TUNNEL_TOKEN || "").trim();
  const name = (env.HEIR_STUDIO_TUNNEL_NAME || "").trim();
  const allowQuick = env.HEIR_STUDIO_TUNNEL_QUICK === "1";
  const local = `http://127.0.0.1:${port}`;

  // Dashboard-managed ("remotely-managed") tunnel: ingress lives in Cloudflare,
  // so no --url here. The token alone identifies the tunnel.
  if (token) {
    if (!hostname) {
      return {
        error:
          "CLOUDFLARE_TUNNEL_TOKEN is set but HEIR_STUDIO_TUNNEL_HOSTNAME is not.",
        hints: [
          "The token says which tunnel to run; the hostname is what the phone connects to.",
          "Set it to the public hostname you mapped in the Zero Trust dashboard, e.g.",
          "  HEIR_STUDIO_TUNNEL_HOSTNAME=agent.example.com npm run tunnel",
          `Its ingress rule must point at ${local}.`,
        ],
      };
    }
    return {
      mode: "token",
      hostname,
      url: `https://${hostname}`,
      args: ["tunnel", "--no-autoupdate", "run", "--token", token],
    };
  }

  // Locally-managed named tunnel: needs `cloudflared tunnel login` (cert.pem).
  if (name) {
    if (!certExists) {
      return {
        error: `Tunnel "${name}" requested, but cloudflared is not logged in on this Mac.`,
        hints: [
          "Authenticate first (opens a browser; pick the zone you want):",
          "  cloudflared tunnel login",
          `Then create and route the tunnel:`,
          `  cloudflared tunnel create ${name}`,
          `  cloudflared tunnel route dns ${name} <hostname>`,
        ],
      };
    }
    if (!hostname) {
      return {
        error: `Tunnel "${name}" needs HEIR_STUDIO_TUNNEL_HOSTNAME so pairing knows the URL.`,
        hints: [
          `  cloudflared tunnel route dns ${name} agent.example.com`,
          "  HEIR_STUDIO_TUNNEL_HOSTNAME=agent.example.com npm run tunnel",
        ],
      };
    }
    return {
      mode: "named",
      hostname,
      url: `https://${hostname}`,
      args: ["tunnel", "--no-autoupdate", "run", "--url", local, name],
    };
  }

  if (allowQuick) {
    return {
      mode: "quick",
      hostname: null,
      // discovered from cloudflared's output at runtime
      url: null,
      args: ["tunnel", "--no-autoupdate", "--url", local],
    };
  }

  return {
    error: "No Cloudflare tunnel configured.",
    hints: [
      "Use your own account so the URL is stable and the phone pairs once.",
      "",
      "  Dashboard-managed tunnel (Zero Trust → Networks → Tunnels):",
      `    export CLOUDFLARE_TUNNEL_TOKEN=<token from the dashboard>`,
      `    export HEIR_STUDIO_TUNNEL_HOSTNAME=agent.example.com`,
      `    npm run tunnel`,
      `  Its public hostname must route to ${local}.`,
      "",
      "  Or a locally-managed tunnel:",
      "    cloudflared tunnel login",
      "    cloudflared tunnel create heir-studio",
      "    cloudflared tunnel route dns heir-studio agent.example.com",
      "    HEIR_STUDIO_TUNNEL_NAME=heir-studio \\",
      "      HEIR_STUDIO_TUNNEL_HOSTNAME=agent.example.com npm run tunnel",
      "",
      "  Throwaway URL that changes every restart (not recommended):",
      "    HEIR_STUDIO_TUNNEL_QUICK=1 npm run tunnel",
    ],
  };
}
