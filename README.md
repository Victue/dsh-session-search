# dsh-session-search

**English** | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that searches the
**content** of every session — not just session titles — and orders hits by the **time of the
matched record**, newest first.

It adds a first-class search destination to the sidebar (a panel icon beside *Plugins* and
*Schedules*, plus a full-width results page) and a `Ctrl/Cmd+Shift+F` shortcut. Clicking a hit
opens its session.

```
┌─ sidebar ─┐  ┌─ main ─────────────────────────────────────────────────────┐
│  Plugins  │  │  Search session content                                    │
│ ▸ Search  │  │  [ 会话                                            ]        │
│  Schedules│  │  All · My prompts · Replies · Tool output   ☐ subagents    │
│           │  │  43 hits · 8 sessions · 4 ms                               │
│           │  │ ────────────────────────────────────────────────────────── │
│           │  │ 2026-09-11 01:55   user   修改 FreeCAD MCP 服务端口         │
│           │  │   我在使用这个 mcp 服务[插件]，但是端口被占用了…            │
└───────────┘  └────────────────────────────────────────────────────────────┘
```

---

## Why this plugin exists

Stock DSH can already *search* sessions — the sidebar search box is wired to a real
content-search pipeline:

```
WorkspaceBrowser → sessions.search(query) → ctx.remote.session.search
  → SessionController.search → ctx.sessionQuery.searchSessions(…)
```

It only ever finds titles because **three independent things** are true at once:

| # | Fact | Where |
|---|---|---|
| 1 | The content backend is **switched off** in the stock profile — `openAt: never`. The shipped comment says it plainly: *"the Web sidebar search matches titles and workspace names only."* | the `session-query-sqlite` row in `dsh-base/cordis.patch.yml` |
| 2 | That backend tokenizes with FTS5 `unicode61`, which treats **an entire CJK run as a single token**. Measured on a real machine: `光速太慢，星际文明无法成为整体` yields exactly two tokens, `光速太慢` and `星际文明无法成为整体` — so `MATCH '光速'` and `MATCH '星际'` both **return nothing**. The `trigram` tokenizer is no help either: it rejects 2-character queries. | verified locally against SQLite 3.53.4 |
| 3 | Even with the backend enabled, the wire shape is `{ items: [{ sessionId, snippet }] }` — **each hit's `time` is dropped at that layer**, and ranking is relevance-first (`time` is only a tie-breaker). | `dsh-api-session-controller/lib/index.js` |

So "order results by content time" is **not achievable through any shipped public remote**, and
for CJK content the shipped engine is the wrong tool regardless. This plugin therefore builds its
own index on the host: it incrementally parses every session transcript, keeps each record's text
together with **that record's own `time`**, matches by substring (correct for both CJK and Latin
text), and sorts by time. It needs **no profile configuration changes**.

---

## Where the search entry lives — and why

DSH's Web/desktop UI has **no global top bar** and **no global command palette** (`/` commands are
the composer's slash menu and are bound to the current session). Only three global seats are
available:

| Seat | Verdict |
|---|---|
| **`sidebar.panellist` icon + its matching `main` panel** | ✅ **Used here.** This is DSH's first-class "global panel" mechanism: the sidebar owns the button, the label and the selected state, and the list `id` maps directly to the `main` panel `key`. The shipped **Plugins** (order 0) and **Schedules** (order 10) panels work exactly this way; this plugin slots in between at order 5. `replaceRisk: none` — it cannot be clobbered by an upgrade. |
| `sidebar.footer.action` (next to Settings) + a `shell.overlay` dialog | ⭕ Viable alternative, better suited to a "spotlight" quick-search. Costs you hand-built overlay, focus and Escape handling, and leaves little room for snippets. |
| `sidebar.workspaces` (where the existing search box lives) | ❌ **Not used.** It is a `single` seat occupied wholesale by `ui-workspace`, with `replaceRisk: shadows-shipped-ui` — taking it means replacing the entire shipped session browser and breaking on the next DSH release. |

A **`Ctrl/Cmd+Shift+F`** shortcut (registered through `dsh-client-shortcuts`) selects the panel from
anywhere. It is bound on the **desktop profiles only** on purpose: on the Web profiles the shipped
`session.fork` (`dsh-client-ui-workspace`) already owns `KeyF + primary+shift`, and the shortcut
registry validates a definition's defaults across every *declared* profile, throwing
`Conflicting shortcut defaults` from whichever plugin registers second. See
[Compatibility](#compatibility) for what that cost once.

For **searching inside the session you are reading**, the entry point is the `list` seat
`conversation.session.header.utilities` — the right-aligned action row of the conversation header.
It is additive (`replaceRisk: none`, ids `open-in-app` / `schedule-catalog` /
`session-log-download` already sit there), always in reach, and needs no new global chrome. The
find bar and the result dialog share one `shell.overlay` entry — the frame-wide layer documented as
"the additive seat for a frame-wide surface of your own" — so they float above every column without
stealing one.

---

## Install

This package is a standard DSH **bundle** (`dsh.bundle.patch` + `dsh.client` in its manifest).
Install it with the plugin manager:

```
plugin_manager action=install_bundle target="<absolute path to this repo>"
```

That writes the package into the profile's `dependencies` and `dsh.profile.bundles` and links it
into the profile's `node_modules`. You do **not** need to hand-edit the profile's `package.json` or
`cordis.patch.yml`.

Disable or remove it again:

```
plugin_manager action=set_bundle    target=dsh-session-search enabled=false
plugin_manager action=remove_bundle target=dsh-session-search
```

### Mounting it manually instead

Add a row to the profile's own `cordis.patch.yml` (the `name` may be a bare package specifier, a
path relative to the patch file, or an absolute path):

```yaml
- insert:
    - id: session-search
      name: 'dsh-session-search'
```

> **A note on reloading.** The Harness loads plugin rows through Node's ESM loader, which caches
> both the resolved package entry and the module itself for the lifetime of the Host process.
> Re-enabling a row that previously failed re-runs the *cached* module, so a fix on disk is not
> observed until the app restarts — `dsh-hmr` can activate a **new** row, but it cannot swap a
> JavaScript module generation for an already-loaded package. `lib/entry.js` exists to work around
> this during development: it re-imports `lib/host.js` behind an mtime-keyed query, so host-side
> edits take effect on the next activation. In normal use it is simply the entry point.

---

## Usage

### Global search

1. Click the magnifier icon in the sidebar (between *Plugins* and *Schedules*), or press
   `Ctrl/Cmd+Shift+F`.
2. Type a query. Matching is **substring**, case-insensitive, and works for CJK (a 2-character
   query matches inside a longer run, which the shipped FTS5 engine cannot do).
3. Narrow the results with the chips — *All* / *My prompts* / *Replies* / *Tool output* — and the
   *Include subagent sessions* toggle (off by default; subagent sessions routinely outnumber your
   own). The **session scope picker** at the top lists only the sessions that actually matched the
   current query, with hit counts (`title (12)`), so scoping to one of them is one click; with no
   query it lists recent sessions.
4. Click any hit to open it **with its context**: the matched record plus four records before and
   after, the match highlighted and untruncated. Use previous/next to move between hits, and
   *Open session* to jump to the session itself.

### Find in the conversation (Ctrl/Cmd+F)

Press `Ctrl/Cmd+F`, or click the magnifier in the conversation header's right-aligned utilities.
A small floating bar appears, searches the transcript, paints **every match** and scrolls the
active one into view:

- `Enter` / `Shift+Enter`, or `‹ ›`, cycle matches; `Esc` closes and clears the highlights.
- The match counter shows the position (`3 / 17`).
- **Search all history** hands the current query to the indexed dialog, which also searches
  records the chat has not rendered yet.

How it works: matches are collected from the transcript's rendered text nodes, and each one is
painted as a rectangle on the plugin's **own overlay layer**, positioned from
`Range.getClientRects()`. The transcript's DOM is never mutated and React never sees an unexpected
change; the layer repaints on transcript scroll, window resize and virtualizer updates. (An earlier
version used the CSS Custom Highlight API, which failed silently on some builds — the overlay has no
such dependency.) This is the same boundary Chromium's own find-in-page works under — the chat
virtualizer only renders a window of turns, so content outside that window is found through
**Search all history** instead.

> **Why this is DOM-based.** DSH has no public API to navigate the transcript
> (`ChatNavigation.navigateToTurn`, `scrollToTurn` and `loadThrough` are private to the chat panel;
> slot occupants only receive read-only snapshot selectors such as `useChat`). Reading rendered text
> is the only remaining route, and it is done without writing to another plugin's DOM. If a future
> release renames the transcript container, the bar degrades to "no matches" instead of breaking.

Queries in the indexed surfaces are debounced by 220 ms and each superseded query is aborted.

> **On "locating" a hit.** The find bar (`Ctrl/Cmd+F`) locates matches in the *rendered* transcript
> by scrolling them into view — see the section above. The indexed dialog takes the complementary
> job: it locates a hit in **stored history**, including turns the chat has not rendered, by showing
> the record in its surrounding context. Neither can ask the chat to jump to an arbitrary event
> sequence: `ChatNavigation.navigateToTurn` / `input.loadThrough(seq)` are private to the chat panel.

---

## Configuration

The plugin exports **no `Config` schema** on purpose: bare specifiers such as
`@deepseek-ai/schemastery` do not resolve from a plugin that lives outside the profile tree, and
Cordis passes a row's `config:` through untouched when a plugin has no `Config`
(`if (!runtime.Config) return config` in `cordis/lib/index.js`). So every key is optional:

```yaml
- id: session-search
  name: 'dsh-session-search'
  config:
    root: 'C:/Users/me/.dsh/sessions'   # sessions root; defaults to <DSH_HOME>/sessions
    maxHits: 300                        # cap on returned hits
    maxCharsPerRecord: 65536            # per-record text ceiling, guards against one huge tool result
    includeSubagents: false             # exclude subagent sessions by default
    warmup: true                        # build the index in the background after startup
    warmupDelayMs: 3000
```

A patch row **replaces** the whole `config` of its target id, so write every value you want.

---

## How it works

```
package.json                bundle manifest: dsh.bundle.patch + dsh.client
cordis.patch.yml            bundle patch: the insert row
icon.svg                    icon for the Plugins page
locale/{en,zh}.json         title/description for the Plugins page
lib/entry.js                loader entry: exports name/inject, loads the implementation
lib/host.js                 host half: index lifecycle, HTTP channel, sessionContentSearch service
lib/core/session-index.js   pure Node index and query engine (no DSH dependency)
lib/client.js               browser half: panel icon + search page + shortcut
test/host.test.mjs          host integration tests
test/client.test.mjs        browser-half tests
```

### Transcript format

Each `session.v<N>.jsonl.zstd` is **a sequence of independent Zstandard frames**, not one stream.
Node's `createZstdDecompress` / `zstdDecompressSync` decode **only the first frame**, so the naive
reader silently gets just the header line. This plugin scans for the zstd magic number and decodes
frame by frame, and records a resume offset for incremental passes: when a file grows it decodes
only the new frames, and when it shrinks (compaction rewrites it) it starts over.

Every frame decompresses to JSONL lines:

```json
{"type":"session","version":4,"id":"…","createdAt":1792130873584,"cwd":"D:\\Code\\demo","origin":"subagent"}
{"type":"user/message","seq":9,"time":1792130873619,"data":{"content":[{"type":"text","text":"…"}]}}
{"type":"assistant/message","seq":16,"time":1792130875479,"data":{"message":{"content":[{"type":"text","text":"…"},{"type":"tool-call","name":"read","arguments":"…"}]}}}
{"type":"tool/result","seq":17,"time":…,"data":{"message":{"content":[{"type":"tool-result","content":[{"type":"text","text":"…"}]}]}}}
{"type":"session/title","seq":14,"time":…,"data":{"title":"…"}}
```

Only `user/message`, `assistant/message`, `tool/call`, `tool/result` and `session/title` are
indexed. `system/message` (system prompts) and `reasoning-chunks` (chain of thought) are excluded by
design — otherwise they match nearly everything.

Measured on a real home directory: **178 sessions / 22k records / 21.4 MB of searchable text**, a
cold index build of **~1.2 s**, then **3–26 ms** per query (9 ms for an incremental refresh).

### Host ↔ browser transport

The browser half calls `ctx.connection.rpc.call('/session-search', 'search', {…}, signal)`.
The host registers a prefix route on that path, speaks the standard Connection RPC envelope
(`{type:'client-request', rpcId, method, payload}` → `{type:'server-response', rpcId, result:{ok,value}}`),
and reuses the Connection service's `admit()` admission fence, so unauthenticated callers get a 401.

> ⚠️ **Upstream defect — reproduced on 0.2.0-rc.2, still present in 0.2.1-rc.2.**
> `ctx.connection.rpc.handle()` (and `rpc.intercept()`) look like the intended API for this, but a
> plugin cannot use them. In `dsh-client-connection/lib/index.js`, `get rpc()` reads
> `owner = this.ctx` (`:724`) and hands it to `register(owner, …)` (`:855`), whose last line is
> `owner.effect(() => owner.webServer.register(route), …)` (`:871`). That context injects only
> `credentials` (`:1013`), so `owner.webServer` is not an injected service on it and **every**
> registration throws `cannot get property "webServer" without inject` — even when the calling
> plugin itself has `webServer` in its own `inject`. No shipped plugin calls `rpc.handle`, which is
> why the defect is invisible from the outside. `rpc.call()` on the *browser* side is fine; only
> host-side channel registration is broken. `connection.fetch.register()` is not affected
> (`registerFetchRoute` never touches `owner.webServer`) but it only feeds the Connection service's
> own `/api` dispatch rather than creating a route, so it is not a substitute.
>
> Reproduction: from any host plugin, call `ctx.connection.rpc.handle('/probe', async () => 1)` in
> `apply` with `webServer` in `inject` — it throws immediately. The workaround used here registers
> the prefix route on the plugin's own context (which does inject `webServer`) and reuses
> `ctx.connection.admit(request)` for the identical trust/auth fence.

The host also does `ctx.provide('sessionContentSearch', …)`, exposing the same index so other plugins
(or a human debugging a profile) can reuse it.

---

## Compatibility

Built and verified against **DeepSeek Harness 0.2.1-rc.2** (Electron 44.7.0, `@deepseek-ai/cordis`
4.0.5). It has no runtime dependency on any Harness package, so only the documented service and slot
contracts matter.

**0.2.1-rc.2 incident — fixed in 0.1.1.** Version 0.1.0 also registered `Ctrl/Cmd+Shift+F` on the
Web profiles. 0.2.1-rc.2 ships `session.fork` in `dsh-client-ui-workspace` bound to
`KeyF + primary+shift` on Web, and `dsh-client-shortcuts` validates a definition's defaults across
every declared profile, throwing `Conflicting shortcut defaults` from whichever plugin registers
second. That was `ui-workspace`: its failure left 16 client entries waiting for the `uiWorkspace`
service and turned the renderer boot into a fatal `web boot: 17 entries did not activate`. DSH's
crash recovery then sanitized the profile back to its default bundle list.

0.1.1 binds **desktop profiles only** and guards the registration, so a future release re-binding the
combination costs this panel its shortcut — never the application's boot. If you installed 0.1.0,
update and re-install the bundle.

---

## Verification status

- `npm test` → **27/27 passing**.
  - Host (16): CJK substring hits against the real corpus, time-descending order, subagent
    filtering, session-scoped queries, per-session match facets, the scope-picker listing, the
    context window around a hit, a full *HTTP route → RPC envelope → query → payload* round trip,
    plus 405 / 404 / 400 / mismatched-envelope failure paths.
  - Browser half (11): the bundle is loaded **the way the page loads it** (`window.__ModuleLoader__` +
    factory + a stubbed `require`), asserting that the module id equals the package name, that it
    requires **nothing but `react`**, that all four surfaces register (panel icon, main page, session
    header button, dialog layer), that the shortcut is declared on desktop profiles only, that a
    *rejected* shortcut registration cannot break activation, and rendering the header button, the
    closed dialog, the result/highlight state, the scope picker (including its matched-sessions-only
    behaviour) and the open-hit dialog.
- Install result: `application: "applied"`, `warnings: []`.
- Host: `POST /session-search/search` returns **401** (the route exists and is behind the
  admission fence), while an unknown channel returns 405.
- Client: live slot inspection shows `session-search` registered **and active** in both
  `sidebar.panellist` (order 5) and `main` (same key).
- **Clean restart confirmed:** with the bundle mounted, a full DSH 0.2.1-rc.2 application restart
  completes with no `crash-*.log` entry, the panel icon registered and the host route live.

**Not verified:** the author had no browser control in the environment where this was built, so
there was **no visual verification** — clicking the icon, typing a query and seeing rendered results
was not performed. Per `cordis-plugin-development/references/verification.md`, claims stop at
"syntax + manifest + live slot registration + components render". Please confirm the look yourself.

---

## Known limitations

- **The find bar only reaches rendered content.** The chat virtualizer keeps a window of turns in
  the DOM, so `Ctrl/Cmd+F` (like a browser's find-in-page) sees only what is rendered; *Search all
  history* in the bar, or the indexed dialog, covers the rest. Deep links to an event sequence are
  still impossible: `ChatNavigation.navigateToTurn` / `input.loadThrough(seq)` are private to the
  chat panel.
- The keyboard shortcut is **desktop-only**; Web profiles stay unbound so the plugin cannot collide
  with a shipped Web binding (see [Compatibility](#compatibility)). The sidebar icon always works.
- The index lives in memory for the lifetime of the Host process; it is not persisted to disk (a
  cold build is ~1.2 s, normally invisible).
- Matching is **substring**, not tokenized and not semantic. Multiple whitespace-separated terms are
  ANDed.
- Text beyond `maxCharsPerRecord` (default 64 KiB) in a single record is truncated.
- The official SQLite FTS backend stays disabled. This plugin deliberately does **not** enable it:
  even enabled, it cannot match CJK substrings (see fact #2 above). If you would rather have the
  official backend with relevance ranking, that is a separate configuration change and not something
  a plugin can do.

---

## Development

Plain ESM, no build step — `lib/*.js` is the shipped artefact. Node ≥ 22.15 (needs `node:zlib`
Zstandard support).

```bash
npm test          # node --test test/host.test.mjs test/client.test.mjs
```

The host tests run against the real sessions in `<DSH_HOME>/sessions`; they skip cleanly when that
directory does not exist.

## License

[MIT](LICENSE) © Victue
