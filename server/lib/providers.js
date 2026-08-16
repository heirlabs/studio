/**
 * Third-party / gateway provider configuration.
 * Maps studio settings → env overrides for the grok child process.
 */
export function normalizeProviderConfig(provider = {}) {
  const out = {
    gatewayUrl: null,
    xaiApiBaseUrl: null,
    cliChatProxyBaseUrl: null,
  };
  if (!provider || typeof provider !== "object") return out;
  for (const key of Object.keys(out)) {
    const v = provider[key];
    if (v == null || v === "") {
      out[key] = null;
      continue;
    }
    const s = String(v).trim();
    if (!/^https?:\/\//i.test(s)) {
      const err = new Error(`${key} must be an http(s) URL`);
      err.status = 400;
      throw err;
    }
    out[key] = s.replace(/\/$/, "");
  }
  return out;
}

/**
 * Real CLI flags for provider routing, as accepted by `grok agent` (verified
 * against grok 0.2.117). The top-level headless command exposes no equivalent,
 * so only the ACP transport can route deterministically — see providerToEnv.
 */
export function providerToAgentCliArgs(provider) {
  const p = normalizeProviderConfig(provider);
  const args = [];
  const apiBase = p.xaiApiBaseUrl || p.gatewayUrl;
  const proxyBase = p.cliChatProxyBaseUrl || p.gatewayUrl;
  if (apiBase) args.push("--xai-api-base-url", apiBase);
  if (proxyBase) args.push("--cli-chat-proxy-base-url", proxyBase);
  return args;
}

/**
 * Build env vars for spawning grok with provider overrides.
 * Does not put secrets in the object — only base URL routing.
 *
 * NOTE: these variable names are not documented by the grok CLI, so this is
 * best-effort and is the only lever available on the headless top-level
 * command. Interactive (ACP) runs additionally pass the documented flags from
 * providerToAgentCliArgs, which is the reliable path.
 */
export function providerToEnv(provider, baseEnv = process.env) {
  const p = normalizeProviderConfig(provider);
  const env = { ...baseEnv };
  // Prefer explicit CLI proxy / API base if set
  if (p.cliChatProxyBaseUrl) {
    env.GROK_WS_ORIGIN = p.cliChatProxyBaseUrl;
    env.CLI_CHAT_PROXY_BASE_URL = p.cliChatProxyBaseUrl;
  }
  if (p.xaiApiBaseUrl) {
    env.XAI_API_BASE_URL = p.xaiApiBaseUrl;
  }
  if (p.gatewayUrl) {
    // Generic gateway: route both proxy and API through gateway if specifics unset
    if (!p.cliChatProxyBaseUrl) {
      env.CLI_CHAT_PROXY_BASE_URL = p.gatewayUrl;
      env.GROK_WS_ORIGIN = p.gatewayUrl;
    }
    if (!p.xaiApiBaseUrl) {
      env.XAI_API_BASE_URL = p.gatewayUrl;
    }
  }
  return { env, provider: p };
}

export function describeProvider(provider) {
  const p = normalizeProviderConfig(provider);
  return {
    ...p,
    active: Boolean(p.gatewayUrl || p.xaiApiBaseUrl || p.cliChatProxyBaseUrl),
  };
}
