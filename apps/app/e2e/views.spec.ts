import { expect, test } from '@playwright/test'
import { buildViewShell } from '../src/views/viewShell'

test('view runtime iframe renders SDK-backed data and source actions', async ({
  page,
}) => {
  const srcDoc = buildViewShell({
    title: 'Overview',
    script: `
      async function main() {
        const fields = await window.dohc.fields.query({
          source: '.',
          keys: ['status', 'next_action'],
        })
        document.getElementById('root').innerHTML =
          '<main><h1>Overview</h1><p>' +
          fields.rows.map((row) => row.key + ': ' + row.value).join(' · ') +
          '</p><button id="open">Open source</button></main>'
        document.getElementById('open').addEventListener('click', () => {
          window.dohc.source.open({ path: 'tasks.md' })
        })
      }
      main()
    `,
  })

  await page.setContent(`
    <iframe id="view" sandbox="allow-scripts" title="Overview view"></iframe>
    <script>
      window.__openedSource = null
      window.addEventListener('message', (event) => {
        const data = event.data
        if (!data || typeof data !== 'object' || !data.id) return
        if (data.op === 'dohc.fields.query') {
          event.source.postMessage({
            id: data.id,
            ok: true,
            value: {
              ok: true,
              rows: [
                { kind: 'field', key: 'status', value: 'active' },
                { kind: 'field', key: 'next_action', value: 'send proposal' },
              ],
            },
          }, '*')
        }
        if (data.op === 'dohc.source.open') {
          window.__openedSource = data.args.path
          event.source.postMessage({ id: data.id, ok: true, value: { ok: true } }, '*')
        }
      })
    </script>
  `)
  await page.locator('#view').evaluate((node, html) => {
    ;(node as HTMLIFrameElement).srcdoc = html
  }, srcDoc)

  const frame = page.frameLocator('#view')
  await expect(frame.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(frame.getByText('status: active')).toBeVisible()
  await expect(frame.getByText('next_action: send proposal')).toBeVisible()

  await frame.getByRole('button', { name: 'Open source' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__openedSource))
    .toBe('tasks.md')
})
