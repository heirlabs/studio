# Security Policy

Heir Studio is a local coding agent. A successful remote bypass is equivalent
to a shell on the Mac that is running it. Treat pairing tokens, tunnel
credentials, and APNs keys as production secrets.

## Supported versions

Security fixes land on `main`. There is no long-term support branch yet.

## What is in scope

- Authentication or authorization bypass on the local HTTP API
- Pairing-token leakage (logs, pairing URL, remote `/api/remote/pairing`)
- Path traversal in run IDs, uploads, file browse, or git endpoints
- Loopback / CIDR / `trustLoopback` mistakes that expose the agent
- Secrets committed to the repo, leaked in CI logs, or written world-readable
- iOS Keychain or deep-link handling that exfiltrates the bearer token

## What is out of scope

- The Grok CLI itself (`grok`) and xAI model behavior
- A user who enabled `bypassPermissions` or `--always-approve` on purpose
- Cloudflare, Tailscale, or Apple infrastructure bugs
- Social-engineering someone into scanning a pairing QR they do not own

## How to report

**Do not file a public GitHub issue for a working exploit.**

1. Open a [private vulnerability advisory](https://github.com/heirlabs/studio/security/advisories/new)
   on this repository.
2. Include: affected commit or version, what you ran, what you expected, what
   happened, and a minimal reproduction. Screenshots of pairing tokens or
   `.env.tunnel` files are not needed. Redact them.

We will acknowledge the report and tell you when a fix is on `main`.

## Hard rules already in the code

- The server binds to `127.0.0.1` unless you set `HEIR_STUDIO_HOST`.
- Non-loopback clients need a bearer token, compared in constant time.
- `npm run tunnel` forces `trustLoopback: false`. A request that arrives
  through cloudflared looks like loopback; without that flag the public
  internet would get an unauthenticated shell.
- A run started by a remote client cannot inherit `bypassPermissions`.
- Pairing (`GET /api/remote/pairing`) and rotate
  (`POST /api/remote/rotate`) are loopback-only.
- Upload and run paths are confined to the data directory. Run IDs must be
  UUIDs.
- The iOS token lives in the Keychain (`WhenUnlockedThisDeviceOnly`, not
  synced).

See [ios/README.md](ios/README.md) for the remote threat model and
[docs/environment.md](docs/environment.md) for the knobs that change it.

## If a token leaked

On the Mac:

```bash
curl -X POST http://127.0.0.1:3847/api/remote/rotate
```

Then re-pair the phone. Rotate Cloudflare Access service tokens and tunnel
tokens the same day if those were exposed too.
