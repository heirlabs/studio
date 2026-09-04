# Environment and settings reference

Every process-level knob Heir Studio reads. Defaults are what you get with
`npm start` and no extra env.

## Server bind and remote access

| Variable | Default | Meaning |
|----------|---------|---------|
| `HEIR_STUDIO_HOST` | `127.0.0.1` | Listen address. Set to a tailnet IP only when you want the phone on Tailscale. |
| `HEIR_STUDIO_PORT` | `3847` | Listen port for `npm start` / `npm run tunnel`. Electron uses an ephemeral port unless it attaches to this one. |
| `HEIR_STUDIO_REMOTE` | off | `1` enables remote access and creates `data/remote-access.json` (mode `0600`). |
| `HEIR_STUDIO_REMOTE_CIDRS` | Tailscale `100.64.0.0/10` and `fd7a:115c:a1e0::/48` | Comma-separated allow-list. |
| `HEIR_STUDIO_TRUST_LOOPBACK` | `1` | `0` requires a bearer token even from `127.0.0.1`. **`npm run tunnel` forces this off.** |

`GROK_BIN` overrides grok discovery. Otherwise: `~/.grok/bin/grok`,
`/usr/local/bin/grok`, `/opt/homebrew/bin/grok`, then `which grok`.

`XAI_API_KEY` is read by the Grok CLI, not by Studio. `grok login` is the
usual path.

## Cloudflare tunnel (`npm run tunnel`)

Loaded from `.env.tunnel` if present (gitignored). Env already set in the
shell wins.

| Variable | Default | Meaning |
|----------|---------|---------|
| `HEIR_STUDIO_TUNNEL_HOSTNAME` | (required for named/token) | Public hostname the phone should open. Example: `studio.example.com`. |
| `CLOUDFLARE_TUNNEL_TOKEN` | unset | Dashboard-managed tunnel token. Written to a `0600` file, never placed on argv. |
| `CLOUDFLARE_TUNNEL_TOKEN_FILE` | `~/.cloudflared/heir-studio.token` | Existing token file, used as-is. |
| `HEIR_STUDIO_TUNNEL_NAME` | unset | Locally-managed named tunnel (`cloudflared tunnel login` required). |
| `HEIR_STUDIO_TUNNEL_QUICK` | off | `1` uses a throwaway `trycloudflare.com` URL. Changes every restart. |
| `CF_ACCESS_CLIENT_ID` | unset | Cloudflare Access service-token id, embedded in the pairing payload. |
| `CF_ACCESS_CLIENT_SECRET` | unset | Matching secret. |

Copy [`.env.tunnel.example`](../.env.tunnel.example) to `.env.tunnel` and
`chmod 600` it.

## APNs (optional)

Push is a no-op until devices are registered **and** credentials exist.
Missing keys never fail a coding run.

| Variable | Default | Meaning |
|----------|---------|---------|
| `HEIR_STUDIO_APNS_CERT_PATH` | `ios/certs/apns-heir-studio.crt.pem` if that file exists | App ID SSL cert (PEM). |
| `HEIR_STUDIO_APNS_TLS_KEY_PATH` | `ios/certs/apns-heir-studio.key` if that file exists | Matching private key. |
| `HEIR_STUDIO_APNS_KEY_PATH` | unset | `.p8` token key. Key id is parsed from `AuthKey_<ID>.p8` when unset. |
| `HEIR_STUDIO_APNS_KEY_ID` | from filename | Required for token auth if the filename does not carry it. |
| `HEIR_STUDIO_APNS_TEAM_ID` | unset | Apple Team ID. Required for token auth. |
| `HEIR_STUDIO_APNS_BUNDLE_ID` | `com.heir.studio.mobile` | APNs topic. |
| `HEIR_STUDIO_APNS_PRODUCTION` | cert: on, token: off | `1` / `0`. Token auth defaults to sandbox unless you set `1`. |
| `HEIR_STUDIO_APNS_HOST` | derived | Override `api.push.apple.com` / `api.sandbox.push.apple.com`. |

Cert + key wins over token auth when both are present. Do not commit anything
under `ios/certs/` except the README.

## Provider routing (passed through to grok)

Set from the Settings UI (`/api/provider`). On ACP, Studio passes
`--xai-api-base-url` and `--cli-chat-proxy-base-url`. On headless, it sets
`XAI_API_BASE_URL` and `GROK_WS_ORIGIN` in the child env only.

## Settings files (not env)

| Scope | Path | Typical contents |
|-------|------|------------------|
| User | `~/.heir-studio/settings.json` | Permission default, budget cap, sandbox profile |
| User | `~/.heir-studio/keybindings.json` | Chord overrides |
| Project | `<cwd>/.heir-studio/settings.json` | Per-repo overrides |
| Local | `data/settings.local.json` | Machine-only, gitignored |

Layers are merged user → project → local (later wins).

## Limits baked into `createConfig`

These are code defaults, not env vars. Change them in tests via
`createConfig({ … })` or a settings key where one exists.

| Key | Default |
|-----|---------|
| `maxConcurrentRuns` | `3` (HTTP 429 after that) |
| `maxUploadBytes` | 80 MiB |
| `maxUploadFiles` | 20 |

Daily budget (`maxBudgetUsd`) lives in settings. The ledger is a local
estimate. See the known-limits section in the [README](../README.md).
