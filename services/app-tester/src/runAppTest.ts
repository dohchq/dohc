import { type AppTestSeed, type SdkCall } from './appTestSdk'
import ts from 'typescript'

export type AppTestFile = {
  relativePath: string
  body: string
}

export type AppTestCheck = {
  name: string
  status: 'ok' | 'failed'
  code?: string
  message?: string
}

export type RunAppTestInput = {
  packageRoot: string
  files: AppTestFile[]
  manifest?: {
    collections?: Record<string, unknown>
    databases?: Record<string, unknown>
    tests?: unknown[]
  }
  seed?: AppTestSeed
  mode?: 'static' | 'browser' | 'integration'
}

export type RunAppTestResult = {
  ok: boolean
  packageRoot: string
  checks: AppTestCheck[]
  failures: AppTestCheck[]
  artifacts?: {
    screenshots?: Array<{
      name: string
      mimeType: 'image/png'
      dataUrl: string
      reason: string
    }>
  }
}

function isCodeFile(file: AppTestFile): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(file.relativePath)
}

function source(input: RunAppTestInput): string {
  return input.files.filter(isCodeFile).map((file) => file.body).join('\n')
}

function hasRealRows(seed: AppTestSeed | undefined): boolean {
  return Object.values(seed?.collections ?? {}).some((rows) => rows.length > 0) ||
    Object.values(seed?.docs ?? {}).some((body) => body.trim().length > 0) ||
    Object.values(seed?.databases ?? {}).some((tables) =>
      Object.values(tables).some((rows) => rows.length > 0),
    )
}

type RenderNode =
  | null
  | undefined
  | boolean
  | string
  | number
  | RenderElement
  | RenderNode[]

type RenderElement = {
  type: unknown
  props: Record<string, unknown>
  key?: unknown
}

type RuntimeResult = {
  ok: true
  html: string
  text: string
  buttonCount: number
  hiddenButtonCount: number
  sdkCalls: SdkCall[]
  beforeSnapshot: unknown
  afterSnapshot: unknown
  controlResults: Array<{
    label: string
    sdkCalls: SdkCall[]
    beforeSnapshot: unknown
    afterSnapshot: unknown
    error?: string
  }>
} | {
  ok: false
  code: string
  message: string
  html: string
}

const FRAGMENT = Symbol.for('dohc.app-tester.fragment')

function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): RenderElement {
  return { type, props: props ?? {}, ...(key === undefined ? {} : { key }) }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function childrenOf(node: RenderElement): RenderNode[] {
  const children = node.props.children
  return Array.isArray(children) ? children : [children as RenderNode]
}

function isHiddenButton(button: RenderElement): boolean {
  const style = button.props.style
  return (
    button.props.hidden === true ||
    button.props['aria-hidden'] === true ||
    (
      style !== null &&
      typeof style === 'object' &&
      !Array.isArray(style) &&
      (style as Record<string, unknown>).display === 'none'
    )
  )
}

function collectButtons(node: RenderNode, buttons: RenderElement[] = []): RenderElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, buttons)
    return buttons
  }
  if (!node || typeof node !== 'object') return buttons
  if ((node as RenderElement).type === 'button') buttons.push(node as RenderElement)
  for (const child of childrenOf(node as RenderElement)) collectButtons(child, buttons)
  return buttons
}

function renderToHtml(node: RenderNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node))
  if (Array.isArray(node)) return node.map(renderToHtml).join('')
  if (typeof node.type === 'function') {
    return renderToHtml((node.type as (props: Record<string, unknown>) => RenderNode)(node.props))
  }
  if (node.type === FRAGMENT) return childrenOf(node).map(renderToHtml).join('')
  if (typeof node.type !== 'string') return childrenOf(node).map(renderToHtml).join('')
  const children = childrenOf(node).map(renderToHtml).join('')
  const tag = node.type
  return `<${tag}>${children}</${tag}>`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function mutatingCalls(calls: SdkCall[]): SdkCall[] {
  return calls.filter((call) =>
    /(?:insert|update|upsert|delete|set|append|replaceText|section)$/.test(call.op),
  )
}

function stateChanged(control: { beforeSnapshot: unknown; afterSnapshot: unknown }): boolean {
  return stableJson(control.beforeSnapshot) !== stableJson(control.afterSnapshot)
}

function normalizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

const WORKFLOW_VERBS = new Set([
  'add',
  'append',
  'categorize',
  'category',
  'check',
  'complete',
  'create',
  'delete',
  'edit',
  'insert',
  'mark',
  'move',
  'remove',
  'replace',
  'review',
  'save',
  'set',
  'submit',
  'update',
  'upsert',
])

function controlMatchesManifestTest(label: string, name: string): boolean {
  const labelWords = normalizeWords(label)
  const nameWords = normalizeWords(name)
  if (labelWords.length === 0 || nameWords.length === 0) return false
  const labelText = labelWords.join(' ')
  const nameText = nameWords.join(' ')
  if (labelText === nameText) return true
  if (nameText.includes(labelText) && labelWords.some((word) => WORKFLOW_VERBS.has(word))) return true
  const nameSet = new Set(nameWords)
  return labelWords.every((word) => nameSet.has(word)) &&
    labelWords.some((word) => WORKFLOW_VERBS.has(word))
}

function manifestRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function manifestString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function manifestStringOrFirst(value: unknown): string | null {
  const direct = manifestString(value)
  if (direct) return direct
  return Array.isArray(value) ? manifestString(value[0]) : null
}

function scopePathFromPackageRoot(packageRoot: string): string {
  const marker = '/.apps/'
  const index = packageRoot.indexOf(marker)
  if (index < 0) return ''
  return packageRoot.slice(0, index)
}

function appPathCandidates(packageRoot: string, path: string): Set<string> {
  const candidates = new Set([path])
  const scopePath = scopePathFromPackageRoot(packageRoot)
  if (scopePath && path.startsWith(`${scopePath}/`)) {
    candidates.add(path.slice(scopePath.length + 1))
  }
  return candidates
}

function sqliteCollectionTarget(
  manifest: RunAppTestInput['manifest'],
  packageRoot: string,
  collectionName: string,
): { table: string; databases: Set<string> } | null {
  const config = manifestRecord(manifest?.collections?.[collectionName])
  if (!config || config.format !== 'sqlite') return null
  const table = manifestString(config.table)
  const source = manifestStringOrFirst(config.source)
  return table && source ? { table, databases: appPathCandidates(packageRoot, source) } : null
}

function callMatchesManifestTarget(
  call: SdkCall,
  test: Record<string, unknown>,
  manifest: RunAppTestInput['manifest'],
  packageRoot: string,
): boolean {
  const collection = manifestString(test.collection)
  if (collection) {
    if (call.collection === collection) return true
    const sqliteTarget = sqliteCollectionTarget(manifest, packageRoot, collection)
    return Boolean(
      sqliteTarget &&
        call.collection === sqliteTarget.table &&
        call.database &&
        sqliteTarget.databases.has(call.database),
    )
  }
  const path = manifestString(test.path)
  if (path) return call.path === path
  const database = manifestString(test.database)
  if (database) {
    if (call.database === database) return true
    const databaseConfig = manifestRecord(manifest?.databases?.[database])
    const configuredPath = manifestString(databaseConfig?.path)
    return Boolean(
      configuredPath &&
        call.database &&
        appPathCandidates(packageRoot, configuredPath).has(call.database),
    )
  }
  return true
}

async function runRenderedApp(input: RunAppTestInput, code: string): Promise<RuntimeResult> {
  const compiled = ts.transpileModule(code, {
    fileName: 'App.tsx',
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  })
  let browser: Awaited<ReturnType<typeof import('@playwright/test')['chromium']['launch']>> | null = null
  let timedOut = false
  try {
    const { chromium } = await import('@playwright/test')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 800, height: 480 } })
    await page.route('**/*', (route) => route.abort())
    await page.evaluate('globalThis.__name = (target) => target')
    const execute = page.evaluate(
      async ({ outputText, seed, manifest }) => {
        type Row = Record<string, unknown>
        type ElementNode =
          | null
          | undefined
          | boolean
          | string
          | number
          | ElementObject
          | ElementNode[]
        type ElementObject = {
          type: unknown
          props: Record<string, unknown>
          key?: unknown
        }

        const FRAGMENT_VALUE = '__dohc_app_tester_fragment__'
        const sandboxError = (message: string) => new Error(`sandbox-violation: ${message}`)
        Object.defineProperty(globalThis, 'process', {
          configurable: true,
          get() {
            throw sandboxError('Node process global is unavailable in app tests.')
          },
        })
        Object.defineProperty(globalThis, 'fetch', {
          configurable: true,
          value() {
            throw sandboxError('Network access is disabled in app tests.')
          },
        })
        Object.defineProperty(globalThis, 'XMLHttpRequest', {
          configurable: true,
          get() {
            throw sandboxError('Network access is disabled in app tests.')
          },
        })
        Object.defineProperty(globalThis, 'WebSocket', {
          configurable: true,
          get() {
            throw sandboxError('Network access is disabled in app tests.')
          },
        })

        function cloneRows(rows: Row[] = []): Row[] {
          return rows.map((row) => ({ ...row }))
        }

        const collections: Record<string, Row[]> = {}
        for (const [name, rows] of Object.entries(seed?.collections ?? {})) {
          collections[name] = cloneRows(rows as Row[])
        }
        const docs = { ...(seed?.docs ?? {}) } as Record<string, string>
        const databases: Record<string, Record<string, Row[]>> = {}
        for (const [path, tables] of Object.entries(seed?.databases ?? {})) {
          databases[path] = {}
          for (const [table, rows] of Object.entries(tables as Record<string, Row[]>)) {
            databases[path]![table] = cloneRows(rows)
          }
        }
        const sqliteCollections = new Set<string>()
        for (const [name, config] of Object.entries(manifest?.collections ?? {})) {
          if ((config as { format?: unknown }).format === 'sqlite') sqliteCollections.add(name)
        }
        const calls: SdkCall[] = []

        let stateRevision = 0
        function stableJsonLocal(value: unknown): string {
          if (Array.isArray(value)) return `[${value.map(stableJsonLocal).join(',')}]`
          if (value && typeof value === 'object') {
            return `{${Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonLocal(item)}`)
              .join(',')}}`
          }
          return JSON.stringify(value) ?? 'undefined'
        }
        function noteStateChange(changed: boolean) {
          if (changed) stateRevision += 1
        }
        function snapshot() {
          return {
            revision: stateRevision,
            collections: Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, rows.length])),
            docs: Object.fromEntries(Object.entries(docs).map(([path, body]) => [path, body.length])),
            databases: Object.fromEntries(
              Object.entries(databases).map(([path, tables]) => [
                path,
                Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])),
              ]),
            ),
          }
        }

        function collectionApi(name: string, database?: string) {
          const rows = () =>
            database === undefined
              ? (collections[name] ??= [])
              : ((databases[database] ??= {})[name] ??= [])
          const pushCall = (call: SdkCall) => calls.push({ collection: name, database, ...call })
          const rejectPlainSqliteWrite = () => {
            if (database === undefined && sqliteCollections.has(name)) {
              const error = new Error('sqlite-sdk-path-required')
              error.name = 'sqlite-sdk-path-required'
              throw error
            }
          }
          return {
            async list() {
              pushCall({ op: 'collection.list' })
              return cloneRows(rows())
            },
            async get(id: string) {
              pushCall({ op: 'collection.get', id })
              return rows().find((row) => String(row.id ?? row.ID) === id) ?? null
            },
            async insert(record: Row) {
              rejectPlainSqliteWrite()
              pushCall({ op: 'collection.insert', payload: record })
              rows().push({ ...record })
              noteStateChange(true)
              return { ok: true }
            },
            async update(id: string, patch: Row) {
              rejectPlainSqliteWrite()
              pushCall({ op: 'collection.update', id, payload: patch })
              const index = rows().findIndex((row) => String(row.id ?? row.ID) === id)
              if (index >= 0) {
                const before = stableJsonLocal(rows()[index])
                rows()[index] = { ...rows()[index], ...patch }
                noteStateChange(before !== stableJsonLocal(rows()[index]))
              }
              return { ok: true }
            },
            async upsert(id: string, record: Row) {
              rejectPlainSqliteWrite()
              pushCall({ op: 'collection.upsert', id, payload: record })
              const index = rows().findIndex((row) => String(row.id ?? row.ID) === id)
              if (index >= 0) {
                const before = stableJsonLocal(rows()[index])
                rows()[index] = { ...rows()[index], ...record }
                noteStateChange(before !== stableJsonLocal(rows()[index]))
              } else {
                rows().push({ ...record, id })
                noteStateChange(true)
              }
              return { ok: true }
            },
            async delete(id: string) {
              rejectPlainSqliteWrite()
              pushCall({ op: 'collection.delete', id })
              const index = rows().findIndex((row) => String(row.id ?? row.ID) === id)
              if (index >= 0) {
                rows().splice(index, 1)
                noteStateChange(true)
              }
              return { ok: true }
            },
          }
        }

        function docApi(path: string) {
          return {
            async get() {
              calls.push({ op: 'doc.get', path })
              return docs[path] ?? ''
            },
            async set(key: string, value: unknown) {
              calls.push({ op: 'doc.set', path, payload: { key, value } })
              const next = `${docs[path] ?? ''}\n${key}: ${String(value)}`
              noteStateChange(docs[path] !== next)
              docs[path] = next
              return { ok: true }
            },
            async append(markdown: string) {
              calls.push({ op: 'doc.append', path, payload: markdown })
              const next = `${docs[path] ?? ''}\n${markdown}`
              noteStateChange(docs[path] !== next)
              docs[path] = next
              return { ok: true }
            },
          }
        }

        const dohc = {
          collection: (name: string) => collectionApi(name),
          database: (path: string) => ({
            table: (name: string) => collectionApi(name, path),
            query: async () => [],
            tables: async () => Object.keys(databases[path] ?? {}),
          }),
          doc: (path: string) => docApi(path),
        }
        const appSdk = {
          dohc,
          useCollection: (name: string) => collections[name] ?? [],
          useDoc: (path: string) => ({ body: docs[path] ?? '' }),
          useDatabase: (path: string) => databases[path] ?? null,
        }
        function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): ElementObject {
          return { type, props: props ?? {}, ...(key === undefined ? {} : { key }) }
        }
        const reactStub = {
          Fragment: FRAGMENT_VALUE,
          createElement: jsx,
          useMemo: (fn: () => unknown) => fn(),
          useEffect: () => undefined,
          useState: (initial: unknown) => {
            let value = typeof initial === 'function' ? (initial as () => unknown)() : initial
            const setValue = (next: unknown) => {
              value = typeof next === 'function' ? (next as (previous: unknown) => unknown)(value) : next
            }
            return [value, setValue]
          },
        }
        function requireStub(specifier: string) {
          if (specifier === '@dohc/app') return appSdk
          if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: FRAGMENT_VALUE }
          if (specifier === 'react') return { ...reactStub, default: reactStub }
          throw new Error(`Unsupported app test import: ${specifier}`)
        }
        function escapeHtmlLocal(value: string): string {
          return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
        }
        function childrenOfLocal(node: ElementObject): ElementNode[] {
          const children = node.props.children
          return Array.isArray(children) ? children : [children as ElementNode]
        }
        function isHiddenButtonLocal(button: ElementObject): boolean {
          const style = button.props.style
          return (
            button.props.hidden === true ||
            button.props['aria-hidden'] === true ||
            (
              style !== null &&
              typeof style === 'object' &&
              !Array.isArray(style) &&
              (style as Record<string, unknown>).display === 'none'
            )
          )
        }
        function collectButtonsLocal(node: ElementNode, buttons: ElementObject[] = []): ElementObject[] {
          if (Array.isArray(node)) {
            for (const child of node) collectButtonsLocal(child, buttons)
            return buttons
          }
          if (!node || typeof node !== 'object') return buttons
          if ((node as ElementObject).type === 'button') buttons.push(node as ElementObject)
          for (const child of childrenOfLocal(node as ElementObject)) collectButtonsLocal(child, buttons)
          return buttons
        }
        function renderToHtmlLocal(node: ElementNode): string {
          if (node === null || node === undefined || typeof node === 'boolean') return ''
          if (typeof node === 'string' || typeof node === 'number') return escapeHtmlLocal(String(node))
          if (Array.isArray(node)) return node.map(renderToHtmlLocal).join('')
          if (typeof node.type === 'function') return renderToHtmlLocal((node.type as (props: Record<string, unknown>) => ElementNode)(node.props))
          if (node.type === FRAGMENT_VALUE) return childrenOfLocal(node).map(renderToHtmlLocal).join('')
          if (typeof node.type !== 'string') return childrenOfLocal(node).map(renderToHtmlLocal).join('')
          const children = childrenOfLocal(node).map(renderToHtmlLocal).join('')
          return `<${node.type}>${children}</${node.type}>`
        }
        function textContent(node: ElementNode): string {
          if (node === null || node === undefined || typeof node === 'boolean') return ''
          if (typeof node === 'string' || typeof node === 'number') return String(node)
          if (Array.isArray(node)) return node.map(textContent).join(' ')
          return childrenOfLocal(node).map(textContent).join(' ')
        }

        const module = { exports: {} as Record<string, unknown> }
        Function('require', 'exports', 'module', outputText)(requireStub, module.exports, module)
        const App = (module.exports.default ?? module.exports.App) as
          | ((props?: Record<string, unknown>) => ElementNode)
          | undefined
        if (typeof App !== 'function') {
          return {
            ok: false as const,
            code: 'missing-default-export',
            message: 'App must export a default React component.',
            html: '<main>Missing default export</main>',
          }
        }
        const beforeSnapshot = snapshot()
        const tree = App({})
        const html = renderToHtmlLocal(tree)
        const buttons = collectButtonsLocal(tree)
        const visibleButtons = buttons.filter((button) => !isHiddenButtonLocal(button))
        const controlResults = []
        for (const button of visibleButtons) {
          const before = snapshot()
          const callStart = calls.length
          let error: string | undefined
          const onClick = button.props.onClick
          try {
            if (typeof onClick === 'function') {
              const result = onClick({ preventDefault() {} })
              if (result && typeof (result as { then?: unknown }).then === 'function') await result
            }
          } catch (cause) {
            error = cause instanceof Error ? `${cause.name}:${cause.message}` : String(cause)
          }
          if (error?.includes('sandbox-violation')) {
            return {
              ok: false as const,
              code: 'sandbox-violation',
              message: error,
              html,
            }
          }
          controlResults.push({
            label: textContent(button).replace(/\s+/g, ' ').trim(),
            sdkCalls: calls.slice(callStart),
            beforeSnapshot: before,
            afterSnapshot: snapshot(),
            ...(error === undefined ? {} : { error }),
          })
        }
        return {
          ok: true as const,
          html,
          text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
          buttonCount: visibleButtons.length,
          hiddenButtonCount: buttons.length - visibleButtons.length,
          sdkCalls: calls,
          beforeSnapshot,
          afterSnapshot: snapshot(),
          controlResults,
        }
      },
      {
        outputText: compiled.outputText,
        seed: input.seed ?? {},
        manifest: input.manifest ?? {},
      },
    )
    const timeout = new Promise<RuntimeResult>((resolve) => {
      setTimeout(() => {
        timedOut = true
        void browser?.close().catch(() => undefined)
        resolve({
          ok: false,
          code: 'sandbox-timeout',
          message: 'App test exceeded the sandbox execution timeout.',
          html: '<main>Sandbox timeout</main>',
        })
      }, 2000)
    })
    return await Promise.race([execute, timeout])
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'App failed during runtime execution.'
    const sandbox = /sandbox-violation/.test(message)
    return {
      ok: false,
      code: sandbox ? 'sandbox-violation' : timedOut ? 'sandbox-timeout' : 'runtime-error',
      message,
      html: `<main>${escapeHtml(message || 'Runtime error')}</main>`,
    }
  } finally {
    if (!timedOut) await browser?.close().catch(() => undefined)
  }
}

function checkCompile(code: string): AppTestCheck {
  if (/@dohc\/view/.test(code) || /\.views\//.test(code)) {
    return {
      name: 'compile',
      status: 'failed',
      code: 'legacy-view-import',
      message: 'App must use .apps and @dohc/app, not legacy view APIs.',
    }
  }
  if (!/@dohc\/app/.test(code)) {
    return {
      name: 'compile',
      status: 'failed',
      code: 'missing-app-sdk',
      message: 'App must import @dohc/app.',
    }
  }
  const compiled = ts.transpileModule(code, {
    fileName: 'App.tsx',
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  })
  const diagnostic = compiled.diagnostics?.find(
    (item) => item.category === ts.DiagnosticCategory.Error,
  )
  if (diagnostic) {
    return {
      name: 'compile',
      status: 'failed',
      code: 'compile-error',
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }
  }
  return { name: 'compile', status: 'ok' }
}

function checkRender(runtime: RuntimeResult): AppTestCheck {
  if (!runtime.ok) {
    return {
      name: 'browser render',
      status: 'failed',
      code: runtime.code,
      message: runtime.message,
    }
  }
  if (runtime.hiddenButtonCount > 0) {
    return {
      name: 'browser render',
      status: 'failed',
      code: 'fake-primary-button',
      message: 'Primary controls must be visible and testable.',
    }
  }
  if (!runtime.html.trim() || !runtime.text.trim()) {
    return {
      name: 'browser render',
      status: 'failed',
      code: 'blank-render',
      message: 'App rendered a blank primary view.',
    }
  }
  return { name: 'browser render', status: 'ok' }
}

function checkSourceBackedData(runtime: RuntimeResult, seed: AppTestSeed | undefined): AppTestCheck {
  if (runtime.ok && hasRealRows(seed) && /(?:^|\s)\$0\b|\b0\s+(?:total|spend|rows|items)\b|No data|--/i.test(runtime.text)) {
    return {
      name: 'source-backed data',
      status: 'failed',
      code: 'placeholder-metric',
      message: 'Source data exists, but the app renders placeholder metrics instead of reading data.',
    }
  }
  if (runtime.ok && hasRealRows(seed) && !runtime.text.trim()) {
    return {
      name: 'source-backed data',
      status: 'failed',
      code: 'missing-source-read',
      message: 'Source data exists, but the app does not read collections, docs, or databases.',
    }
  }
  return { name: 'source-backed data', status: 'ok' }
}

function checkMutationPersistence(runtime: RuntimeResult, code: string): AppTestCheck {
  if (!runtime.ok) return { name: 'mutation persistence', status: 'ok' }
  if (runtime.buttonCount === 0 && runtime.hiddenButtonCount === 0) {
    return { name: 'mutation persistence', status: 'ok' }
  }
  const persistentControls = runtime.controlResults.filter((control) =>
    mutatingCalls(control.sdkCalls).length > 0 &&
    stableJson(control.beforeSnapshot) !== stableJson(control.afterSnapshot),
  )
  if (runtime.controlResults.some((control) => /sqlite-sdk-path-required/.test(control.error ?? ''))) {
    return {
      name: 'mutation persistence',
      status: 'failed',
      code: 'sqlite-sdk-path-required',
      message: 'SQLite-backed controls must write through dohc.database(path).table(name).',
    }
  }
  if (persistentControls.length === runtime.controlResults.length && runtime.controlResults.length > 0) {
    return { name: 'mutation persistence', status: 'ok' }
  }
  if (persistentControls.length > 0) {
    return {
      name: 'mutation persistence',
      status: 'failed',
      code: 'control-missing-persistence',
      message: 'Every visible primary control must cause a persistent dohc SDK write and state change.',
    }
  }
  if (/set[A-Z]\w*\s*\(/.test(code) || /useState\s*\(/.test(code)) {
    return {
      name: 'mutation persistence',
      status: 'failed',
      code: 'fake-primary-button',
      message: 'Primary controls appear to update local React state without a persistent dohc SDK write.',
    }
  }
  return {
    name: 'mutation persistence',
    status: 'failed',
    code: 'missing-persistence',
    message: 'Primary controls must call dohc.collection, dohc.doc, or dohc.database writes.',
  }
}

async function screenshotArtifact(html: string, reason: string) {
  try {
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 480 } })
      await page.setContent(`<!doctype html><html><body>${html || '<main></main>'}</body></html>`)
      const bytes = await page.screenshot({ type: 'png' })
      return {
        name: 'browser-render',
        mimeType: 'image/png' as const,
        dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
        reason,
      }
    } finally {
      await browser.close()
    }
  } catch {
    return {
      name: 'browser-render',
      mimeType: 'image/png' as const,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAAD8fJRsAAAAFElEQVR42mP8z8AARLJgYGBgAAAQAAH+QOCY6QAAAABJRU5ErkJggg==',
      reason,
    }
  }
}

function checkManifestTests(
  runtime: RuntimeResult,
  manifest: RunAppTestInput['manifest'],
  packageRoot: string,
): AppTestCheck {
  if (!runtime.ok) return { name: 'manifest tests', status: 'ok' }
  if (manifest?.tests === undefined) return { name: 'manifest tests', status: 'ok' }
  if (!Array.isArray(manifest.tests)) {
    return {
      name: 'manifest tests',
      status: 'failed',
      code: 'manifest-test-invalid',
      message: 'App manifest tests must be an array of enforceable workflow tests.',
    }
  }
  for (const rawTest of manifest.tests) {
    const test = manifestRecord(rawTest)
    const name = manifestString(test?.name)
    if (!test || !name) {
      return {
        name: 'manifest tests',
        status: 'failed',
        code: 'manifest-test-invalid',
        message: 'Each app manifest test must include a workflow name.',
      }
    }
    const matchingControls = runtime.controlResults.filter((control) =>
      controlMatchesManifestTest(control.label, name),
    )
    if (matchingControls.length === 0) {
      return {
        name: 'manifest tests',
        status: 'failed',
        code: 'manifest-test-missing-control',
        message: `Manifest test "${name}" does not have a matching visible control.`,
      }
    }
    const passed = matchingControls.some((control) =>
      stateChanged(control) &&
        mutatingCalls(control.sdkCalls).some((call) =>
          callMatchesManifestTarget(call, test, manifest, packageRoot),
        ),
    )
    if (!passed) {
      return {
        name: 'manifest tests',
        status: 'failed',
        code: 'manifest-test-missing-persistence',
        message: `Manifest test "${name}" did not perform the required persistent SDK write.`,
      }
    }
  }
  return { name: 'manifest tests', status: 'ok' }
}

export async function runAppTest(input: RunAppTestInput): Promise<RunAppTestResult> {
  const code = source(input)
  const compileCheck = checkCompile(code)
  const runtime = compileCheck.status === 'ok'
    ? await runRenderedApp(input, code)
    : ({
        ok: false,
        code: compileCheck.code ?? 'compile-error',
        message: compileCheck.message ?? 'Compilation failed.',
        html: '<main>Compilation failed</main>',
      } satisfies RuntimeResult)
  const checks = [
    compileCheck,
    checkRender(runtime),
    checkSourceBackedData(runtime, input.seed),
    checkMutationPersistence(runtime, code),
    checkManifestTests(runtime, input.manifest, input.packageRoot),
  ]
  const failures = checks.filter((check) => check.status === 'failed')
  const renderFailure = failures.find((check) => check.name === 'browser render')
  const artifacts = renderFailure && input.mode !== 'static'
    ? { screenshots: [await screenshotArtifact(runtime.html, renderFailure.code ?? 'browser-render-failed')] }
    : undefined
  return {
    ok: failures.length === 0,
    packageRoot: input.packageRoot,
    checks,
    failures,
    ...(artifacts === undefined ? {} : { artifacts }),
  }
}
