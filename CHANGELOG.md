# Changelog

## 1.1.4 — Hotfix 2 — 2026-09-18

- **Artwork page crash.** Fix React #130 when an image has notes: the Notes badge now recognizes Steam's updated controller glyph and always exports a valid React component.
- **Safe fallback.** Keep the badge usable with a local Menu icon when Steam's glyph is missing or its lookup fails. Cache successful lookups and avoid repeating a failed scan for every card.

The previous Installer reproduces the reported failure in actual Steam ReactDOM; this build passes the notes/no-notes and missing-module browser regressions. See `HOTFIX_1.1.4.md` for the current test scope and limits. Version remains 1.1.4; diagnostic build is `1.1.4-hotfix.2`.

## 1.1.4 — Hotfix 1 — 2026-09-18

- **SteamUI safety.** Remove the redundant Home component-type mutation and use immutable, type-aware wrappers for the recent-game cover option. Preserve native memo/forwardRef/class contracts and stable component identities.
- **Menu discovery.** Always restore React hook stubs after probing the game-menu factory, even when it throws. Reuse Steam's own Properties-item component instead of depending on a potentially missing MenuItem export.
- **Window and route detection.** Prefer the main gamepad window and read its logical memory-history route when the browser URL remains `/index.html`.
- **Diagnostics.** Recognize percent-encoded plugin URLs, follow the active gamepad window, identify the hotfix build and isolate errors in the plugin's own page and Quick Access panel.

See `HOTFIX1_1.1.4.md` for reproduced regressions, test results and live-client limitations. The generic error reference alone does not establish the exact cause of the reported crash.

## 1.1.4 — 2026-09-18

- **Steam compatibility.** Resolve the active Big Picture window dynamically, attach the game menu lazily and restore owned patches when unloading. Home and library layout initialization now survives late Steam startup and document replacement without permanently giving up.
- **Artwork search.** Preserve provider errors so missing SteamGridDB associations can recover, avoid stale search results and duplicate pages, and use exact title matches rather than selecting an unrelated first suggestion. iiDB suggestions use typed artwork queries and preserve the selected source-owned game ID.
- **Image handling.** Separate bounded source-image decoding from final artwork limits. Eligible large static images are resized before saving; transparent conversions can shrink to the existing byte budget. Animation is not silently flattened.
- **Lifecycle and diagnostics.** Cancel progress polling and pending UI work on unload, serialize diagnostic batches and handle delayed or synchronous Steam callbacks safely. Retry transient provider GET failures once without disabling TLS verification.

The Windows `WinError 64` traceback supplied for this release originates in Decky Loader's local socket, not in a Playhub Artworks stack frame. This release does not patch Decky Loader or claim to eliminate all transport resets. See `TESTING_1.1.4.md` for verification scope and limits.
