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
 * Build env vars for spawning grok with provider overrides.
 * Does not put secrets in the object — only base URL routing.
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

/**
 * CLI flags for provider (when env is insufficient).
 * grok supports --xai-api-base-url and --cli-chat-proxy-base-url on agent subcommand;
 * for headless top-level we use env only (documented in health).
 */
export function providerToCliArgs(provider) {
  const p = normalizeProviderConfig(provider);
  const args = [];
  // Top-level grok does not document these flags on main; keep empty for spawn args.
  // Encoded in env via providerToEnv.
  void p;
  return args;
}

export function describeProvider(provider) {
  const p = normalizeProviderConfig(provider);
  return {
    ...p,
    active: Boolean(p.gatewayUrl || p.xaiApiBaseUrl || p.cliChatProxyBaseUrl),
  };
}
