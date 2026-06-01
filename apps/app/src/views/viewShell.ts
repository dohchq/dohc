export const VIEW_SHELL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function buildViewShell({
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
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(VIEW_SHELL_CSP)}">
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
    const data = event.data
    if (!data || typeof data !== 'object' || typeof data.id !== 'string') return
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.ok) entry.resolve(data.value)
    else entry.reject(new Error(data.error?.message || 'View request failed.'))
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
      console.warn('dohc view made more than 50 SDK calls in one frame; batch with fields.query or sources.list.')
    }
    const id = String(++seq)
    parent.postMessage({ id, op, args }, '*')
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
  }
  window.dohc = {
    sources: { list: (args = {}) => request('dohc.sources.list', args) },
    atom: { get: (args) => request('dohc.atom.get', args) },
    fields: { query: (args = {}) => request('dohc.fields.query', args) },
    imports: { list: () => request('dohc.imports.list', {}) },
    exports: { list: () => request('dohc.exports.list', {}) },
    source: { open: (args) => request('dohc.source.open', args) },
    agent: { run: (args) => request('dohc.agent.run', args) },
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
${script}
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
