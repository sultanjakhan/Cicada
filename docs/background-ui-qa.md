# Background UI checks on Windows

Use Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp),
attached to the **real WebView2 inside the installed MVP** using its
[documented CDP connection](https://playwright.dev/docs/webview2).
This checks the embedded frontend and real Rust/SQLite commands. It is not a
Vite preview and does not mock IPC.

`scripts/qa-background.py` only manages the processes. It starts the verified
installed EXE on a separate, inactive Windows desktop through
[`STARTUPINFO.lpDesktop`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow).
It never switches desktops or sends global keyboard/mouse input. The currently
open application is neither restarted nor automated.

## Prerequisites and connection

- Windows, Python 3.11+, Node.js, and the installed WebView2 runtime.
- Python packages `pywin32` and `psutil`.
- The MVP package built with `npm run package:windows`: a debug binary containing
  its embedded web assets and `HANNI_MVP_DATA_DIR` support. Release builds are not
  supported by this launcher. Verify the installed EXE hash against the package
  before adding it to the local MCP configuration.
- Install the official server locally, without downloading another browser:

```powershell
npm install --prefix .local/playwright-mcp --ignore-scripts --no-audit --no-fund --save-exact @playwright/mcp@0.0.80
```

The local Codex server is named `hanni-mvp-ui`. Its stdio command is Python with:

```text
-B scripts/qa-background.py
--exe <absolute installed hanni-mvp.exe path>
--expected-sha256 <verified installed EXE SHA256>
--mcp-cli <absolute .local/playwright-mcp/node_modules/@playwright/mcp/cli.js path>
--node <absolute node.exe path>
```

Use absolute paths in the machine-local config; do not commit that config.
The launcher verifies binary identity, starts the background instance, verifies
the loopback CDP listener belongs to its child WebView2, and delegates stdio to
the unmodified official MCP. Client disconnection closes the background app and
its children through a Windows job object. Startup timeout is 60 seconds.

Each connection gets fresh SQLite and WebView2 directories under the ignored
`.local/background-qa/` directory. For an explicit restart/persistence test,
reuse `--session <qa-name>`; a Windows file lock prevents concurrent use.
An explicit `--probe` checks launch/isolation and exits without starting MCP.
`runtime.json` records executable identity, app/child PIDs, CDP endpoint and
whether the QA desktop became active during the session.

## Operating limits

- Use snapshot, scoped click/type/select/key actions, page screenshots, console
  and network logs against the single `http://tauri.localhost/` page.
- Do not select/new/navigate browser tabs, upload files, open external URLs,
  invoke native focus/show, use the clipboard or call `bringToFront`.
- Screenshots show only the app's WebView content; they do not include the title
  bar, the Windows desktop, other applications or native file pickers.
- Keep test records fictional. Retain them in the isolated QA profile only as
  long as needed for restart evidence; never import the user's database/profile.
- The CDP port is chosen per connection and verified to listen on loopback only.
  It remains open only while this background instance is running.
- After an application update the EXE hash check deliberately stops launch.
  Verify the new package's debug isolation support and refresh the local pin.
- A successful connection does not establish complete product acceptance.
  Report individual UI scenarios and observed bugs separately.

## Verified setup, 2026-09-12

Installed MVP 0.2.1, source `df4a19b2b65b42a96e39b2d45eaaa7d44fb6889a`:
the official MCP read all four panes, switched to Table, captured the real
WebView and created a fictional task through the UI. The task remained visible
after closing and restarting the background EXE with the same isolated profile.
The QA desktop remained inactive. These checks do not claim full visual parity.

Live inspection also found missing settings-pill styling, an ignored first-day
setting, and CSP errors blocking editor-injected styles. Their fixes and native
visual rechecks remain separate from this connection setup.

## Header creation iteration, 2026-09-12

The shared Task/Event entry now lives in the non-scrolling Calendar header.
The old general Create buttons in Dashboard and Table were removed; calendar
cell creation keeps its date/time context. Closing the shared editor restores
focus to its header button. Header icons retain their square dimensions.

One fictional goal with a long title, description, six criteria and explicit
2-of-6 progress, plus one linked 90-minute task, were created through the
installed application's Playwright MCP in an isolated profile. A SQLite backup
of those records was opened by a locally built native candidate. The persistent
design profile and screenshots are in the ignored
`.local/background-qa/header-design-20260912/` directory; these examples are
retained for the owner's requested design comparison, outside shipped data.

Validation: 102 JavaScript tests, 14 Rust tests, privacy check and both frontend
and native builds passed. Native MCP confirmed the button remains in place
when the task area scrolls, the shared Task/Event switch works, focus returns,
and Table creation retains the viewed date. At a 640-by-500 WebView viewport the
button did not overlap the title and the header icon measured 24-by-24 CSS pixels.
The candidate's Windows desktop remained inactive throughout the check.

The candidate was not installed over the owner's running application. Its
version remains 0.2.1; identify it by the source and executable hash in the local
acceptance file, not as a new public release. The predominantly white/graphite
palette remains a proposal; existing green surfaces have not been replaced.
Previously observed CSP errors remain unresolved, and system zoom at 150/200
percent was not part of this header check.
