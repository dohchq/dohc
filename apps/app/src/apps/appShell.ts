export const APP_SHELL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function buildAppShell({
  title,
  script = '',
}: {
  title: string
  script?: string
}): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(APP_SHELL_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: light;
  --paper: #fbfaf6;
  --graphite: #191815;
  --muted: #706a60;
  --rule: #dfd8ca;
}
html, body, #root {
  min-height: 100%;
  margin: 0;
}
body {
  background: var(--paper);
  color: var(--graphite);
  font: 14px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, input, textarea, select {
  font: inherit;
}
* {
  box-sizing: border-box;
}
</style>
</head>
<body>
<div id="root"></div>
<script>
(() => {
  let seq = 0
  let frameCalls = 0
  let frameScheduled = false
  const pending = new Map()
  window.addEventListener('message', (event) => {
    if (event.source !== parent) return
    const data = event.data
    if (!data || typeof data !== 'object' || typeof data.id !== 'string') return
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.ok) entry.resolve(data.value)
    else entry.reject(new Error(data.error?.message || 'App request failed.'))
  })
  function request(op, args = {}) {
    frameCalls += 1
    if (!frameScheduled) {
      frameScheduled = true
      requestAnimationFrame(() => {
        frameCalls = 0
        frameScheduled = false
      })
    }
    if (frameCalls === 51) {
      console.warn('dohc app made more than 50 SDK calls in one frame; batch with fields.query or sources.list.')
    }
    const id = String(++seq)
    parent.postMessage({ id, op, args }, '*')
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
  }
  function actionArgs(nameOrArgs, input) {
    if (typeof nameOrArgs === 'string') {
      return input === undefined ? { name: nameOrArgs } : { name: nameOrArgs, input }
    }
    return nameOrArgs || {}
  }
  function compact(args) {
    const out = {}
    for (const key of Object.keys(args)) {
      if (args[key] !== undefined) out[key] = args[key]
    }
    return out
  }
  function quote(value) {
    return JSON.stringify(value)
  }
  function friendly(label, promise) {
    return promise.then((result) => {
      if (result && typeof result === 'object' && result.ok === false) {
        throw new Error(label + ' failed: ' + (result.message || result.error?.message || 'Request failed.'))
      }
      return result
    })
  }
  function rowsResult(result) {
    if (result && typeof result === 'object' && Array.isArray(result.rows)) return result.rows
    return result
  }
  function rowResult(result) {
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'row')) return result.row
    return result
  }
  function collectionApi(name, database) {
    const base = database === undefined ? { name } : { name, database }
    const label = database === undefined
      ? 'dohc.collection(' + quote(name) + ')'
      : 'dohc.database(' + quote(database) + ').table(' + quote(name) + ')'
    return {
      list: (query) => friendly(label + '.list', request('dohc.collection.list', compact({ ...base, query }))).then(rowsResult),
      get: (id) => friendly(label + '.get', request('dohc.collection.get', { ...base, id })).then(rowResult),
      insert: (record, options = {}) => friendly(label + '.insert', request('dohc.collection.insert', compact({ ...base, record, ...options }))),
      update: (id, patch, options = {}) => friendly(label + '.update', request('dohc.collection.update', compact({ ...base, id, patch, ...options }))),
      upsert: (id, record, options = {}) => friendly(label + '.upsert', request('dohc.collection.upsert', compact({ ...base, id, record, ...options }))),
      delete: (id, options = {}) => friendly(label + '.delete', request('dohc.collection.delete', compact({ ...base, id, ...options }))),
    }
  }
  function docApi(path) {
    const label = 'dohc.doc(' + quote(path) + ')'
    return {
      get: () => friendly(label + '.get', request('dohc.doc.get', { path })),
      set: (key, value) => friendly(label + '.set', request('dohc.doc.set', { path, key, value })),
      append: (markdown) => friendly(label + '.append', request('dohc.doc.append', { path, markdown })),
      replaceText: (args) => friendly(label + '.replaceText', request('dohc.doc.replaceText', compact({ path, ...args }))),
      section: (heading) => ({
        append: (markdown) => friendly(label + '.section(' + quote(heading) + ').append', request('dohc.doc.section.append', { path, heading, markdown })),
        replace: (markdown) => friendly(label + '.section(' + quote(heading) + ').replace', request('dohc.doc.section.replace', { path, heading, markdown })),
      }),
    }
  }
  function databaseApi(path) {
    const label = 'dohc.database(' + quote(path) + ')'
    return {
      tables: () => friendly(label + '.tables', request('dohc.database.tables', { path })),
      query: (sql, params) => friendly(label + '.query', request('dohc.database.query', compact({ path, sql, params }))),
      table: (name) => collectionApi(name, path),
    }
  }
  window.dohc = {
    collection: (name) => collectionApi(name),
    doc: (path) => docApi(path),
    database: (path) => databaseApi(path),
    asset: (assetId) => ({
      resolve: () => friendly('dohc.asset(' + quote(assetId) + ').resolve', request('dohc.asset.resolve', { assetId })),
    }),
    presence: { list: () => request('dohc.presence.list', {}) },
    sources: { list: (args = {}) => request('dohc.sources.list', args) },
    atom: { get: (args) => request('dohc.atom.get', args) },
    fields: { query: (args = {}) => request('dohc.fields.query', args) },
    imports: { list: () => request('dohc.imports.list', {}) },
    exports: { list: () => request('dohc.exports.list', {}) },
    source: { open: (args) => request('dohc.source.open', args) },
    agent: { run: (args) => request('dohc.agent.run', args) },
    actions: { run: (nameOrArgs, input) => request('dohc.actions.run', actionArgs(nameOrArgs, input)) },
    patch: { propose: (args) => request('dohc.patch.propose', args) },
  }
  function ready() {
    parent.postMessage({ type: 'dohc.ready' }, '*')
  }
  ready()
  setTimeout(ready, 0)
  setTimeout(ready, 100)
})()
</script>
<script>
${escapeScriptContent(script)}
</script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeScriptContent(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script')
}
