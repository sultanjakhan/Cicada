# Dependency checks

Issue [#64](https://github.com/sultanjakhan/hanni-tasks/issues/64) owns the current work and handoff. These checks cover known dependency advisories and vendor provenance, not native WebView behaviour or every application vulnerability.

Run on Windows from the repository root:

```powershell
npm ci
npm run check:vendor
npm audit --audit-level=low
powershell -NoProfile -File scripts/audit-rust.ps1
```

CI runs these checks before tests and packaging. Scanner errors fail the job. `npm audit` includes both runtime and development dependencies. The 11 shipped EditorJS/DOMPurify files are exact runtime dependencies in the root lockfile: `check:vendor` verifies complete inventory coverage, declared/locked/installed versions, and SHA-256 equality with the installed package member. The browser still loads the same vendored files; no editor update or runtime import change was made. EditorJS's internal `version` string says `2.31.0`, but its bytes match the published **2.31.0-rc.2** package.

When updating a vendor dependency, update its exact package version/lockfile, copy the intended published member into `src/public/vendor`, and update `scripts/vendor-manifest.json` together. Review the resulting vendor diff and repeat the real EditorJS Notes regressions. A digest verifies correspondence with an audited package; it does not prove the package contains no unknown vulnerability.

`audit-rust.ps1` downloads official cargo-audit 0.22.2 into ignored `.local/security-tools`, checks the pinned release archive and executable hashes, then fetches the current RustSec database. It does not install a global tool or change Cargo.lock. Known vulnerabilities and yanked packages fail. RustSec informational warnings remain visible; no advisory IDs are suppressed and there is no stale-database/offline fallback.

## Reviewed informational warnings, 2026-09-12

Full Cargo.lock scan: 445 dependencies, RustSec commit `b50980aad8b8f14f77e25a97b32dd94bf008b0af` (1243 advisories), zero entries in the vulnerabilities category, six unmaintained warnings and one unsound warning.

- `glib 0.18.5`, [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html): an unsound string iterator can crash affected builds. `cargo tree --locked --target x86_64-pc-windows-msvc --invert glib` has no path in the current Windows build. This is not a Linux acceptance result; reassess before supporting Linux. Replacing GTK/Tauri's transitive ABI solely to silence a Windows-inapplicable warning is outside this change.
- `proc-macro-error 1.0.4`, [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html): unmaintained, also absent from the current Windows target graph.
- `unic-char-property`, `unic-char-range`, `unic-common`, `unic-ucd-ident`, `unic-ucd-version`, all `0.9.0`: unmaintained ([RustSec](https://rustsec.org/advisories/RUSTSEC-2025-0100.html)). They remain reachable on Windows through `urlpattern -> tauri-utils`; this is an upstream maintenance risk, not a demonstrated exploit. No compatible patch is advertised in these notices. Reassess with a compatible upstream Tauri/urlpattern update instead of overriding transitive APIs blindly.

A successful scan with these informational warnings is not a claim of zero security concerns. The report is a dated snapshot; CI checks the current databases again on each push/PR.

Primary sources: [cargo-audit releases](https://github.com/rustsec/rustsec/releases/tag/cargo-audit/v0.22.2), [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/), exact npm registry tarballs recorded by the root package-lock integrity fields.
