# Private Hanni MVP update delivery

This Worker serves an already-built Tauri update manifest and release files from
Cloudflare Static Assets. It does not generate manifests, write storage, list
directories, or make the files public.

Only `GET` and `HEAD` are accepted. `/health` returns `ok`. The manifest is
available at `/latest.json`; release files are limited to one safe filename
under `/releases/`. Both require `Authorization: Bearer <UPDATES_TOKEN>`.
Requests are routed through the Worker before Static Assets so an asset cannot
bypass this check. The Worker strips the Authorization header before forwarding
to the asset binding and streams the response body without reading it into
memory. Every response is `private, no-store`.

`UPDATES_TOKEN` is an encrypted Worker secret, never a `vars` entry:

```powershell
wrangler secret put UPDATES_TOKEN
```

Deploy only after the release pipeline has created `../.local/update-assets`:

```
latest.json
releases/Hanni-MVP-<version>-windows-x64.zip
releases/Hanni-MVP-<version>-android-arm64.apk
```

Those artifacts are ignored and must not be committed. The Tauri updater owns
the JSON schema and signature validation; this Worker sends the files unchanged.

Run the local integration suite from this directory after making the existing
shared Node dependencies visible (for example with an ignored `node_modules`
junction to `../sync-relay/node_modules`):

```powershell
npm test
wrangler deploy --dry-run
```

Cloudflare's current Static Assets limit is 25 MiB per individual file on both
Free and Paid Workers plans. Keep each APK at or below that size before deploy.

The local Miniflare fixture verifies that a `Range` request reaches the assets
binding unchanged. Its current local runtime returns the full asset (`200`) for
that fixture; range support must be rechecked against the deployed Worker before
making a resumable-download claim.
