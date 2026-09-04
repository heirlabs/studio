# Heir Studio for iOS

Prompt the Heir Studio coding agent on your Mac from your phone: start a turn,
watch the live token/tool stream, approve or deny tool permissions, cancel,
browse files, and run basic git.

The phone reaches the Mac over **Tailscale** (private WireGuard) or a
**Cloudflare Tunnel**. Every request carries a bearer token.

## Threat model, briefly

Heir Studio runs shell commands in a project directory. Remote access is
therefore gated on **two** independent things:

1. the source address is inside an allowed range (default `100.64.0.0/10` and
   `fd7a:115c:a1e0::/48`, i.e. Tailscale only), **and**
2. a bearer token, compared in constant time.

On top of that, a run started by a remote client **cannot inherit
`bypassPermissions`**. It is always downgraded to a mode that asks. A request
flag cannot opt back in.

Put **Cloudflare Access** in front of a public hostname (email one-time PIN
for you, plus a service token for the iPhone). The app bearer is then a second
gate, not the only one.

The token lives in the iOS Keychain (`WhenUnlockedThisDeviceOnly`, never
synced).

## Setup: Cloudflare Tunnel (recommended)

One command. It starts the server and opens the tunnel. The pairing secret is
written to `data/pairing.url` (mode 0600), never to the log:

```bash
cp .env.tunnel.example .env.tunnel
chmod 600 .env.tunnel
# fill HEIR_STUDIO_TUNNEL_HOSTNAME and CLOUDFLARE_TUNNEL_TOKEN (or TUNNEL_NAME)
npm run tunnel
```

This exists as a command rather than a doc snippet for a reason: a tunnel
terminates locally, so cloudflared's requests arrive from `127.0.0.1`. Running
the server by hand with loopback still trusted would hand the public internet
an unauthenticated shell. `npm run tunnel` forces `trustLoopback: false`, so
the token is required on every request.

The pairing secret is **not** printed to the tunnel log. On the Mac:

```bash
open "$(tr -d '\n' < data/pairing.url)"
# or
curl -s http://127.0.0.1:3847/api/remote/pairing
```

AirDrop the pairing link if you must move it. Do not paste it into Messages or
Notes. Those land in backups and lock-screen previews.

**What this exposes.** The URL is public until Cloudflare Access is on. The
bearer is still equivalent to a shell if it leaks. Rotate immediately if it
does:

```bash
curl -X POST http://127.0.0.1:3847/api/remote/rotate
```

Stop a hand-started tunnel with Ctrl-C. The login item below is the attended,
always-on path.

## Mac stays reachable

Install a user LaunchAgent so the named tunnel comes up at login:

```bash
# once, no sudo — substitutes this checkout into the plist
./scripts/install-login-tunnel.sh

# undo
./scripts/uninstall-login-tunnel.sh
```

That installs `ai.heir.studio.tunnel`, which runs
`scripts/macos/tunnel-login.sh` → `npm run tunnel`. It will not start a second
server if port 3847 is already listening. Logs:
`~/Library/Logs/heir-studio-tunnel.log` (owner-only).

## Cloudflare Access (second factor)

Do this in the Zero Trust dashboard.

1. **Zero Trust → Integrations → Identity providers → Add → One-time PIN.**
2. **Access controls → Service credentials → Service Tokens → Create**
   a token for the iPhone. Copy the Client ID and Client Secret once.
3. Put them in `.env.tunnel` (gitignored, mode 0600):

   ```
   CF_ACCESS_CLIENT_ID=….access
   CF_ACCESS_CLIENT_SECRET=…
   ```

4. **Access controls → Applications → Add an application → Self-hosted**
   - Name: `Heir Studio`
   - Domain: the hostname you set as `HEIR_STUDIO_TUNNEL_HOSTNAME`
   - Session duration: 24 hours
5. Add **two** policies, in this order:
   - **Service Auth** — include the iPhone service token
     (sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`).
   - **Allow** — include your email, identity provider = One-time PIN
     (OTP for a browser hitting the hostname).
6. Restart the tunnel so pairing picks up the service token, then re-pair
   the phone from the Mac (`open "$(tr -d '\n' < data/pairing.url)"`).

Until the iOS build you install knows how to send the Access service token,
**do not enable the Access application** or the phone will get a login HTML
page instead of JSON.

Sleep-proofing is `caffeinate -dims` inside `scripts/tunnel.mjs`, not
`pmset`. The Mac will not idle-sleep while the tunnel process is up. Closing
a MacBook lid still sleeps; leave it open and plugged in.

## Setup: Tailscale (alternative)

Private WireGuard network, never internet-facing. Preferable when both
devices are already on the same tailnet.

### 1. Tailscale on both devices

Install Tailscale on the Mac and the iPhone and sign both into the same
tailnet. Confirm the Mac has a `100.x.y.z` address:

```bash
ipconfig getifaddr utun3 2>/dev/null || ifconfig | grep 'inet 100\.'
```

### 2. Start Heir Studio bound to the tailnet

```bash
HEIR_STUDIO_REMOTE=1 HEIR_STUDIO_HOST=100.x.y.z npm start
```

Binding to `127.0.0.1` (the default) is deliberate. The phone cannot reach it
until you opt in with `HEIR_STUDIO_HOST`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `HEIR_STUDIO_REMOTE` | off | `1` enables remote access and creates the token |
| `HEIR_STUDIO_HOST` | `127.0.0.1` | address to bind; set to the tailnet IP |
| `HEIR_STUDIO_REMOTE_CIDRS` | Tailscale ranges | comma-separated allow-list |
| `HEIR_STUDIO_TRUST_LOOPBACK` | `1` | `0` requires a token from loopback too. **Set this when fronting the server with a tunnel.** |

### 3. Pair the phone

```bash
curl -s http://127.0.0.1:<port>/api/remote/pairing | python3 -m json.tool
```

This endpoint is **loopback-only**. A paired phone cannot read it. It returns
the URL, the token, and `hints` telling you what is still missing.

Pair by either route:

- **QR** — render the payload as a QR code and scan it in the app.
- **Link** — open `heirstudio://pair?url=<host:port>&token=<token>` on the
  phone. This pre-fills the fields; connecting stays an explicit tap, because
  a link can arrive from anywhere.

Rotate a leaked token with `POST /api/remote/rotate` (also loopback-only),
then restart the server and re-pair.

### Approvals will not prompt if the CLI overrides them

`grok agent stdio` accepts no `--permission-mode`, so a `permission_mode =
"always-approve"` (or `yolo = true`) in `~/.grok/config.toml` wins over
whatever mode you pick, and no permission request will ever reach the phone.
The app surfaces this in Connection settings. Remove that line to get
approvals.

## Building

```bash
brew install xcodegen        # once
cd ios && xcodegen generate  # regenerate HeirStudio.xcodeproj from project.yml
```

`HeirStudio.xcodeproj` is generated. Edit `project.yml`, not the pbxproj.

Forks: set `DEVELOPMENT_TEAM` in `project.yml` to your Apple Team ID before
you expect device or TestFlight signing to work.

```bash
# simulator build + unit tests
xcodebuild test -project HeirStudio.xcodeproj -scheme HeirStudio \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES
```

Signing must stay enabled even for the simulator: without the
`keychain-access-groups` entitlement the Keychain returns `-34018` and the
app cannot store the pairing token.

## TestFlight / App Store

Official builds use bundle id `com.heir.studio.mobile`. Change that (and the
APNs topic) if you ship your own copy.

```bash
cd ios
xcodebuild -project HeirStudio.xcodeproj -scheme HeirStudio \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/HeirStudio.xcarchive archive
```

```bash
cd ios
xcodebuild -exportArchive -archivePath build/HeirStudio.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export
```

Then upload from Xcode Organizer, or:

```bash
xcrun altool --upload-app -f ios/build/export/HeirStudio.ipa -t ios \
  --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
```

Before the first upload, in App Store Connect:

1. Register the bundle id under your team.
2. Create the app record.
3. Answer the export-compliance question. The app uses only standard HTTPS/TLS
   and platform crypto, so the usual answer is "no non-exempt encryption".
4. Add yourself as an internal tester. Internal testing needs no Beta App
   Review; external testers do.

Bump `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in `project.yml` for each
upload. App Store Connect rejects a duplicate build number.

### Privacy answers

The app collects nothing and has no analytics or third-party SDKs. It talks
only to the Mac you pair it with. Camera access is used solely to scan the
pairing QR code.

## Layout

```
ios/
  project.yml                  # xcodegen source of truth
  ExportOptions*.plist         # app-store-connect export
  HeirStudio/
    HeirStudioApp.swift        # app entry, banner, deep-link intake
    PairingView.swift          # QR + manual entry
    SessionListView.swift      # chats, connection settings
    ChatView.swift             # transcript, composer, tool strip, permission sheet
    ChatModel.swift            # streaming, reattach, permission handling
    AppModel.swift             # pairing, health, session list
    StudioClient.swift         # REST + SSE (URLSession.bytes, bearer auth)
    Keychain.swift             # token storage
    Models.swift               # wire types
  HeirStudioTests/             # decoding + config unit tests
```

## What is verified, and what is not

Verified in the simulator against a real Heir Studio server with auth on:
pairing, token storage, 401 on a bad/absent token, session list and creation,
live SSE streaming mid-run, reattach to a turn started elsewhere, run
completion, tool cards with real names and payloads, the permission sheet
(Allow → agent proceeds), and the remote `bypassPermissions` downgrade.

Verified over a real public Cloudflare Tunnel: 401 without a token and with a
wrong token, static assets equally gated, 403 on the pairing endpoint so a
phone cannot exfiltrate the token, successful pairing over HTTPS, re-pairing
to a rotated tunnel URL, and the approval-conflict warning.

Related: [docs/environment.md](../docs/environment.md),
[docs/architecture.md](../docs/architecture.md),
[SECURITY.md](../SECURITY.md).
