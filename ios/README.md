# Heir Studio for iOS

Prompt the Heir Studio coding agent on your Mac from your phone: start a turn,
watch the live token/tool stream, approve or deny tool permissions, cancel.

The phone reaches the Mac over **Tailscale** — a private WireGuard network, never
the public internet — and every request carries a bearer token.

## Threat model, briefly

Heir Studio runs shell commands in a project directory. Remote access is
therefore gated on **two** independent things:

1. the source address is inside an allowed range (default `100.64.0.0/10` and
   `fd7a:115c:a1e0::/48`, i.e. Tailscale only), **and**
2. a bearer token, compared in constant time.

On top of that, a run started by a remote client **cannot silently inherit
`bypassPermissions`** — it is downgraded to a mode that asks, unless the client
explicitly sends `allowBypassPermissions: true`. If the token ever leaked, the
attacker still faces an approval prompt rather than a shell.

The token lives in the iOS Keychain (`WhenUnlockedThisDeviceOnly`, never synced).

## Setup — Cloudflare Tunnel (recommended)

One command. It starts the server, opens the tunnel, and prints a pairing link:

```bash
npm run tunnel
```

This exists as a command rather than a doc snippet for a reason: a tunnel
terminates locally, so cloudflared's requests arrive from `127.0.0.1`. Running
the server by hand with loopback still trusted would hand the public internet an
unauthenticated shell. `npm run tunnel` forces `trustLoopback: false`, so the
token is required on every request.

Pair by sending yourself the printed `heirstudio://pair?...` link (Messages,
Notes, AirDrop) and tapping it on the phone. It pre-fills the fields; you still
tap Connect. If the phone is already paired you get a "Connect to this Mac?"
confirmation — which you will use often, because a free quick-tunnel URL changes
on every restart. A stable hostname needs a Cloudflare account and a domain.

**What this exposes.** The URL is public. The bearer token is the only thing
between it and a shell on your Mac; repeated bad tokens get throttled, but
anyone holding both URL and token is in. Rotate immediately if it leaks:

```bash
curl -X POST http://127.0.0.1:3847/api/remote/rotate
```

Stop a hand-started tunnel with Ctrl-C. The login item below is the
attended, always-on path for this Mac.

## Mac stays reachable

On this Mac the named tunnel should come up at login so the phone can reach
`https://studio.heir.es` without anyone running `npm run tunnel` by hand.

```bash
# once, no sudo
./scripts/install-login-tunnel.sh

# undo
./scripts/uninstall-login-tunnel.sh
```

That installs a user LaunchAgent (`ai.heir.studio.tunnel`) which runs
`scripts/macos/tunnel-login.sh` → `npm run tunnel` (named tunnel from
`.env.tunnel`). It will not start a second server if port 3847 is already
listening. Logs: `~/Library/Logs/heir-studio-tunnel.log`.

Sleep-proofing is `caffeinate -dims` inside `scripts/tunnel.mjs`, not
`pmset`. The Mac will not idle-sleep while the tunnel process is up.
Closing a MacBook lid still sleeps; leave it open and plugged in.

## Setup — Tailscale (alternative)

Private WireGuard network, never internet-facing. Preferable when it works.

### 1. Tailscale on both devices

Install Tailscale on the Mac and the iPhone and sign both into the same tailnet.
Confirm the Mac has a `100.x.y.z` address:

```bash
ipconfig getifaddr utun3 2>/dev/null || ifconfig | grep 'inet 100\.'
```

### 2. Start Heir Studio bound to the tailnet

```bash
HEIR_STUDIO_REMOTE=1 HEIR_STUDIO_HOST=100.x.y.z npm start
```

Binding to `127.0.0.1` (the default) is deliberate — the phone cannot reach it
until you opt in with `HEIR_STUDIO_HOST`.

| Variable | Default | Meaning |
|---|---|---|
| `HEIR_STUDIO_REMOTE` | off | `1` enables remote access and creates the token |
| `HEIR_STUDIO_HOST` | `127.0.0.1` | address to bind; set to the tailnet IP |
| `HEIR_STUDIO_REMOTE_CIDRS` | Tailscale ranges | comma-separated allow-list |
| `HEIR_STUDIO_TRUST_LOOPBACK` | `1` | `0` requires a token from loopback too — **set this when fronting the server with a tunnel**, or the tunnel hands the internet an unauthenticated shell |

### 3. Pair the phone

```bash
curl -s http://127.0.0.1:<port>/api/remote/pairing | python3 -m json.tool
```

This endpoint is **loopback-only** — a paired phone cannot read it. It returns
the URL, the token, and `hints` telling you what is still missing.

Pair by either route:
- **QR** — render the payload as a QR code and scan it in the app.
- **Link** — open `heirstudio://pair?url=<host:port>&token=<token>` on the phone.
  This pre-fills the fields; connecting stays an explicit tap, because a link can
  arrive from anywhere.

Rotate a leaked token with `POST /api/remote/rotate` (also loopback-only), then
restart the server and re-pair.

### Approvals will not prompt if the CLI overrides them

`grok agent stdio` accepts no `--permission-mode`, so a `permission_mode =
"always-approve"` (or `yolo = true`) in `~/.grok/config.toml` wins over whatever
mode you pick, and no permission request will ever reach the phone. The app
surfaces this in Connection settings; remove that line to get approvals.

## Building

```bash
brew install xcodegen        # once
cd ios && xcodegen generate  # regenerate HeirStudio.xcodeproj from project.yml
```

`HeirStudio.xcodeproj` is generated — edit `project.yml`, not the pbxproj.

```bash
# simulator build + unit tests
xcodebuild test -project HeirStudio.xcodeproj -scheme HeirStudio \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES
```

Signing must stay enabled even for the simulator: without the
`keychain-access-groups` entitlement the Keychain returns `-34018` and the app
cannot store the pairing token.

## TestFlight

**Done on this machine (2026-08-16):** bundle id `com.heir.studio.mobile`
registered under team `2Y8MR5FHTC` (id `G6X6WDPDN7`), App Store profile
`Heir Studio App Store` created, export compliance in Info.plist
(`ITSAppUsesNonExemptEncryption = false`). **1.0.4 (5)** — red HEIR mark
on black — archived, exported to `ios/build/export/HeirStudio.ipa`, and
uploaded to App Store Connect / TestFlight (`xcodebuild -exportArchive`
with `destination: upload`). Processing can take a few minutes before the
build appears in TestFlight. Add `weare@empoweringpeace.net` as an
internal tester if they are not already on the app.

Archive and export are scripted after that:

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

Then upload — either open `build/HeirStudio.xcarchive` in Xcode → Organizer →
Distribute App, or:

```bash
xcrun altool --upload-app -f ios/build/export/HeirStudio.ipa -t ios --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
```

Before the first upload you must, in App Store Connect:

1. Register the bundle id `com.heir.studio.mobile` under team `2Y8MR5FHTC`.
2. Create the app record (Heir Studio).
3. Answer the export-compliance question. The app uses only standard HTTPS/TLS
   and platform crypto, so the usual answer is "no non-exempt encryption".
4. Add yourself as an internal tester — internal testing needs no Beta App
   Review; external testers do.

Bump `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in `project.yml` for each
upload; App Store Connect rejects a duplicate build number.

### Privacy answers

The app collects nothing and has no analytics or third-party SDKs. It talks only
to the Mac you pair it with. Camera access is used solely to scan the pairing QR
code.

## Layout

```
ios/
  project.yml                  # xcodegen source of truth
  ExportOptions.plist          # app-store-connect export
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

Verified over a **real public Cloudflare Tunnel**: 401 without a token and with
a wrong token, static assets equally gated, 403 on the pairing endpoint so a
phone cannot exfiltrate the token, successful pairing over HTTPS, re-pairing to
a rotated tunnel URL, and the approval-conflict warning.

Not yet verified: running on physical hardware, the Tailscale transport
end-to-end, and the TestFlight upload itself.
