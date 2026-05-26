import { expect, test } from '@playwright/test'

test('playground editor is editable and keeps the Notion-style affordances', async ({
  page,
}) => {
  await page.goto('/playground')

  await expect(page.getByLabel('Page title')).toHaveValue('Tiptap')
  await expect(page.getByRole('button', { name: /add property/i })).toBeVisible()

  const editor = page.locator('.ProseMirror').first()
  await expect(editor).toBeVisible()
  await expect(editor).toBeEditable()
  await expect(page.locator('.ascii-sketch-block')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('live data')
  await expect(page.locator('body')).not.toContainText('Something went wrong')

  await page
    .getByText('A final paragraph gives slash commands a plain-text place to start.')
    .click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/table')

  await expect(page.getByRole('listbox', { name: 'slash commands' })).toBeVisible()
  await page.getByRole('option', { name: /table/i }).click()

  await expect(page.locator('.dohc-tiptap-editor table')).toBeVisible()
})

test('playground query blocks do not call authenticated live resolvers', async ({
  page,
}) => {
  await page.goto('/playground')

  await page
    .getByText('A final paragraph gives slash commands a plain-text place to start.')
    .click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/query')

  await page.getByRole('option', { name: /query block/i }).click()

  await expect(page.locator('.query-atom-caption')).toContainText(/query/i)
  await expect(page.locator('body')).not.toContainText('Something went wrong')
})
