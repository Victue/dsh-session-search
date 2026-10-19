/**
 * Session content search — browser half.
 *
 * Three surfaces, one index:
 *  - a global search page (`sidebar.panellist` icon + matching `main` panel) with an
 *    optional per-session scope, reachable from Ctrl/Cmd+Shift+F;
 *  - a per-session search button in the conversation header
 *    (`conversation.session.header.utilities`), scoped to that session;
 *  - a frame-wide dialog (`shell.overlay`) that shows a hit with the records around it.
 *
 * DSH exposes no public "scroll to seq" API, so locating a hit means showing the matched
 * record in context inside this plugin's own dialog rather than scrolling the transcript.
 *
 * This file is a client MODULE BUNDLE, not an ES module: the module system loads it as
 * a script and expects it to register itself through `window.__ModuleLoader__.load`.
 * Only the platform seed table is require-able, which is why this plugin requires
 * nothing but `react`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-search',
  factory(require) {
    const React = require('react')
    const createElement = React.createElement

    /** Locale namespace and the panel id shared by the icon and the page. */
    const NS = 'sessionContentSearch'
    const PANEL_ID = 'session-search'
    const CHANNEL = '/session-search'
    const SEARCH_LIMIT = 300

    const DICT = {
      zh: {
        panel: '搜索会话内容',
        title: '搜索会话内容',
        placeholder: '搜索所有会话的内容…（支持中文子串）',
        empty: '输入关键词，搜索全部会话的具体内容',
        noMatch: '没有找到匹配的内容',
        searching: '搜索中…',
        indexing: '正在建立索引…',
        kindsAll: '全部',
        kindsUser: '我的提问',
        kindsAssistant: '助手回复',
        kindsTool: '工具输出',
        includeSubagents: '包含子代理会话',
        sort: '按内容时间',
        open: '打开会话',
        summary: '{total} 条命中 · {sessions} 个会话 · {ms} ms',
        unavailable: '无法连接主机搜索服务，请重启 DSH 后重试。',
        failed: '搜索失败：{message}',
        docs: '已索引 {sessions} 个会话 / {records} 条记录',
        scopeLabel: '会话范围',
        scopeAll: '全部会话',
        scopeHint: '仅在这些会话中搜索',
        sessionButton: '搜索本会话内容',
        sessionTitle: '搜索本会话内容',
        sessionPlaceholder: '搜索本会话的内容…',
        close: '关闭',
        back: '返回结果',
        prevHit: '上一处命中',
        nextHit: '下一处命中',
        ordinal: '第 {index} 条 / 共 {total} 条',
        hitOrdinal: '第 {index} 处 / 共 {count} 处命中',
        contextTitle: '命中位置',
        loadingContext: '正在读取上下文…',
        noContext: '无法读取该命中所在的上下文',
        openSession: '在会话中打开',
        sessionScope: '已限定：{name}',
        clearScope: '清除范围',
        findPlaceholder: '在会话中查找…',
        findCount: '{index} / {count}',
        findNone: '无匹配',
        findPrev: '上一处',
        findNext: '下一处',
        findClose: '关闭',
        findAllHistory: '在全部历史中搜索',
        findNoTranscript: '当前没有可查找的会话内容',
      },
      en: {
        panel: 'Search session content',
        title: 'Search session content',
        placeholder: 'Search the content of every session…',
        empty: 'Type a keyword to search the content of every session',
        noMatch: 'No matching content',
        searching: 'Searching…',
        indexing: 'Building index…',
        kindsAll: 'All',
        kindsUser: 'My prompts',
        kindsAssistant: 'Replies',
        kindsTool: 'Tool output',
        includeSubagents: 'Include subagent sessions',
        sort: 'By content time',
        open: 'Open session',
        summary: '{total} hits · {sessions} sessions · {ms} ms',
        unavailable: 'The host search service is unavailable. Restart DSH and try again.',
        failed: 'Search failed: {message}',
        docs: '{sessions} sessions / {records} records indexed',
        scopeLabel: 'Session scope',
        scopeAll: 'All sessions',
        scopeHint: 'Search only within these sessions',
        sessionButton: 'Search this session',
        sessionTitle: 'Search this session',
        sessionPlaceholder: 'Search this session’s content…',
        close: 'Close',
        back: 'Back to results',
        prevHit: 'Previous hit',
        nextHit: 'Next hit',
        ordinal: '{index} of {total}',
        hitOrdinal: 'hit {index} of {count}',
        contextTitle: 'Hit in context',
        loadingContext: 'Reading context…',
        noContext: 'Could not read the context around this hit',
        openSession: 'Open session',
        sessionScope: 'Scoped: {name}',
        clearScope: 'Clear scope',
        findPlaceholder: 'Find in this session…',
        findCount: '{index} / {count}',
        findNone: 'No matches',
        findPrev: 'Previous match',
        findNext: 'Next match',
        findClose: 'Close',
        findAllHistory: 'Search all history',
        findNoTranscript: 'There is no conversation content to search right now',
      },
    }

    const KIND_LABEL = { user: 'kindsUser', assistant: 'kindsAssistant', tool: 'kindsTool', title: 'kindsAll' }

    const inject = ['slots', 'locale', 'connection']

    /**
     * Static styling lives in one tagged <style> so hover and layout stay out of inline
     * props. The tag carries `data-plugin` so the module system attributes it to us.
     * Only `--dsw-alias-*` theme tokens are referenced.
     */
    const CSS = `
.dsss-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;flex:none}
.dsss-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,#111)}
.dsss-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4b7bec);outline-offset:1px}
.dsss-page{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit)}
.dsss-head{padding:16px 20px 12px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.dsss-headrow{display:flex;align-items:center;gap:12px}
.dsss-title{font-size:15px;font-weight:600;flex:1}
.dsss-input{width:100%;box-sizing:border-box;padding:9px 12px;font-size:14px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;outline:none;font-family:inherit}
.dsss-input:focus{border-color:var(--dsw-alias-state-business-primary,#4b7bec)}
.dsss-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsss-chip{padding:3px 10px;font-size:12px;line-height:18px;cursor:pointer;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,rgba(128,128,128,1));user-select:none}
.dsss-chip[data-active=1]{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.5));background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary,inherit)}
.dsss-check{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,1));cursor:pointer}
.dsss-select{max-width:280px;box-sizing:border-box;padding:4px 8px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:6px;outline:none}
.dsss-status{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,1))}
.dsss-list{flex:1;min-height:0;overflow-y:auto;padding:6px 0 24px}
.dsss-row{padding:10px 20px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))}
.dsss-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.dsss-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4b7bec);outline-offset:-2px}
.dsss-meta{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,1));margin-bottom:4px}
.dsss-kind{flex:none}
.dsss-where{color:var(--dsw-alias-label-secondary,rgba(128,128,128,1));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dsss-snippet{font-size:14px;line-height:21px;white-space:pre-wrap;word-break:break-word;max-height:63px;overflow:hidden}
.dsss-mark{background:rgba(255,196,0,.5);color:inherit;border-radius:3px;padding:0 1px;font-weight:600;box-shadow:0 0 0 1px rgba(255,196,0,.55)}
.dsss-centre{flex:1;display:flex;align-items:center;justify-content:center;padding:32px;text-align:center;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,1));font-size:13px}
.dsss-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.32);pointer-events:auto}
.dsss-modal{width:min(820px,100%);height:min(74vh,660px);display:flex;flex-direction:column;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-3,#1f1f1f);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.32)}
.dsss-modalhead{padding:14px 18px 10px;display:flex;flex-direction:column;gap:9px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.dsss-modaltitle{font-size:14px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsss-detail{flex:1;min-height:0;display:flex;flex-direction:column}
.dsss-detailbar{display:flex;align-items:center;gap:8px;padding:9px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,1));flex-wrap:wrap}
.dsss-btn{padding:4px 10px;font-size:12px;font-family:inherit;cursor:pointer;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));color:var(--dsw-alias-label-primary,inherit)}
.dsss-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2))}
.dsss-btn:disabled{opacity:.45;cursor:default}
.dsss-records{flex:1;min-height:0;overflow-y:auto;padding:8px 0 20px}
.dsss-record{padding:8px 18px;border-left:3px solid transparent}
.dsss-record[data-match=1]{border-left-color:var(--dsw-alias-state-business-primary,#4b7bec);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.dsss-recordmeta{display:flex;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,1));margin-bottom:3px}
.dsss-recordtext{font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:hidden;color:var(--dsw-alias-label-secondary,rgba(160,160,160,1))}
.dsss-record[data-match=1] .dsss-recordtext{max-height:none;color:var(--dsw-alias-label-primary,inherit)}
/* Browser-style find bar: a small floating box, not a modal, so the transcript stays
   readable and scrollable while searching. */
.dsss-findbar{position:fixed;top:12px;right:24px;z-index:70;display:flex;align-items:center;gap:6px;padding:7px 9px;border-radius:10px;pointer-events:auto;background:var(--dsw-alias-bg-layer-3,#1f1f1f);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));box-shadow:0 10px 30px rgba(0,0,0,.3)}
.dsss-findbar .dsss-input{width:220px;padding:5px 8px;font-size:13px}
.dsss-findcount{font-size:12px;min-width:56px;text-align:center;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,1))}
.dsss-findbtn{padding:4px 8px;font-size:12px;font-family:inherit;cursor:pointer;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32));background:transparent;color:var(--dsw-alias-label-secondary,rgba(160,160,160,1))}
.dsss-findbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2));color:var(--dsw-alias-label-primary,inherit)}
.dsss-findbtn:disabled{opacity:.4;cursor:default}
::highlight(dsh-session-search-all){background-color:rgba(255,196,0,.45);color:inherit}
::highlight(dsh-session-search-active){background-color:rgba(255,140,0,.9);color:#111}
`

    /** Toolbar/chip shared helpers built from class names, so hover stays in CSS. */
    function chip(key, label, active, onClick) {
      return createElement('button', {
        key,
        type: 'button',
        className: 'dsss-chip',
        'data-active': active ? 1 : 0,
        onClick,
      }, label)
    }

    /** Resolve the translation seat, falling back to the shipped dictionaries. */
    function resolveT(ctx, props) {
      if (props && typeof props.t === 'function') return props.t
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') return ctx.locale.bind(NS)
      } catch {
        /* fall through to the built-in dictionary */
      }
      return (key, params) => {
        const template = DICT.zh[key]
        if (typeof template !== 'string') return String(template ?? key)
        if (!params) return template
        return Object.entries(params).reduce(
          (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template,
        )
      }
    }

    /** Search icon, drawn locally: a Client plugin must not import Harness UI packages. */
    function searchIcon(size) {
      const edge = size ?? 16
      return createElement(
        'svg',
        {
          width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none',
          'aria-hidden': true, style: { display: 'block' },
        },
        createElement('circle', { cx: 7, cy: 7, r: 4.5, stroke: 'currentColor', strokeWidth: 1.4 }),
        createElement('path', { d: 'M10.5 10.5 14 14', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      )
    }

    const pad2 = (value) => String(value).padStart(2, '0')

    /** `2026-10-16 14:06` in the browser's own zone. */
    function formatTime(epochMs) {
      if (typeof epochMs !== 'number') return '--'
      const date = new Date(epochMs)
      if (Number.isNaN(date.getTime())) return '--'
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
        `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    /** Render a snippet with every matched range wrapped in a highlight element. */
    function renderSnippet(hit) {
      const text = hit.snippet ?? ''
      const marks = Array.isArray(hit.snippetMarks) ? hit.snippetMarks : []
      if (marks.length === 0) return text
      const children = []
      let cursor = 0
      marks.forEach(([from, to], index) => {
        const start = Math.max(cursor, Math.min(from, text.length))
        const end = Math.max(start, Math.min(to, text.length))
        if (start > cursor) children.push(text.slice(cursor, start))
        if (end > start) children.push(createElement('mark', { key: `m${index}`, className: 'dsss-mark' }, text.slice(start, end)))
        cursor = end
      })
      if (cursor < text.length) children.push(text.slice(cursor))
      return children
    }

    /** Highlight every occurrence of the query terms inside one context record. */
    function renderHighlighted(text, terms) {
      if (!terms || terms.length === 0) return text
      const lowered = text.toLowerCase()
      const ranges = []
      for (const term of terms) {
        let from = 0
        for (;;) {
          const at = lowered.indexOf(term, from)
          if (at === -1) break
          ranges.push([at, at + term.length])
          from = at + Math.max(1, term.length)
        }
      }
      if (ranges.length === 0) return text
      ranges.sort((a, b) => a[0] - b[0])
      const children = []
      let cursor = 0
      ranges.forEach(([start, end], index) => {
        if (start < cursor) return
        if (start > cursor) children.push(text.slice(cursor, start))
        children.push(createElement('mark', { key: `h${index}`, className: 'dsss-mark' }, text.slice(start, end)))
        cursor = end
      })
      if (cursor < text.length) children.push(text.slice(cursor))
      return children
    }

    /** True when the query has been typed but every character is whitespace. */
    const isBlank = (value) => String(value ?? '').trim().length === 0

    /**
     * `ctx.connection.rpc.call` resolves the Connection envelope (`{ ok, value }`).
     * Unwrap it, and tolerate a bare value in case the transport is changed.
     */
    function unwrapReply(reply) {
      if (reply && typeof reply === 'object' && typeof reply.ok === 'boolean') {
        if (reply.ok) return reply.value
        throw new Error(reply.error?.message ?? 'request failed')
      }
      return reply
    }

    /** One authenticated host call on this plugin's own channel. */
    async function callHost(ctx, endpoint, payload, signal) {
      const connection = ctx.get('connection')
      if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
        const error = new Error('no connection')
        error.code = 'no-connection'
        throw error
      }
      return unwrapReply(await connection.rpc.call(CHANNEL, endpoint, payload, signal))
    }

    /** Minimal external store: shared state between two slot entries. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => {
          if (next === value) return
          value = next
          for (const listener of listeners) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    function useStore(store) {
      const [version, bump] = React.useState(0)
      React.useEffect(() => store.subscribe(() => bump((value) => value + 1)), [store])
      void version
      return store.get()
    }

    /**
     * Which session the in-session search dialog is open for, plus the hit and query it
     * was opened with. `terms` must travel with the hit: the context view highlights the
     * match with them, and a hit opened from the global page has no local search result
     * to read them from.
     */
    const dialogStore = createStore({
      open: false,
      sessionId: null,
      initialHit: null,
      query: '',
      terms: [],
    })

    /** Browser-style find bar state. `query` survives closing so reopening resumes. */
    const findStore = createStore({ open: false, sessionId: null, query: '' })

    const FIND_HIGHLIGHT_ALL = 'dsh-session-search-all'
    const FIND_HIGHLIGHT_ACTIVE = 'dsh-session-search-active'
    const FIND_MAX_RANGES = 3000

    /** The element the chat view scrolls, marked by `dsh-client-ui-conversation`. */
    function transcriptRoot() {
      if (typeof document === 'undefined') return null
      return document.querySelector('[data-conversation-scroll]')
    }

    /**
     * Collect text ranges matching `query` inside the rendered transcript.
     *
     * DSH exposes no navigation API and its chat virtualizer decides what is in the DOM,
     * so this searches whatever the transcript currently renders — exactly the boundary a
     * browser's find-in-page works under. Nothing is mutated: the ranges go to the CSS
     * Custom Highlight API, so React's tree is never touched.
     */
    function collectTranscriptRanges(query, root) {
      const needle = String(query ?? '').trim().toLowerCase()
      if (!needle || !root || typeof document === 'undefined' || typeof NodeFilter === 'undefined') {
        return []
      }
      const ranges = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      let node = walker.nextNode()
      while (node !== null && ranges.length < FIND_MAX_RANGES) {
        const value = node.nodeValue
        if (value !== null && value.length >= needle.length) {
          const parent = node.parentElement
          const skip = parent === null
            || parent.closest('[data-dsh-find]') !== null
            || parent.closest('[hidden]') !== null
          if (!skip) {
            const haystack = value.toLowerCase()
            let from = 0
            for (;;) {
              const at = haystack.indexOf(needle, from)
              if (at === -1) break
              const range = document.createRange()
              range.setStart(node, at)
              range.setEnd(node, at + needle.length)
              ranges.push(range)
              if (ranges.length >= FIND_MAX_RANGES) break
              from = at + Math.max(1, needle.length)
            }
          }
        }
        node = walker.nextNode()
      }
      return ranges
    }

    /** Whether this browser supports CSS Custom Highlight (Chromium 105+). */
    function highlightsSupported() {
      return typeof CSS !== 'undefined' && CSS !== null && CSS.highlights !== undefined
        && typeof Highlight !== 'undefined'
    }

    function paintHighlights(ranges, activeIndex) {
      if (!highlightsSupported()) return
      CSS.highlights.set(FIND_HIGHLIGHT_ALL, new Highlight(...ranges))
      const active = ranges[activeIndex]
      if (active === undefined) CSS.highlights.delete(FIND_HIGHLIGHT_ACTIVE)
      else CSS.highlights.set(FIND_HIGHLIGHT_ACTIVE, new Highlight(active))
    }

    function clearHighlights() {
      if (!highlightsSupported()) return
      CSS.highlights.delete(FIND_HIGHLIGHT_ALL)
      CSS.highlights.delete(FIND_HIGHLIGHT_ACTIVE)
    }

    /** Bring one match into the middle of the transcript viewport. */
    function revealRange(range) {
      const element = range && range.startContainer ? range.startContainer.parentElement : null
      if (!element) return
      try {
        element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      } catch {
        element.scrollIntoView()
      }
    }

    /** Best-effort active session id, used only to forward the query to the history dialog. */
    function currentSessionId(ctx) {
      try {
        const uiSession = ctx.get('uiSession')
        const source = uiSession && uiSession.current
        const snapshot = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined
        const candidate = snapshot && (snapshot.session?.id ?? snapshot.id ?? snapshot.binding?.sessionId)
        return typeof candidate === 'string' ? candidate : undefined
      } catch {
        return undefined
      }
    }

    /** One search run against the host channel. */
    function useSearch(ctx, options) {
      const [state, setState] = React.useState({ status: 'idle', result: null, error: null })
      const abortRef = React.useRef(null)
      const scopeKey = options.scopeKey ?? ''
      const run = React.useCallback((query) => {
        if (abortRef.current) abortRef.current.abort()
        if (isBlank(query)) {
          setState({ status: 'idle', result: null, error: null })
          return
        }
        const controller = new AbortController()
        abortRef.current = controller
        setState((previous) => ({
          status: previous.result ? 'refreshing' : 'searching',
          result: previous.result,
          error: null,
        }))
        callHost(ctx, 'search', {
          query,
          limit: options.limit,
          kinds: options.kinds,
          sessionIds: options.sessionIds,
          includeSubagents: options.includeSubagents,
        }, controller.signal)
          .then((result) => {
            if (controller.signal.aborted) return
            setState({ status: 'done', result, error: null })
          })
          .catch((error) => {
            if (controller.signal.aborted || error?.name === 'AbortError') return
            setState({ status: 'error', result: null, error })
          })
      }, [ctx, options.limit, options.kindsKey, options.includeSubagents, scopeKey])
      React.useEffect(() => () => { if (abortRef.current) abortRef.current.abort() }, [])
      return [state, run]
    }

    /** Message status line shared by both search surfaces. */
    function statusLine(t, state) {
      const result = state.result
      const busy = state.status === 'searching' || state.status === 'refreshing'
      if (busy) return state.status === 'searching' && !result ? t('indexing') : t('searching')
      if (result) return t('summary', { total: result.total, sessions: result.sessions, ms: result.tookMs ?? 0 })
      if (state.status === 'error') {
        return state.error?.code === 'no-connection' || state.error?.message === 'no connection'
          ? t('unavailable')
          : t('failed', { message: String(state.error?.message ?? '') })
      }
      return null
    }

    /** Kind chips. */
    function KindChips({ t, value, onChange, extra }) {
      return createElement(
        'div',
        { className: 'dsss-toolbar' },
        ...[['all', 'kindsAll'], ['user', 'kindsUser'], ['assistant', 'kindsAssistant'], ['tool', 'kindsTool']]
          .map(([key, labelKey]) => chip(key, t(labelKey), value === key, () => onChange(key))),
        createElement('span', { style: { flex: 1 } }),
        extra ?? null,
      )
    }

    /** Result rows shared by the global page and the in-session dialog. */
    function ResultRows({ hits, t, showWhere, onPick }) {
      return createElement(
        'div',
        { className: 'dsss-list' },
        ...hits.map((hit, index) => createElement(
          'div',
          {
            key: `${hit.sessionId}:${hit.seq}:${index}`,
            className: 'dsss-row',
            role: 'button',
            tabIndex: 0,
            title: t('contextTitle'),
            onClick: () => onPick(hit),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onPick(hit)
            },
          },
          createElement(
            'div',
            { className: 'dsss-meta' },
            createElement('span', null, formatTime(hit.time)),
            createElement('span', { className: 'dsss-kind' }, t(KIND_LABEL[hit.kind] ?? 'kindsAll')),
            showWhere
              ? createElement('span', { className: 'dsss-where' }, hit.sessionTitle || hit.cwd || hit.sessionId)
              : null,
          ),
          createElement('div', { className: 'dsss-snippet' }, renderSnippet(hit)),
        )),
      )
    }

    /**
     * One hit expanded with the records around it. The matched record is highlighted and
     * never truncated; neighbours are clamped. This is the "locate the message" surface:
     * DSH has no public scroll-to-seq API, so the match is shown here in its own context.
     */
    function HitDetail({ ctx, t, hit, terms, ordinal, onPrev, onNext, onOpenSession, onBack }) {
      const [state, setState] = React.useState({ status: 'loading', context: null, error: null })
      React.useEffect(() => {
        let cancelled = false
        setState({ status: 'loading', context: null, error: null })
        callHost(ctx, 'context', { sessionId: hit.sessionId, seq: hit.seq, before: 4, after: 4 })
          .then((reply) => {
            if (cancelled) return
            const context = reply?.context ?? null
            setState(context
              ? { status: 'done', context, error: null }
              : { status: 'error', context: null, error: new Error('missing context') })
          })
          .catch((error) => {
            if (cancelled) return
            setState({ status: 'error', context: null, error })
          })
        return () => { cancelled = true }
      }, [ctx, hit.sessionId, hit.seq])

      const context = state.context
      const records = context?.records ?? []

      return createElement(
        'div',
        { className: 'dsss-detail' },
        createElement(
          'div',
          { className: 'dsss-detailbar' },
          createElement('button', { type: 'button', className: 'dsss-btn', onClick: onPrev, disabled: !ordinal?.hasPrev }, `‹ ${t('prevHit')}`),
          createElement('button', { type: 'button', className: 'dsss-btn', onClick: onNext, disabled: !ordinal?.hasNext }, `${t('nextHit')} ›`),
          createElement('span', null, formatTime(hit.time)),
          createElement('span', null, t(KIND_LABEL[hit.kind] ?? 'kindsAll')),
          ordinal ? createElement('span', null, t('hitOrdinal', { index: ordinal.index, count: ordinal.count })) : null,
          createElement('span', { style: { flex: 1 } }),
          onOpenSession ? createElement('button', { type: 'button', className: 'dsss-btn', onClick: () => onOpenSession(hit.sessionId) }, t('openSession')) : null,
          onBack ? createElement('button', { type: 'button', className: 'dsss-btn', onClick: onBack }, t('back')) : null,
        ),
        createElement(
          'div',
          { className: 'dsss-records' },
          state.status === 'loading' ? createElement('div', { className: 'dsss-centre' }, t('loadingContext')) : null,
          state.status === 'error' ? createElement('div', { className: 'dsss-centre' }, t('noContext')) : null,
          ...records.map((record) => createElement(
            'div',
            {
              key: record.seq,
              className: 'dsss-record',
              'data-match': record.isMatch ? 1 : 0,
            },
            createElement(
              'div',
              { className: 'dsss-recordmeta' },
              createElement('span', null, formatTime(record.time)),
              createElement('span', null, t(KIND_LABEL[record.kind] ?? 'kindsAll')),
              record.isMatch && context
                ? createElement('span', null, t('ordinal', { index: context.index + 1, total: context.total }))
                : null,
            ),
            createElement(
              'div',
              { className: 'dsss-recordtext' },
              record.isMatch ? renderHighlighted(record.text, terms) : record.text,
            ),
          )),
        ),
      )
    }

    /** The dialog shell shared by both surfaces. */
    function Dialog({ t, title, onClose, children }) {
      return createElement(
        'div',
        {
          className: 'dsss-backdrop',
          role: 'presentation',
          onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
        },
        createElement(
          'div',
          { className: 'dsss-modal', role: 'dialog', 'aria-modal': true, 'aria-label': title },
          createElement(
            'div',
            { className: 'dsss-modalhead' },
            createElement(
              'div',
              { className: 'dsss-headrow' },
              createElement('span', { className: 'dsss-modaltitle' }, title),
              createElement('button', { type: 'button', className: 'dsss-iconbtn', title: t('close'), 'aria-label': t('close'), onClick: onClose },
                createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                  createElement('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))),
            ),
            children.header ?? null,
          ),
          children.body ?? null,
        ),
      )
    }

    /**
     * Browser-style find bar for the conversation transcript.
     *
     * Matches are taken from the text the chat has rendered, painted with the CSS Custom
     * Highlight API (no DOM mutation at all), and the active match is scrolled into the
     * middle of the viewport. This is the same boundary Chromium's own find-in-page works
     * under: virtualized, not-yet-loaded history is not searchable until it renders.
     */
    function FindBar(props) {
      const ctx = props.ctx
      const t = resolveT(ctx, props)
      const state = useStore(findStore)
      const [query, setQuery] = React.useState(state.query ?? '')
      const [status, setStatus] = React.useState({ count: 0, index: 0 })
      const rangesRef = React.useRef([])
      const indexRef = React.useRef(0)
      const rootRef = React.useRef(null)

      const paint = React.useCallback((ranges, index, jump) => {
        rangesRef.current = ranges
        const clamped = ranges.length === 0 ? 0 : Math.min(Math.max(0, index), ranges.length - 1)
        indexRef.current = clamped
        paintHighlights(ranges, clamped)
        setStatus({ count: ranges.length, index: clamped })
        if (jump && ranges[clamped] !== undefined) revealRange(ranges[clamped])
      }, [])

      const recollect = React.useCallback((jump) => {
        const root = rootRef.current ?? transcriptRoot()
        rootRef.current = root
        paint(collectTranscriptRanges(query, root), 0, jump)
      }, [query, paint])

      // Re-run on query change and move to the first match.
      React.useEffect(() => {
        if (!state.open) return undefined
        const timer = setTimeout(() => recollect(true), 160)
        return () => clearTimeout(timer)
      }, [query, state.open, recollect])

      // The chat virtualizer swaps nodes as the transcript scrolls; re-collect quietly so
      // newly rendered content gains highlights without stealing the reading position.
      React.useEffect(() => {
        if (!state.open || typeof MutationObserver === 'undefined') return undefined
        const root = rootRef.current ?? transcriptRoot()
        if (!root) return undefined
        let timer = null
        const observer = new MutationObserver(() => {
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(() => {
            paint(collectTranscriptRanges(query, root), indexRef.current, false)
          }, 220)
        })
        observer.observe(root, { childList: true, subtree: true, characterData: true })
        return () => {
          observer.disconnect()
          if (timer !== null) clearTimeout(timer)
        }
      }, [state.open, query, paint])

      React.useEffect(() => () => { clearHighlights() }, [])

      const close = () => {
        findStore.set({ open: false, sessionId: state.sessionId ?? null, query })
        clearHighlights()
      }

      const move = (delta) => {
        const ranges = rangesRef.current
        if (ranges.length === 0) return
        const next = (indexRef.current + delta + ranges.length) % ranges.length
        indexRef.current = next
        paintHighlights(ranges, next)
        setStatus({ count: ranges.length, index: next })
        revealRange(ranges[next])
      }

      /** Hand the query to the indexed dialog, which also sees not-yet-rendered history. */
      const openHistory = () => {
        const sessionId = state.sessionId ?? currentSessionId(ctx)
        if (!sessionId) return
        findStore.set({ open: false, sessionId, query })
        clearHighlights()
        dialogStore.set({ open: true, sessionId, initialHit: null, query, terms: [] })
      }

      if (!state.open) return null
      const hasMatches = status.count > 0
      return createElement(
        'div',
        { className: 'dsss-findbar', 'data-dsh-find': '', role: 'search' },
        createElement('input', {
          className: 'dsss-input',
          type: 'text',
          value: query,
          placeholder: t('findPlaceholder'),
          autoFocus: true,
          spellCheck: false,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              move(event.shiftKey ? -1 : 1)
              return
            }
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            close()
          },
        }),
        createElement('span', { className: 'dsss-findcount' },
          hasMatches
            ? t('findCount', { index: status.index + 1, count: status.count })
            : (isBlank(query) ? '' : t('findNone'))),
        createElement('button', {
          type: 'button', className: 'dsss-findbtn', title: t('findPrev'), disabled: !hasMatches, onClick: () => move(-1),
        }, '‹'),
        createElement('button', {
          type: 'button', className: 'dsss-findbtn', title: t('findNext'), disabled: !hasMatches, onClick: () => move(1),
        }, '›'),
        createElement('button', {
          type: 'button', className: 'dsss-findbtn', title: t('findAllHistory'), onClick: openHistory,
        }, t('findAllHistory')),
        createElement('button', {
          type: 'button', className: 'dsss-iconbtn', title: t('findClose'), 'aria-label': t('findClose'), onClick: close,
        }, createElement('svg', {
          width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
        }, createElement('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))),
      )
    }

    /**
     * The frame-wide overlay entry: the indexed history dialog and the find bar share one
     * registration so neither can shadow the other.
     */
    function SearchOverlays(props) {
      const ctx = props.ctx
      const t = resolveT(ctx, props)
      const dialog = useStore(dialogStore)
      const find = useStore(findStore)
      if (!dialog.open && !find.open) return null
      return createElement(
        React.Fragment,
        null,
        dialog.open && dialog.sessionId
          ? createElement(SearchDialogBody, {
            // A new session or a different hit remounts the body so its staged state resets.
            key: `${dialog.sessionId}:${dialog.initialHit ? dialog.initialHit.seq : 'q'}`,
            ctx,
            t,
            sessionId: dialog.sessionId,
            initialHit: dialog.initialHit,
            initialQuery: dialog.initialHit ? (dialog.query ?? '') : '',
            initialTerms: dialog.initialHit ? (dialog.terms ?? []) : [],
          })
          : null,
        find.open ? createElement(FindBar, { key: 'find', ctx, t }) : null,
      )
    }

    function SearchDialogBody({ ctx, t, sessionId, initialHit, initialQuery, initialTerms }) {
      const [query, setQuery] = React.useState(initialQuery ?? '')
      const [kind, setKind] = React.useState('all')
      const [picked, setPicked] = React.useState(initialHit ?? null)
      const kinds = kind === 'all' ? null : [kind]
      const [state, run] = useSearch(ctx, {
        limit: SEARCH_LIMIT,
        kinds,
        kindsKey: kind,
        includeSubagents: true,
        sessionIds: [sessionId],
        scopeKey: sessionId,
      })

      React.useEffect(() => {
        if (isBlank(query)) return undefined
        const timer = setTimeout(() => run(query), 200)
        return () => clearTimeout(timer)
      }, [query, kind])

      const close = () => dialogStore.set({ open: false, sessionId: null, initialHit: null, query: '', terms: [] })
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (picked) setPicked(null)
          else close()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [picked])

      const result = state.result
      const hits = result?.hits ?? []
      // A hit carried in from the global page has no local result yet, so fall back to the
      // terms it was opened with — otherwise nothing can be highlighted.
      const terms = result?.terms?.length ? result.terms : (initialTerms ?? [])
      const pickIndex = picked ? hits.findIndex((candidate) => candidate.sessionId === picked.sessionId && candidate.seq === picked.seq) : -1
      const ordinal = pickIndex === -1
        ? null
        : { index: pickIndex + 1, count: hits.length, hasPrev: pickIndex > 0, hasNext: pickIndex < hits.length - 1 }

      const openSession = (id) => {
        const workspace = ctx.get('uiWorkspace')
        if (workspace && typeof workspace.openSession === 'function') workspace.openSession(id)
        close()
      }

      if (picked) {
        return createElement(
          Dialog,
          {
            t,
            title: picked.sessionTitle || t('sessionTitle'),
            onClose: close,
          },
          {
            body: createElement(HitDetail, {
              ctx,
              t,
              hit: picked,
              terms,
              ordinal,
              onPrev: ordinal?.hasPrev ? () => setPicked(hits[pickIndex - 1]) : undefined,
              onNext: ordinal?.hasNext ? () => setPicked(hits[pickIndex + 1]) : undefined,
              onOpenSession: openSession,
              onBack: () => setPicked(null),
            }),
          },
        )
      }

      const status = statusLine(t, state)
      return createElement(
        Dialog,
        { t, title: t('sessionTitle'), onClose: close },
        {
          header: createElement(
            React.Fragment,
            null,
            createElement('input', {
              className: 'dsss-input',
              type: 'search',
              value: query,
              placeholder: t('sessionPlaceholder'),
              autoFocus: true,
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
            }),
            createElement(KindChips, { t, value: kind, onChange: setKind }),
            status ? createElement('div', { className: 'dsss-status' }, status) : null,
          ),
          body: hits.length === 0
            ? createElement('div', { className: 'dsss-centre' }, result ? t('noMatch') : t('sessionPlaceholder'))
            : createElement(ResultRows, { hits, t, showWhere: false, onPick: setPicked }),
        },
      )
    }

    /** The per-session header button. */
    function HeaderSearchButton(props) {
      const ctx = props.ctx
      const t = resolveT(ctx, props)
      const sessionId = props.sessionId
      const open = () => {
        if (!sessionId) return
        findStore.set({ open: true, sessionId, query: '' })
      }
      return createElement('button', {
        type: 'button',
        className: 'dsss-iconbtn',
        title: t('sessionButton'),
        'aria-label': t('sessionButton'),
        disabled: !sessionId,
        onClick: open,
      }, searchIcon(16))
    }

    /** The full centre-column search page, with an optional session scope. */
    function SearchPanel(props) {
      const ctx = props.ctx
      const t = resolveT(ctx, props)
      const [query, setQuery] = React.useState('')
      const [kind, setKind] = React.useState('all')
      const [includeSubagents, setIncludeSubagents] = React.useState(false)
      const [scope, setScope] = React.useState('')
      const [sessions, setSessions] = React.useState([])
      const kinds = kind === 'all' ? null : [kind]
      const sessionIds = scope ? [scope] : null
      const [state, run] = useSearch(ctx, {
        limit: props.limit ?? SEARCH_LIMIT,
        kinds,
        kindsKey: kind,
        includeSubagents,
        sessionIds,
        scopeKey: scope,
      })

      React.useEffect(() => {
        const timer = setTimeout(() => run(query), 220)
        return () => clearTimeout(timer)
      }, [query, kind, includeSubagents, scope])

      React.useEffect(() => {
        let cancelled = false
        callHost(ctx, 'sessions', { limit: 400 })
          .then((reply) => { if (!cancelled) setSessions(Array.isArray(reply?.sessions) ? reply.sessions : []) })
          .catch(() => { /* the picker simply stays empty */ })
        return () => { cancelled = true }
      }, [ctx])

      const result = state.result
      const hits = result?.hits ?? []
      const terms = result?.terms ?? []
      const status = statusLine(t, state)

      // While a query is active the picker offers only the sessions that actually matched,
      // with their hit counts — choosing a session that cannot match the query is useless.
      // The facets are counted host-side across every session, so they stay complete even
      // after the scope narrows the visible hits.
      const facets = Array.isArray(result?.facets) ? result.facets : []
      const choices = (() => {
        const base = facets.length > 0
          ? facets.map((facet) => ({
            sessionId: facet.sessionId,
            title: facet.sessionTitle,
            cwd: facet.cwd,
            total: facet.total,
          }))
          : sessions.map((session) => ({
            sessionId: session.sessionId,
            title: session.title,
            cwd: session.cwd,
            total: null,
          }))
        // Keep the current selection addressable even when it matched nothing.
        if (scope && !base.some((choice) => choice.sessionId === scope)) {
          const known = sessions.find((session) => session.sessionId === scope)
          base.unshift({ sessionId: scope, title: known?.title, cwd: known?.cwd, total: 0 })
        }
        return base
      })()

      const openHit = (hit) => {
        dialogStore.set({
          open: true,
          sessionId: hit.sessionId,
          initialHit: hit,
          query: result?.query ?? query,
          terms,
        })
      }
      const openSession = (sessionId) => {
        const workspace = ctx.get('uiWorkspace')
        if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
      }

      const scopeSelect = createElement(
        'select',
        {
          className: 'dsss-select',
          value: scope,
          title: t('scopeHint'),
          onChange: (event) => setScope(event.target.value),
        },
        createElement('option', { value: '' }, t('scopeAll')),
        ...choices.map((choice) => createElement(
          'option',
          { key: choice.sessionId, value: choice.sessionId },
          `${choice.title || choice.cwd || choice.sessionId}`.slice(0, 72)
            + (choice.total === null ? '' : ` (${choice.total})`),
        )),
      )

      return createElement(
        'div',
        { className: 'dsss-page' },
        createElement(
          'div',
          { className: 'dsss-head' },
          createElement(
            'div',
            { className: 'dsss-headrow' },
            createElement('div', { className: 'dsss-title' }, t('title')),
            scopeSelect,
          ),
          createElement('input', {
            className: 'dsss-input',
            type: 'search',
            value: query,
            placeholder: scope ? t('sessionPlaceholder') : t('placeholder'),
            autoFocus: true,
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Escape' || query.length === 0) return
              event.stopPropagation()
              setQuery('')
            },
          }),
          createElement(KindChips, {
            t,
            value: kind,
            onChange: setKind,
            extra: createElement(
              'label',
              { className: 'dsss-check' },
              createElement('input', {
                type: 'checkbox',
                checked: includeSubagents,
                disabled: Boolean(scope),
                onChange: (event) => setIncludeSubagents(event.target.checked),
              }),
              t('includeSubagents'),
            ),
          }),
          status ? createElement('div', { className: 'dsss-status' }, status) : null,
        ),
        hits.length === 0
          ? createElement('div', { className: 'dsss-centre' }, result ? t('noMatch') : t('empty'))
          : createElement(ResultRows, {
            hits,
            t,
            showWhere: !scope,
            onPick: openHit,
          }),
      )
    }

    /** The sidebar rail/panel button. */
    function PanelIcon({ size }) {
      return searchIcon(size ?? 16)
    }

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }),
        'session-search: dictionaries',
      )

      const t = (() => {
        try { return ctx.locale.bind(NS) } catch { return (key) => DICT.zh[key] ?? key }
      })()

      // One tagged stylesheet; the module system attributes <style> tags by data-plugin.
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-session-search'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'session-search: styles')

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 5,
        label: () => t('panel'),
        locale: NS,
      }, PanelIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ ctx }),
      }, SearchPanel))

      // The per-session entry point: the right-aligned conversation header utilities.
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: PANEL_ID,
        order: 5,
        locale: NS,
        label: () => t('sessionButton'),
        inject: () => ({ ctx }),
      }, HeaderSearchButton))

      // The dialog + find bar layer: a frame-wide overlay that stays mounted and renders
      // nothing while both are closed.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-search-dialog',
        order: 200,
        locale: NS,
        inject: () => ({ ctx }),
      }, SearchOverlays))

      // Ctrl/Cmd+Shift+F selects the panel from anywhere — desktop profiles only.
      //
      // The Web profiles are deliberately unbound: `session.fork` (shipped in
      // `dsh-client-ui-workspace`) already owns `KeyF + primary+shift` there, and a
      // shortcut's defaults are validated across every declared profile atomically.
      // Two plugins claiming the same default makes whichever registers second throw
      // `Conflicting shortcut defaults` — and that failure is not local: when it hit
      // `ui-workspace`, the missing `uiWorkspace` service left 16 client entries
      // pending and turned the whole web boot into a fatal error.
      //
      // Registration is guarded for the same reason: a future release re-binding one of
      // these must cost this plugin its shortcut, never the application's boot.
      ctx.inject(['shortcuts'], (scope) => {
        const register = (definition) => {
          scope.effect(() => {
            try {
              return scope.shortcuts.register(definition)
            } catch (error) {
              // Degrade to "no shortcut" rather than failing this plugin's activation.
              ctx.logger?.warn?.(`session-search: shortcut ${definition.id} unavailable (${error?.message ?? error})`)
              return () => {}
            }
          }, `session-search: ${definition.id}`)
        }

        register({
          id: 'session-search.open',
          label: () => t('panel'),
          aliases: ['session search', 'search sessions', '搜索会话'],
          defaults: {
            'desktop:windows': { code: 'KeyF', modifiers: ['primary', 'shift'] },
            'desktop:macos': { code: 'KeyF', modifiers: ['primary', 'shift'] },
            'desktop:linux': { code: 'KeyF', modifiers: ['primary', 'shift'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: () => {
            const layout = ctx.get('layout')
            if (!layout || typeof layout.selectPanel !== 'function') return { status: 'blocked', reason: 'unavailable' }
            return { status: 'handled', run: () => layout.selectPanel(PANEL_ID) }
          },
        })

        // Ctrl/Cmd+F opens the browser-style find bar for the conversation on screen.
        // `KeyF` with primary only is not claimed by any shipped shortcut (the shipped
        // `session.fork` uses primary+alt on desktop and primary+shift on Web), and the
        // Web profiles stay unbound for the same reason as above.
        register({
          id: 'session-search.find',
          label: () => t('findPlaceholder'),
          aliases: ['find in session', 'find in conversation', '会话内查找'],
          defaults: {
            'desktop:windows': { code: 'KeyF', modifiers: ['primary'] },
            'desktop:macos': { code: 'KeyF', modifiers: ['primary'] },
            'desktop:linux': { code: 'KeyF', modifiers: ['primary'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: () => ({
            status: 'handled',
            run: () => findStore.set({ open: true, sessionId: currentSessionId(ctx) ?? null, query: '' }),
          }),
        })
      })

      ctx.logger?.info?.('session-search: client surfaces registered')
    }

    return { NS, PANEL_ID, apply, inject }
  },
})
