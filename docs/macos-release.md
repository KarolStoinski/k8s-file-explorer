# macOS release

If a DMG built on one Mac is copied to another Mac and the installed app shows
as damaged, Gatekeeper is usually rejecting an unsigned or non-notarized build.
The local development build may run on the build machine, but a distributable DMG
must be signed with a Developer ID certificate and notarized by Apple.

## Quick local workaround

Use this only for a trusted build on your own machine. It removes the quarantine
attribute added by downloads and file transfers:

```bash
xattr -dr com.apple.quarantine "/Applications/K8s File Explorer.app"
```

Do not use this as the distribution path for users.

## Prerequisites

- Apple Developer Program membership.
- A `Developer ID Application` certificate in Keychain Access.
- Notarization credentials, either an App Store Connect API key or an Apple ID
  app-specific password.

Check available signing identities:

```bash
security find-identity -v -p codesigning
```

For this repository, the current local certificate is:

```text
Developer ID Application: Karol Stoinski (FKD7Y4C95K)
```

## Build a signed and notarized DMG

Preferred authentication is an App Store Connect API key:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Karol Stoinski (FKD7Y4C95K)"
export APPLE_API_KEY="YOUR_KEY_ID"
export APPLE_API_ISSUER="YOUR_ISSUER_UUID"
export APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_YOUR_KEY_ID.p8"

npm run tauri:build:mac
```

Alternatively, use an Apple ID app-specific password:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Karol Stoinski (FKD7Y4C95K)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="FKD7Y4C95K"

npm run tauri:build:mac
```

Tauri signs the app and DMG when `APPLE_SIGNING_IDENTITY` is present. When the
notarization environment variables are also present, Tauri submits the app to
Apple, waits for notarization, and staples the ticket unless `--skip-stapling`
is passed.

To build a universal Apple Silicon + Intel DMG, install both Rust macOS targets
and run:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:build:mac:universal
```

## Verify the artifact

After the build, run:

```bash
npm run mac:release:verify
```

The verification should show a Developer ID authority, a TeamIdentifier, accepted
Gatekeeper checks, and valid stapled notarization tickets for both the `.app` and
the `.dmg`.
