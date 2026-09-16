# Third-party components

The root [MIT license](LICENSE) covers Hanni-owned source, including the owner's
Calendar components adapted from Hanni. It does not replace third-party terms.
The original Calendar provenance is recorded in
[docs/upstream-calendar.json](docs/upstream-calendar.json).

The complete dependency inventory, copyright notices and license texts are in
[the bundled notices](src/public/vendor/licenses/THIRD_PARTY_NOTICES.md).
That directory is included in the application resources on Windows and Android.
It covers the shipped Editor.js tools, DOMPurify, Highlight.js, Marked and the
resolved Rust dependency graph. Some listed crates are build-only or target-specific.

DOMPurify is used under its Apache-2.0 option. Dual-licensed dependencies retain
their upstream license choices; MIT on this repository does not relicense them.
MPL-2.0 components remain available as source through the exact package versions
and upstream links in the inventory and `src-tauri/Cargo.lock`. No changes were
made to their upstream source files for this release.

When updating dependencies, refresh this inventory and retain the upstream
copyright/license files. Distribute the notices with binary releases as well as
with source copies.
