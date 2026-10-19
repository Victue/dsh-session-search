/**
 * Client-half test.
 *
 * The browser half is a module-system bundle, not an ES module, so it is loaded here the
 * way the page loads it: by defining `window.__ModuleLoader__` and invoking the captured
 * factory with a stub `require`. React is stubbed with just enough hook runtime and
 * function-component rendering to walk a rendered tree, which catches module-scope
 * mistakes, wrong slot registration shapes and render-time crashes without a browser.
 *
 * Run: node --test test/client.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).name

/**
 * Minimal React stand-in. Function components are rendered inline so the returned tree
 * contains host elements only. `overrides` supplies values for specific `useState` call
 * indices, letting a test drive a component into a non-initial state.
 */
function createReactStub(overrides = {}) {
  let useStateCalls = 0
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      if (type === Fragment) return merged.children
      if (typeof type === 'function') return type(merged)
      return { type, props: merged }
    },
    useState(initial) {
      const index = useStateCalls++
      const value = Object.prototype.hasOwnProperty.call(overrides, index)
        ? overrides[index]
        : (typeof initial === 'function' ? initial() : initial)
      return [value, () => {}]
    },
    useRef(value) { return { current: value ?? null } },
    useCallback(fn) { return fn },
    useEffect() {},
  }
}

/** Load the client bundle and return its factory. */
function loadClientBundle() {
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const registrations = []
  const scope = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  const evaluate = new Function('window', 'require', `${source}\n`)
  evaluate(scope, (specifier) => {
    if (specifier === 'react') return createReactStub()
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
  assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
  return { registration: registrations[0], factory: registrations[0].factory }
}

/** Instantiate the plugin with a react stub that honours `overrides`. */
function instantiate(overrides = {}) {
  const { factory } = loadClientBundle()
  const requested = []
  const plugin = factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return createReactStub(overrides)
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
  return { plugin, requested }
}

/** Cordis stand-in capturing slot, locale and shortcut registrations. */
function createClientContext({ remoteReply } = {}) {
  const slots = []
  const locales = []
  const shortcuts = []
  const calls = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    effect: (factory) => {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject: (dependencies, callback) => callback(ctx),
    get: (key) => {
      if (key === 'connection') {
        return {
          rpc: {
            call: async (channel, endpoint, payload) => {
              calls.push({ channel, endpoint, payload })
              return remoteReply
            },
          },
        }
      }
      if (key === 'layout') return { selectPanel: () => {} }
      if (key === 'uiWorkspace') return { openSession: () => {} }
      return undefined
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => { slots.push({ options, component }); return () => {} },
    },
    locale: {
      register: (namespace, dictionaries) => { locales.push({ namespace, dictionaries }) },
      bind: () => (key, params) => {
        if (!params) return `t:${key}`
        return `t:${key}${JSON.stringify(params)}`
      },
    },
    shortcuts: { register: (definition) => { shortcuts.push(definition); return () => {} } },
  }
  return { ctx, slots, locales, shortcuts, calls }
}

/** Flatten a rendered tree into its text content. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** Depth-first search for the first host element satisfying a predicate. */
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return undefined
  }
  if (!node || typeof node !== 'object' || typeof node.type === 'undefined') return undefined
  if (predicate(node)) return node
  return find(node.props?.children, predicate)
}

const baseT = (key, params) => (params ? `t:${key}${JSON.stringify(params)}` : `t:${key}`)

/** A search result the host would return for one hit. */
function sampleResult() {
  const hits = [{
    sessionId: 'session-1',
    sessionTitle: '示例会话',
    cwd: 'D:\\Code\\demo',
    seq: 7,
    time: Date.UTC(2026, 9, 16, 6, 6),
    kind: 'user',
    type: 'user/message',
    snippet: '这里是命中的内容片段',
    snippetMarks: [[3, 5]],
    textLength: 10,
  }]
  return {
    query: '命中', terms: ['命中'], hits, total: 1, sessions: 1, scanned: 9, tookMs: 7,
    stats: { sessions: 3, documents: 20 },
  }
}

test('the bundle registers itself under the package name', () => {
  const { registration } = loadClientBundle()
  assert.equal(registration.id, PACKAGE_NAME)
  assert.equal(typeof registration.factory, 'function')
})

test('the client half requires nothing but react', () => {
  const { plugin, requested } = instantiate()
  assert.deepEqual(requested, ['react'], 'the client half must not import Harness packages')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'connection'])
})

test('apply registers all four surfaces plus the desktop-only shortcut', () => {
  const { plugin } = instantiate()
  const { ctx, slots, locales, shortcuts } = createClientContext()
  plugin.apply(ctx)

  assert.deepEqual(locales.map((entry) => entry.namespace), [plugin.NS])
  assert.ok(locales[0].dictionaries.zh && locales[0].dictionaries.en)

  const bySlot = (name) => slots.find((entry) => entry.options.name === name)
  const panel = bySlot('sidebar.panellist')
  const main = bySlot('main')
  const header = bySlot('conversation.session.header.utilities')
  const dialog = bySlot('shell.overlay')

  assert.ok(panel, 'sidebar.panellist must be occupied')
  assert.ok(main, 'the main panel must be occupied')
  assert.ok(header, 'the per-session header must offer the search button')
  assert.ok(dialog, 'the dialog layer must be occupied')

  // The sidebar dispatches `main` by the panellist id, so they have to agree.
  assert.equal(panel.options.id, plugin.PANEL_ID)
  assert.equal(main.options.key, plugin.PANEL_ID)
  assert.equal(header.options.id, plugin.PANEL_ID)
  assert.equal(typeof panel.options.label, 'function')
  assert.deepEqual(main.options.inject(), { ctx })
  assert.deepEqual(header.options.inject(), { ctx })
  assert.deepEqual(dialog.options.inject(), { ctx })

  assert.equal(shortcuts.length, 1)
  assert.equal(shortcuts[0].id, 'session-search.open')
  // Desktop profiles only: `session.fork` owns KeyF + primary+shift on Web profiles.
  assert.deepEqual(Object.keys(shortcuts[0].defaults).sort(), [
    'desktop:linux', 'desktop:macos', 'desktop:windows',
  ])
  assert.equal(shortcuts[0].resolve().status, 'handled')
})

test('a rejected shortcut registration must not break plugin activation', () => {
  // Regression: claiming a key another plugin already owns used to throw out of `apply`,
  // and when that other plugin was `ui-workspace` the whole web boot failed.
  const { plugin } = instantiate()
  const { ctx, slots } = createClientContext()
  const warnings = []
  ctx.shortcuts.register = () => { throw new Error('Conflicting shortcut defaults: session-search.open and session.fork (web:windows)') }
  ctx.logger = { info: () => {}, warn: (message) => warnings.push(message) }

  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.ok(slots.some((entry) => entry.options.name === 'sidebar.panellist'))
  assert.ok(slots.some((entry) => entry.options.name === 'main'))
  assert.ok(warnings.some((message) => /shortcut unavailable/.test(message)))
})

test('the panel icon renders an svg at the requested size', () => {
  const { plugin } = instantiate()
  const { ctx, slots } = createClientContext()
  plugin.apply(ctx)
  const icon = slots.find((entry) => entry.options.name === 'sidebar.panellist').component
  const tree = icon({ size: 18, active: true })
  assert.equal(tree.type, 'svg')
  assert.equal(tree.props.width, 18)
})

test('the header button renders for the current session and is disabled without one', () => {
  const { plugin } = instantiate()
  const { ctx, slots } = createClientContext()
  plugin.apply(ctx)
  const Button = slots.find((entry) => entry.options.name === 'conversation.session.header.utilities').component

  const enabled = Button({ ctx, sessionId: 'session-1', t: baseT })
  assert.equal(enabled.type, 'button')
  assert.equal(enabled.props['aria-label'], 't:sessionButton')
  assert.equal(enabled.props.disabled, false)

  const disabled = Button({ ctx, sessionId: undefined, t: baseT })
  assert.equal(disabled.props.disabled, true)
})

test('the dialog layer renders nothing while closed', () => {
  const { plugin } = instantiate()
  const { ctx, slots } = createClientContext()
  plugin.apply(ctx)
  const Dialog = slots.find((entry) => entry.options.name === 'shell.overlay').component
  assert.equal(Dialog({ ctx, t: baseT }), null)
})

test('the global page renders hits with a highlighted match', () => {
  const result = sampleResult()
  // useState order in SearchPanel: query, kind, subagents, scope, sessions, then the
  // search run state.
  const { plugin } = instantiate({ 0: '命中', 5: { status: 'done', result, error: null } })
  const { ctx, slots } = createClientContext()
  plugin.apply(ctx)
  const SearchPanel = slots.find((entry) => entry.options.name === 'main').component

  const tree = SearchPanel({ ctx, t: baseT })
  const text = textOf(tree)
  assert.match(text, /示例会话/)
  assert.match(text, /这里是命中的内容片段/)
  assert.match(text, /summary/)

  const mark = find(tree, (node) => node.type === 'mark')
  assert.ok(mark, 'the matched range must be highlighted')
  assert.equal(mark.props.children, '命中')
})

test('the global page offers a session scope picker', () => {
  const { plugin } = instantiate()
  const { ctx, slots } = createClientContext()
  plugin.apply(ctx)
  const SearchPanel = slots.find((entry) => entry.options.name === 'main').component

  const tree = SearchPanel({ ctx, t: baseT })
  const select = find(tree, (node) => node.type === 'select')
  assert.ok(select, 'a scope picker must be present')
  assert.equal(select.props.value, '')
  // The "all sessions" option is always available.
  assert.match(textOf(tree), /(scopeAll)/)
})
