# Contributing to Heir Studio

Thanks for wanting to work on this. Heir Studio is a local coding agent: a
macOS (Electron) shell plus a loopback HTTP server that spawns
[Grok Build](https://github.com/xai-org/grok-build) (`grok`). The iOS app is
an optional remote control, not the core.

Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and
[SECURITY.md](SECURITY.md) before you open a PR that touches auth, remote
access, or path handling.

## What you need

- macOS 12+ for the desktop app and iOS project (Linux/CI can run the Node tests)
- Node.js 18 or newer (`node -v`)
- npm 9+ (ships with Node)
- [Grok Build CLI](https://github.com/xai-org/grok-build) on `PATH` or at
  `~/.grok/bin/grok`, authenticated (`grok login` or `XAI_API_KEY`)
- Xcode 16+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen) only if you
  touch `ios/`

You do **not** need Cloudflare, Tailscale, or APNs to run the desktop app or
the test suite.

## First-time setup

```bash
git clone https://github.com/heirlabs/studio.git
cd studio
npm install
npm test
```

That is the bar. If `npm test` is red on `main`, open an issue before you pile
more changes on top.

### Run the app

```bash
npm run app          # Electron window (picks an ephemeral port)
npm start            # browser mode → http://127.0.0.1:3847
npm run dev          # same server, restarted on file change
```

Open a project folder with ⌘O (or the Project control). Coding runs use that
directory as cwd. The Grok binary is resolved from `GROK_BIN`, then
`~/.grok/bin/grok`, then `which grok`.

### Build a macOS `.app`

```bash
npm run dist         # Heir Studio.app under release/mac*/
npm run dist:dmg     # also a .dmg
```

The first launch of an unsigned local build may need right-click → Open.

## How we work

1. Open an issue (or pick an existing one) for anything larger than a typo.
2. Branch from `main`: `git checkout -b fix/short-name`.
3. Keep the change small. One problem per PR.
4. Add or extend a test next to the code you changed.
5. Run `npm test` and `npm run audit`.
6. Open a pull request against `main`. Fill in the template.

Commit messages follow what is already on `main`:

```
feat: rewind, slash commands, and tighter tunnel auth
fix: deny dismissed ACP prompts instead of stalling
docs: document HEIR_STUDIO_TRUST_LOOPBACK
```

Use `feat`, `fix`, `docs`, `test`, `chore`, or `refactor`. Say why in the
subject when the diff is not self-explanatory.

## Tests

```bash
npm test                 # unit + integration, serial
npm run test:unit
npm run test:integration
```

- **Unit** tests live in `test/unit/` and import `server/lib/*` directly.
- **Integration** tests live in `test/integration/`. They start `createApp()`
  on an ephemeral port and spawn `test/fixtures/fake-grok.mjs`.
- The fake grok fixture emits the **same wire shapes as the real CLI**. Do not
  invent a friendlier JSON just to make a test pass.
- Do not mock `server/app.js` or the run supervisor. If a behavior is hard to
  reach, add a fake-grok mode.

iOS:

```bash
brew install xcodegen          # once
cd ios && xcodegen generate
xcodebuild test -project HeirStudio.xcodeproj -scheme HeirStudio \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES
```

Signing must stay on even for the simulator. Without
`keychain-access-groups` the Keychain returns `-34018` and pairing cannot
store the token.

`HeirStudio.xcodeproj` is generated. Edit `ios/project.yml`, not the pbxproj.

## Project map

```
server/             HTTP API + grok supervisor (this is the product)
  index.js          process entry
  start.js          listen / shutdown
  app.js            createApp() — used by tests
  lib/              one concern per file
public/             desktop UI (vanilla JS)
electron/           native shell, menu, notifications
workflows/          prompt catalog (JSON)
ios/                SwiftUI companion, XcodeGen
scripts/            icon, Cloudflare tunnel, login LaunchAgent
test/               unit + integration + fake-grok
docs/               architecture and env reference
```

Match the file that is already there. New HTTP routes go in `server/app.js`
and get an integration test. New CLI flag mapping goes in `server/lib/runs.js`
(or the ACP client) plus `test/unit/runs-build.test.js`.

Settings layers, from lowest to highest priority: user
(`~/.heir-studio/settings.json`), project (`.heir-studio/settings.json`),
local (`data/settings.local.json`).

## Adding a coding workflow

Edit `workflows/catalog.json`. Templates understand `{{prompt}}`, `{{images}}`,
`{{cwd}}`, and `{{#if images}}…{{/if}}`. Keep coding workflows in
`"category": "code"`. Media workflows are optional extras, not the default
path.

## Remote access and secrets

- Never commit `.env.tunnel`, pairing URLs, APNs `.p8` / `.key` / `.cer` files,
  or anything under `data/`.
- `ios/certs/` is gitignored except `ios/certs/README.md`.
- Copy [`.env.tunnel.example`](.env.tunnel.example) to `.env.tunnel` and
  `chmod 600` it.
- `npm run tunnel` is the only supported way to put the server on a public
  hostname. It forces `trustLoopback: false`. Do not "just" bind `0.0.0.0`
  and call it a day.
- LaunchAgent install (`./scripts/install-login-tunnel.sh`) substitutes the
  repo root into the plist. Do not hardcode a machine path.

See [ios/README.md](ios/README.md) and [docs/environment.md](docs/environment.md).

## Review bar

A maintainer will look for:

- Tests that fail if the bug returns
- No new bind-address or auth default that widens exposure
- No secrets, personal home paths, or live hostnames in the diff
- UI changes that still work in both the Electron app and `npm start`

We will not merge a PR that adds an exploit, a "debug backdoor", or a
documented way to skip the bearer token on a tunneled request.

## License

By contributing you agree that your work is licensed under the
[MIT License](LICENSE), the same as the rest of the repository.
