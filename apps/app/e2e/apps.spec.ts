import { expect, test } from '@playwright/test'
import { buildAppShell } from '../src/apps/appShell'

const financeTrackerSmokeScript = `
  const root = document.getElementById('root')
  const money = (value) => '₱' + Number(value).toLocaleString('en-US')
  function setError(message) {
    const alert = document.getElementById('app-error')
    if (alert) alert.textContent = message
  }
  async function refresh() {
    try {
      const rows = await window.dohc.collection('transactions').list()
      const total = rows.reduce((sum, row) => sum + Number(row.Amount || 0), 0)
      root.innerHTML = '<main>' +
        '<h1>Finance Tracker</h1>' +
        '<p data-testid="total">' + money(total) + ' tracked</p>' +
        '<p id="app-error" role="alert"></p>' +
        '<ul>' + rows.map((row) =>
          '<li data-id="' + row.id + '">' +
          row.Merchant + ' ' + money(row.Amount) + ' ' + row.Category + ' reviewed:' + row.Reviewed +
          '</li>'
        ).join('') + '</ul>' +
        '<button id="add">Add expense</button>' +
        '<button id="categorize">Categorize Grab</button>' +
        '<button id="review">Mark reviewed</button>' +
        '<button id="source">Open source</button>' +
        '</main>'
      document.getElementById('add').addEventListener('click', () => run(() =>
        window.dohc.collection('transactions').insert({
          id: 'txn_003',
          Merchant: 'Bookstore',
          Amount: 900,
          Category: 'Learning',
          Reviewed: 'No',
        })
      ))
      document.getElementById('categorize').addEventListener('click', () => run(() =>
        window.dohc.collection('transactions').update('txn_001', { Category: 'Transport' })
      ))
      document.getElementById('review').addEventListener('click', () => run(() =>
        window.dohc.collection('transactions').update('txn_001', { Reviewed: 'Yes' })
      ))
      document.getElementById('source').addEventListener('click', () => run(() =>
        window.dohc.source.open({ path: 'finance/transactions/2026-06.md' })
      ))
    } catch (error) {
      root.innerHTML = '<main><h1>Finance Tracker</h1><p role="alert">Denied: ' +
        String(error && error.message ? error.message : error) +
        '</p></main>'
    }
  }
  async function run(action) {
    try {
      await action()
      await refresh()
    } catch (error) {
      setError(String(error && error.message ? error.message : error))
    }
  }
  refresh()
`

test('app runtime finance smoke persists actions across reloads and collaboration boundaries', async ({
  page,
}) => {
  const srcDoc = buildAppShell({
    title: 'Finance Tracker',
    script: financeTrackerSmokeScript,
  })

  await page.setContent(`
    <iframe id="app" sandbox="allow-scripts" title="Finance Tracker"></iframe>
    <script>
      window.__mode = 'permitted'
      window.__openedSource = null
      window.__transactions = [
        { id: 'txn_001', Merchant: 'Grab', Amount: 420, Category: 'Uncategorized', Reviewed: 'No' },
        { id: 'txn_002', Merchant: 'Cafe', Amount: 250, Category: 'Food', Reviewed: 'Yes' },
      ]
      window.addEventListener('message', (event) => {
        const data = event.data
        if (!data || typeof data !== 'object' || !data.id) return
        const reply = (payload) => event.source.postMessage({ id: data.id, ...payload }, '*')
        const denied = (code, message) => reply({ ok: true, value: { ok: false, code, message } })
        if (window.__mode === 'denied' && data.op === 'dohc.collection.list') {
          denied('source-read-not-authorized', 'source read not authorized')
          return
        }
        if (data.op === 'dohc.collection.list') {
          reply({ ok: true, value: { ok: true, rows: window.__transactions } })
          return
        }
        if (data.op === 'dohc.collection.insert') {
          if (window.__mode === 'untrusted') {
            denied('app-trust-required', 'app trust required')
            return
          }
          window.__transactions.push(data.args.record)
          reply({ ok: true, value: { ok: true } })
          return
        }
        if (data.op === 'dohc.collection.update') {
          if (window.__mode === 'untrusted') {
            denied('app-trust-required', 'app trust required')
            return
          }
          window.__transactions = window.__transactions.map((row) =>
            row.id === data.args.id ? { ...row, ...data.args.patch } : row
          )
          reply({ ok: true, value: { ok: true } })
          return
        }
        if (data.op === 'dohc.source.open') {
          window.__openedSource = data.args.path
          reply({ ok: true, value: { ok: true } })
        }
      })
    </script>
  `)

  const attachApp = async (selector: string) => {
    await page.locator(selector).evaluate((node, html) => {
      ;(node as HTMLIFrameElement).srcdoc = html
    }, srcDoc)
  }

  await attachApp('#app')
  const app = page.frameLocator('#app')
  await expect(app.getByRole('heading', { name: 'Finance Tracker' })).toBeVisible()
  await expect(app.getByTestId('total')).toContainText('₱670 tracked')
  await expect(app.getByText('Grab ₱420 Uncategorized reviewed:No')).toBeVisible()

  await app.getByRole('button', { name: 'Add expense' }).click()
  await expect(app.getByText('Bookstore ₱900 Learning reviewed:No')).toBeVisible()
  await expect(app.getByTestId('total')).toContainText('₱1,570 tracked')

  await app.getByRole('button', { name: 'Categorize Grab' }).click()
  await expect(app.getByText('Grab ₱420 Transport reviewed:No')).toBeVisible()

  await app.getByRole('button', { name: 'Mark reviewed' }).click()
  await expect(app.getByText('Grab ₱420 Transport reviewed:Yes')).toBeVisible()

  await app.getByRole('button', { name: 'Open source' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__openedSource))
    .toBe('finance/transactions/2026-06.md')

  await attachApp('#app')
  await expect(app.getByText('Bookstore ₱900 Learning reviewed:No')).toBeVisible()
  await expect(app.getByText('Grab ₱420 Transport reviewed:Yes')).toBeVisible()

  await page.locator('body').evaluate((body) => {
    const frame = document.createElement('iframe')
    frame.id = 'collaborator'
    frame.title = 'Collaborator Finance Tracker'
    frame.setAttribute('sandbox', 'allow-scripts')
    body.append(frame)
  })
  await attachApp('#collaborator')
  const collaborator = page.frameLocator('#collaborator')
  await expect(collaborator.getByText('Bookstore ₱900 Learning reviewed:No')).toBeVisible()
  await expect(collaborator.getByText('Grab ₱420 Transport reviewed:Yes')).toBeVisible()

  await page.evaluate(() => {
    ;(window as any).__mode = 'denied'
  })
  await page.locator('body').evaluate((body) => {
    const frame = document.createElement('iframe')
    frame.id = 'denied'
    frame.title = 'Denied Finance Tracker'
    frame.setAttribute('sandbox', 'allow-scripts')
    body.append(frame)
  })
  await attachApp('#denied')
  const denied = page.frameLocator('#denied')
  await expect(denied.getByRole('alert')).toContainText('source read not authorized')
  await expect(denied.getByText('Bookstore')).toHaveCount(0)

  await page.evaluate(() => {
    ;(window as any).__mode = 'untrusted'
  })
  await page.locator('body').evaluate((body) => {
    const frame = document.createElement('iframe')
    frame.id = 'untrusted'
    frame.title = 'Untrusted Finance Tracker'
    frame.setAttribute('sandbox', 'allow-scripts')
    body.append(frame)
  })
  await attachApp('#untrusted')
  const untrusted = page.frameLocator('#untrusted')
  await expect(untrusted.getByText('Grab ₱420 Transport reviewed:Yes')).toBeVisible()
  await untrusted.getByRole('button', { name: 'Add expense' }).click()
  await expect(untrusted.getByRole('alert')).toContainText('app trust required')
})
