# APNs credentials

Drop your own Apple Push certificates or `.p8` keys here if you want the
Mac server to notify the iOS app. **Nothing in this directory is committed.**

Typical files:

| File | What it is |
|------|------------|
| `apns-heir-studio.crt.pem` | App ID SSL certificate (PEM) |
| `apns-heir-studio.key` | Matching private key |
| `AuthKey_XXXXXXXXXX.p8` | APNs token key (alternative to the cert pair) |

Set the matching env vars instead of relying on these filenames if you prefer.
See [docs/environment.md](../../docs/environment.md).

Never commit `.cer`, `.csr`, `.p8`, `.pem`, or `.key` files.
