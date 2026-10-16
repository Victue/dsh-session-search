/**
 * Session content search — browser half.
 *
 * Adds a first-class global search destination to the sidebar: a panel icon in
 * `sidebar.panellist` plus the matching `main` panel, and a Ctrl/Cmd+Shift+F shortcut.
 * The sidebar owns the button and selects the panel, so no click wiring is needed.
 *
 * This file is a client MODULE BUNDLE, not an ES module: the module system loads it as
 * a script and expects it to register itself through `window.__ModuleLoader__.load`.
 * Only the platform seed table is require-able (`react`, `@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-client-ui-primitives`, ...). Everything else is reached through
 * Cordis services, which is why this plugin requires nothing but `react`.
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
      },
    }

    const KIND_LABEL = { user: 'kindsUser', assistant: 'kindsAssistant', tool: 'kindsTool', title: 'kindsAll' }

    const inject = ['slots', 'locale', 'connection']

    const STYLE = {
      root: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      header: {
        padding: '16px 20px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))',
      },
      title: { fontSize: 'var(--dsw-font-base-16, 15px)', fontWeight: 600 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '9px 12px',
        fontSize: 'var(--dsw-font-base-16, 14px)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28))',
        borderRadius: '8px',
        outline: 'none',
      },
      toolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      chip: (active) => ({
        padding: '3px 10px',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        borderRadius: '999px',
        border: '1px solid ' + (active
          ? 'var(--dsw-alias-border-l2, rgba(128,128,128,.5))'
          : 'transparent'),
        background: active
          ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18))'
          : 'transparent',
        color: active
          ? 'var(--dsw-alias-label-primary, inherit)'
          : 'var(--dsw-alias-label-secondary, rgba(128,128,128,1))',
        userSelect: 'none',
      }),
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,1))' },
      list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0 24px' },
      row: {
        padding: '10px 20px',
        cursor: 'pointer',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12))',
      },
      rowTop: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,1))',
        marginBottom: '4px',
      },
      rowTitle: {
        color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,1))',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
      },
      snippet: {
        fontSize: 'var(--dsw-font-base-16, 14px)',
        lineHeight: '21px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '63px',
        overflow: 'hidden',
      },
      mark: {
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,214,0,.32))',
        color: 'inherit',
        borderRadius: '3px',
        padding: '0 1px',
      },
      centre: {
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,1))',
        fontSize: '13px',
      },
    }

    /** Resolve the translation seat, falling back to the shipped dictionaries. */
    function resolveT(ctx, props) {
      if (props && typeof props.t === 'function') return props.t
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') return ctx.locale.bind(NS)
      } catch {
        /* fall through to the built-in dictionary */
      }
      return (key, ...args) => {
        const value = DICT.zh[key]
        return typeof value === 'function' ? value(...args) : (value ?? key)
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
        createElement('circle', {
          cx: 7, cy: 7, r: 4.5,
          stroke: 'currentColor', strokeWidth: 1.4,
        }),
        createElement('path', {
          d: 'M10.5 10.5 14 14',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
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
        if (end > start) children.push(createElement('mark', { key: `m${index}`, style: STYLE.mark }, text.slice(start, end)))
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
        throw new Error(reply.error?.message ?? 'search failed')
      }
      return reply
    }

    function useSearch(ctx, options) {
      const [state, setState] = React.useState({ status: 'idle', result: null, error: null })
      const abortRef = React.useRef(null)
      const run = React.useCallback((query) => {
        if (abortRef.current) abortRef.current.abort()
        if (isBlank(query)) {
          setState({ status: 'idle', result: null, error: null })
          return
        }
        const connection = ctx.get('connection')
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          setState({ status: 'error', result: null, error: new Error('no connection') })
          return
        }
        const controller = new AbortController()
        abortRef.current = controller
        setState(previous => ({ status: previous.result ? 'refreshing' : 'searching', result: previous.result, error: null }))
        connection.rpc
          .call(CHANNEL, 'search', { query, limit: options.limit, kinds: options.kinds, includeSubagents: options.includeSubagents }, controller.signal)
          .then((reply) => {
            if (controller.signal.aborted) return
            setState({ status: 'done', result: unwrapReply(reply), error: null })
          })
          .catch((error) => {
            if (controller.signal.aborted || error?.name === 'AbortError') return
            setState({ status: 'error', result: null, error })
          })
      }, [options.limit, options.kindsKey, options.includeSubagents])
      React.useEffect(() => () => { if (abortRef.current) abortRef.current.abort() }, [])
      return [state, run]
    }

    /** The full centre-column search page. */
    function SearchPanel(props) {
      const ctx = props.ctx
      const t = resolveT(ctx, props)
      const [query, setQuery] = React.useState('')
      const [kind, setKind] = React.useState('all')
      const [includeSubagents, setIncludeSubagents] = React.useState(false)
      const kinds = kind === 'all' ? null : [kind]
      const [state, run] = useSearch(ctx, {
        limit: props.limit ?? 300,
        kinds,
        kindsKey: kind,
        includeSubagents,
      })

      React.useEffect(() => {
        const timer = setTimeout(() => run(query), 220)
        return () => clearTimeout(timer)
      }, [query, kind, includeSubagents])

      const openSession = (sessionId) => {
        const workspace = ctx.get('uiWorkspace')
        if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
      }

      const result = state.result
      const hits = result?.hits ?? []
      const busy = state.status === 'searching' || state.status === 'refreshing'

      const toolbar = createElement(
        'div',
        { style: STYLE.toolbar },
        ...[['all', 'kindsAll'], ['user', 'kindsUser'], ['assistant', 'kindsAssistant'], ['tool', 'kindsTool']]
          .map(([value, labelKey]) => createElement(
            'span',
            {
              key: value,
              role: 'button',
              tabIndex: 0,
              style: STYLE.chip(kind === value),
              onClick: () => setKind(value),
            },
            t(labelKey),
          )),
        createElement('span', { style: { flex: 1 } }),
        createElement(
          'label',
          { style: { ...STYLE.status, display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' } },
          createElement('input', {
            type: 'checkbox',
            checked: includeSubagents,
            onChange: (event) => setIncludeSubagents(event.target.checked),
          }),
          t('includeSubagents'),
        ),
      )

      let status = t('sort')
      if (busy) status = state.status === 'searching' && !result ? t('indexing') : t('searching')
      else if (result) status = t('summary', { total: result.total, sessions: result.sessions, ms: result.tookMs ?? 0 })
      else if (state.status === 'error') status = state.error?.message === 'no connection' ? t('unavailable') : t('failed', { message: String(state.error?.message ?? '') })

      const body = (() => {
        if (hits.length === 0) {
          const message = result ? t('noMatch') : t('empty')
          return createElement('div', { style: STYLE.centre }, message)
        }
        return createElement(
          'div',
          { style: STYLE.list },
          ...hits.map((hit, index) => createElement(
            'div',
            {
              key: `${hit.sessionId}:${hit.seq}:${index}`,
              style: STYLE.row,
              role: 'button',
              tabIndex: 0,
              title: t('open'),
              onClick: () => openSession(hit.sessionId),
              onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.10))' },
              onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
            },
            createElement(
              'div',
              { style: STYLE.rowTop },
              createElement('span', null, formatTime(hit.time)),
              createElement('span', null, t(KIND_LABEL[hit.kind] ?? 'kindsAll')),
              createElement('span', { style: STYLE.rowTitle }, hit.sessionTitle || hit.cwd || hit.sessionId),
            ),
            createElement('div', { style: STYLE.snippet }, renderSnippet(hit)),
          )),
        )
      })()

      return createElement(
        'div',
        { style: STYLE.root },
        createElement(
          'div',
          { style: STYLE.header },
          createElement('div', { style: STYLE.title }, t('title')),
          createElement('input', {
            style: STYLE.input,
            type: 'search',
            value: query,
            placeholder: t('placeholder'),
            autoFocus: true,
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Escape') return
              if (query.length > 0) {
                event.stopPropagation()
                setQuery('')
              }
            },
          }),
          toolbar,
          createElement('div', { style: STYLE.status }, status),
        ),
        body,
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

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 5,
        label: () => {
          try {
            return ctx.locale.bind(NS)('panel')
          } catch {
            return DICT.zh.panel
          }
        },
        locale: NS,
      }, PanelIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ ctx }),
      }, SearchPanel))

      // Ctrl/Cmd+Shift+F selects the panel from anywhere. `web:linux` is deliberately
      // unbound: the Web allowance there admits only a few two-modifier combos, and a
      // definition is validated across all six profiles atomically.
      ctx.inject(['shortcuts'], (scope) => {
        const t = (() => {
          try { return scope.locale.bind(NS) } catch { return (key) => DICT.zh[key] ?? key }
        })()
        scope.effect(() => scope.shortcuts.register({
          id: 'session-search.open',
          label: () => t('panel'),
          aliases: ['session search', 'search sessions', '搜索会话'],
          defaults: {
            'desktop:windows': { code: 'KeyF', modifiers: ['primary', 'shift'] },
            'desktop:macos': { code: 'KeyF', modifiers: ['primary', 'shift'] },
            'desktop:linux': { code: 'KeyF', modifiers: ['primary', 'shift'] },
            'web:windows': { code: 'KeyF', modifiers: ['primary', 'shift'] },
            'web:macos': { code: 'KeyF', modifiers: ['primary', 'shift'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: () => {
            const layout = ctx.get('layout')
            if (!layout || typeof layout.selectPanel !== 'function') return { status: 'blocked', reason: 'unavailable' }
            return { status: 'handled', run: () => layout.selectPanel(PANEL_ID) }
          },
        }), 'session-search: shortcut')
      })

      ctx.logger?.info?.('session-search: client panel registered')
    }

    return { NS, PANEL_ID, apply, inject }
  },
})
