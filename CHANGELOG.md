# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-10-19

### Added

- **Browser-style find bar in the conversation (`Ctrl/Cmd+F`).** A small floating bar searches the
  rendered transcript, paints every match with the CSS Custom Highlight API — no DOM mutation — and
  scrolls the active match into view. `Enter` / `Shift+Enter` (or the ‹ › buttons) cycle matches,
  `Esc` closes. The session header's magnifier now opens this bar as well.
  - DSH exposes no public "scroll to seq" API and the chat virtualizer decides what is in the DOM,
    so matches come from the text the transcript has rendered — the same boundary a browser's
    find-in-page works under. *Search all history* hands the query to the indexed dialog, which
    sees every stored record including history the chat has not rendered yet.
  - Strictly additive: the transcript DOM is never mutated, and the bar degrades to "no matches"
    when the Custom Highlight API or the transcript container is unavailable.
- The `Ctrl/Cmd+F` shortcut is declared on desktop profiles only and registered behind the same
  guard as the existing one, so a future conflicting default can never fail activation.

## [0.2.1] — 2026-10-19

### Fixed

- **No highlight in the hit context view when it was opened from the global page.** The dialog
  carried the hit but not the query terms, so the context renderer had nothing to mark. The query
  and its terms now travel with the hit, the dialog seeds its search box with that query, and the
  match marker itself was made clearly visible (stronger fill, ring, bold).
- **The session scope picker listed every indexed session** instead of the sessions that actually
  matched. The host now returns per-session match facets from the same scan — counted across all
  sessions even when the hits are scoped — and the picker shows only those sessions, with hit
  counts (`title (12)`). With no active query it still lists recent sessions.

## [0.2.0] — 2026-10-19

### Added

- **Session-scoped search.** Search the content of one session instead of every session:
  - a search button in the conversation header's right-aligned utilities
    (`conversation.session.header.utilities`), opening a dialog already scoped to the
    current session;
  - a session scope picker on the global search page, listing indexed sessions by title,
    so a query can be narrowed to one session.
- **Hit context view.** A hit expands into the records around it (four before, four after),
  with the matched record highlighted and untruncated, plus previous/next hit navigation
  and an "open session" action. DSH exposes no public "scroll to seq" API, so this is how a
  hit is located: the match is shown in its own context rather than scrolling the transcript.
- Host endpoints `sessions` (scope-picker rows) and `context` (records around a hit), and
  `sessionIds` scoping enforced end to end. A caller that names explicit sessions bypasses
  the subagent default, so an in-session search inside a subagent session works.

### Changed

- Clicking a hit on the global search page now opens the hit's context view; opening the
  session itself is one click further, through "Open session" in that view.

## [0.1.1] — 2026-10-19

### Fixed

- **A conflicting default shortcut could fail the whole application boot.** Version 0.1.0 also
  registered `Ctrl/Cmd+Shift+F` on the Web profiles. DeepSeek Harness 0.2.1-rc.2 ships
  `session.fork` (`dsh-client-ui-workspace`) bound to `KeyF + primary+shift` on Web, and
  `dsh-client-shortcuts` validates a definition's defaults across every *declared* profile,
  throwing `Conflicting shortcut defaults` from whichever plugin registers second. That was
  `ui-workspace`: its failure left 16 client entries pending on the `uiWorkspace` service and
  turned the renderer boot into a fatal `web boot: 17 entries did not activate`, after which
  DSH's crash recovery sanitized the profile back to its default bundle list.
  The shortcut is now declared on **desktop profiles only**, and its registration is guarded so a
  future conflict degrades to "no shortcut" instead of failing plugin activation.

- Dropped the unused `@deepseek-ai/cordis` peer dependency. The plugin imports no Harness package,
  so the peer only produced a pnpm warning on `link:` installs and could trip a future peer-range
  compatibility gate. The plugin now declares no dependencies at all.

### Added

- Regression test: a rejected shortcut registration must not break plugin activation.

## [0.1.0] — 2026-10-16

### Added

- Host-side incremental index over DSH session transcripts (`session.v*.jsonl.zstd`), decoding the
  concatenated Zstandard frames that Node's zstd stream stops short of.
- A Connection RPC channel exposing content search where every hit carries the matched record's own
  `time`, so results are ordered by content time — which the shipped `session.search` remote cannot
  do, because it drops `bestMatch.time`.
- A sidebar search panel: a `sidebar.panellist` icon (between *Plugins* and *Schedules*) with the
  matching full-width `main` panel, kind filters, subagent toggle and highlighted snippets.
- `Ctrl/Cmd+Shift+F` shortcut (desktop profiles).
- 18 tests covering the host round trip over a real corpus and the browser half's module, slot and
  render behaviour.

[0.1.1]: https://github.com/Victue/dsh-session-search/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Victue/dsh-session-search/releases/tag/v0.1.0
