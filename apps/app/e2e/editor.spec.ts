import { expect, test } from '@playwright/test'

type RgbColor = {
  b: number
  g: number
  r: number
}

function parseRgbColor(value: string): RgbColor {
  const match = value.match(
    /^rgba?\(\s*([.\d]+)\s*,\s*([.\d]+)\s*,\s*([.\d]+)(?:\s*,\s*([.\d]+)\s*)?\)$/,
  )
  if (!match || match[4] === '0') {
    throw new Error(`Expected an opaque rgb color, received "${value}"`)
  }

  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  }
}

function relativeLuminance({ b, g, r }: RgbColor): number {
  const toLinear = (channel: number) => {
    const normalized = channel / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(parseRgbColor(foreground))
  const backgroundLuminance = relativeLuminance(parseRgbColor(background))
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)

  return (lighter + 0.05) / (darker + 0.05)
}

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

test('playground block controls stay in a stable Notion-like gutter', async ({
  page,
}) => {
  async function firstLineControlOffset(
    block: ReturnType<typeof page.locator>,
    control: ReturnType<typeof page.locator>,
  ) {
    const box = await block.boundingBox()
    const controlBox = await control.boundingBox()
    const metrics = await block.evaluate((node) => {
      const lineSource = node.querySelector('code') ?? node
      const blockRect = node.getBoundingClientRect()
      const lineRect = lineSource.getBoundingClientRect()
      const style = getComputedStyle(lineSource)
      return {
        firstLineTop:
          lineRect.top -
          blockRect.top +
          Number.parseFloat(style.paddingTop || '0'),
        lineHeight: Number.parseFloat(style.lineHeight),
      }
    })
    if (!box || !controlBox) {
      throw new Error('Expected block controls to have layout boxes')
    }

    return Math.abs(
      controlBox.y +
        controlBox.height / 2 -
        (box.y + metrics.firstLineTop + metrics.lineHeight / 2),
    )
  }

  await page.goto('/playground')

  const paragraph = page
    .locator('.dohc-block-node')
    .filter({ hasText: 'This is editable text in the page body.' })
    .first()
  const sketch = page.locator('.ascii-sketch-block').first()
  await expect(paragraph).toBeVisible()
  await expect(sketch).toBeVisible()

  const paragraphPlus = paragraph.getByRole('button', { name: 'insert block' })
  const paragraphHandle = paragraph.getByRole('button', {
    name: 'select block',
  })
  const sketchPlus = sketch.getByRole('button', { name: 'insert block' })

  await paragraph.hover()
  await expect(paragraphPlus).toBeVisible()
  await expect(paragraphHandle).toBeVisible()
  await expect(paragraphPlus).toHaveCSS('opacity', '1')
  await expect(paragraphHandle).toHaveCSS('opacity', '1')

  const paragraphBox = await paragraph.boundingBox()
  const paragraphPlusBox = await paragraphPlus.boundingBox()
  const paragraphHandleBox = await paragraphHandle.boundingBox()
  if (!paragraphBox || !paragraphPlusBox || !paragraphHandleBox) {
    throw new Error('Expected paragraph block controls to have layout boxes')
  }

  expect(paragraphPlusBox.x).toBeLessThan(paragraphBox.x)
  expect(paragraphHandleBox.x).toBeGreaterThan(paragraphPlusBox.x)
  expect(await firstLineControlOffset(paragraph, paragraphPlus)).toBeLessThanOrEqual(2)
  expect(Math.abs(paragraphPlusBox.y - paragraphHandleBox.y)).toBeLessThanOrEqual(
    1,
  )

  await sketch.hover()
  await expect(sketchPlus).toBeVisible()
  await expect(sketchPlus).toHaveCSS('opacity', '1')

  const sketchPlusBox = await sketchPlus.boundingBox()
  if (!sketchPlusBox) {
    throw new Error('Expected sketch block control to have a layout box')
  }

  expect(Math.abs(sketchPlusBox.x - paragraphPlusBox.x)).toBeLessThanOrEqual(2)
  expect(await firstLineControlOffset(sketch, sketchPlus)).toBeLessThanOrEqual(2)

  await page.mouse.move(0, 0)
  await expect(paragraphPlus).toHaveCSS('opacity', '0')
  await paragraphPlus.focus()
  await expect(paragraphPlus).toHaveCSS('opacity', '1')

  await page.setViewportSize({ width: 390, height: 844 })
  const wrappedParagraph = page
    .locator('.dohc-block-node')
    .filter({ hasText: 'This is editable text in the page body.' })
    .first()
  const wrappedPlus = wrappedParagraph.getByRole('button', {
    name: 'insert block',
  })
  await wrappedParagraph.hover()
  await expect(wrappedPlus).toHaveCSS('opacity', '1')

  const wrappedBox = await wrappedParagraph.boundingBox()
  const wrappedPlusBox = await wrappedPlus.boundingBox()
  if (!wrappedBox || !wrappedPlusBox) {
    throw new Error('Expected wrapped paragraph controls to have layout boxes')
  }

  expect(wrappedBox.height).toBeGreaterThan(paragraphBox.height)
  expect(wrappedPlusBox.x).toBeGreaterThanOrEqual(0)
  expect(await firstLineControlOffset(wrappedParagraph, wrappedPlus)).toBeLessThanOrEqual(
    2,
  )

  await page.mouse.move(
    wrappedBox.x - 12,
    wrappedPlusBox.y + wrappedPlusBox.height / 2,
  )
  await expect(wrappedPlus).toHaveCSS('opacity', '1')
})

test('playground markdown shortcuts create visible lists and smooth headings', async ({
  page,
}) => {
  async function placeCursorInFreshBlock() {
    await page.goto('/playground')
    await expect(
      page.getByText(
        'A final paragraph gives slash commands a plain-text place to start.',
      ),
    ).toBeVisible()
    await page.evaluate(() => {
      const editor = document.querySelector('.ProseMirror')
      const paragraph = [...document.querySelectorAll('.ProseMirror p')].find(
        (node) =>
          node.textContent?.includes(
            'A final paragraph gives slash commands a plain-text place to start.',
          ),
      )
      if (!editor || !paragraph) {
        throw new Error('Expected playground paragraph to place the cursor')
      }

      const walker = document.createTreeWalker(
        paragraph,
        NodeFilter.SHOW_TEXT,
      )
      let text: Text | null = null
      let next = walker.nextNode()
      while (next) {
        text = next as Text
        next = walker.nextNode()
      }
      if (!text) throw new Error('Expected paragraph text node')

      const range = document.createRange()
      range.setStart(text, text.data.length)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      ;(editor as HTMLElement).focus()
    })
    await page.keyboard.press('Enter')
  }

  await placeCursorInFreshBlock()
  await page.keyboard.type('- bullet item')

  const bulletList = page.locator('.dohc-tiptap-editor ul').last()
  await expect(bulletList.locator('li')).toContainText('bullet item')
  const bulletStyles = await bulletList.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      marker: style.listStyleType,
      padding: Number.parseFloat(style.paddingInlineStart),
    }
  })
  expect(bulletStyles.marker).toBe('disc')
  expect(bulletStyles.padding).toBeGreaterThanOrEqual(20)

  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('after bullet')
  const afterBullet = page.locator('.dohc-tiptap-editor p', {
    hasText: 'after bullet',
  })
  await expect(afterBullet).toBeVisible()
  await expect(bulletList.locator('li')).toHaveCount(1)

  await placeCursorInFreshBlock()
  await page.keyboard.type('1. ordered item')

  const orderedList = page.locator('.dohc-tiptap-editor ol').last()
  await expect(orderedList.locator('li')).toContainText('ordered item')
  const orderedStyles = await orderedList.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      marker: style.listStyleType,
      padding: Number.parseFloat(style.paddingInlineStart),
    }
  })
  expect(orderedStyles.marker).toBe('decimal')
  expect(orderedStyles.padding).toBeGreaterThanOrEqual(20)

  await placeCursorInFreshBlock()
  await page.keyboard.type('## Roadmap')

  const heading = page.locator('.dohc-tiptap-editor h2', {
    hasText: 'Roadmap',
  })
  await expect(heading).toBeVisible()
  const headingPaddingTop = await heading.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).paddingTop),
  )
  expect(headingPaddingTop).toBeLessThanOrEqual(16)

  await page.keyboard.press('Enter')
  await page.keyboard.type('body text')
  const bodyParagraph = page.locator('.dohc-tiptap-editor p', {
    hasText: 'body text',
  })
  await expect(bodyParagraph).toBeVisible()
})

test('playground code blocks expose a language syntax dropdown', async ({
  page,
}) => {
  await page.goto('/playground')

  await page
    .getByText('A final paragraph gives slash commands a plain-text place to start.')
    .waitFor()
  await page.evaluate(() => {
    const editor = document.querySelector('.ProseMirror')
    const paragraph = [...document.querySelectorAll('.ProseMirror p')].find(
      (node) =>
        node.textContent?.includes(
          'A final paragraph gives slash commands a plain-text place to start.',
        ),
    )
    if (!editor || !paragraph) {
      throw new Error('Expected playground paragraph to place the cursor')
    }
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let text: Text | null = null
    let next = walker.nextNode()
    while (next) {
      text = next as Text
      next = walker.nextNode()
    }
    if (!text) throw new Error('Expected paragraph text node')

    const range = document.createRange()
    range.setStart(text, text.data.length)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    ;(editor as HTMLElement).focus()
  })
  await page.keyboard.press('Enter')
  await page.keyboard.type('/code')
  await page.getByRole('option', { name: /code block/i }).click()

  const languageSelect = page.getByRole('combobox', { name: 'code language' })
  const toolbar = page.locator('.dohc-code-block-toolbar').last()
  await expect(toolbar).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'copy code' })).toBeVisible()
  await expect(languageSelect).toBeVisible()
  await expect(languageSelect).toContainText('TypeScript')

  const languageSelectColors = await languageSelect.evaluate((node) => {
    const selectStyle = getComputedStyle(node)
    const option = (node as HTMLSelectElement).querySelector('option')
    if (!option) {
      throw new Error('Expected code language select to render menu options')
    }

    const optionStyle = getComputedStyle(option)

    return {
      optionBackground: optionStyle.backgroundColor,
      optionColor: optionStyle.color,
      selectBackground: selectStyle.backgroundColor,
      selectColor: selectStyle.color,
    }
  })
  expect(
    contrastRatio(
      languageSelectColors.selectColor,
      languageSelectColors.selectBackground,
    ),
  ).toBeGreaterThanOrEqual(4.5)
  expect(
    contrastRatio(
      languageSelectColors.optionColor,
      languageSelectColors.optionBackground,
    ),
  ).toBeGreaterThanOrEqual(4.5)

  await languageSelect.selectOption('typescript')

  await expect(
    page.locator('.dohc-tiptap-editor pre code.language-typescript'),
  ).toBeVisible()

  await page.locator('.dohc-tiptap-editor pre').last().click()
  await page.keyboard.type('const answer = 42')
  await expect(page.locator('.dohc-tiptap-editor pre code').last()).toContainText(
    'const answer = 42',
  )
  await expect(
    page.locator('.dohc-tiptap-editor pre code .hljs-keyword').last(),
  ).toContainText('const')

  const toolbarBox = await toolbar.boundingBox()
  const codeBox = await page.locator('.dohc-tiptap-editor pre').last().boundingBox()
  if (!toolbarBox || !codeBox) {
    throw new Error('Expected code toolbar and code body to have layout boxes')
  }
  expect(Math.abs(toolbarBox.x - codeBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(toolbarBox.width - codeBox.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(toolbarBox.y + toolbarBox.height - codeBox.y)).toBeLessThanOrEqual(
    1,
  )

  const continueButton = page
    .getByRole('button', { name: 'add paragraph below code block' })
    .last()
  await expect(continueButton).toBeVisible()
  await continueButton.click()
  await page.keyboard.type('Back to normal text')

  const continuation = page.locator('.dohc-tiptap-editor p', {
    hasText: 'Back to normal text',
  })
  await expect(continuation).toBeVisible()
  const continuationPosition = await continuation.evaluate((node) => {
    let previous = node.previousElementSibling
    while (previous?.classList.contains('dohc-code-block-continuation')) {
      previous = previous.previousElementSibling
    }
    return {
      previousClass: previous?.className,
      previousTag: previous?.tagName,
    }
  })
  expect(continuationPosition.previousTag).toBe('PRE')
  expect(String(continuationPosition.previousClass)).toContain('dohc-code-block')
})

test('playground adjacent code blocks keep clean block chrome', async ({
  page,
}) => {
  await page.goto('/playground')

  await page
    .getByText('A final paragraph gives slash commands a plain-text place to start.')
    .click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/code')
  await page.getByRole('option', { name: /code block/i }).click()

  await page
    .getByRole('button', { name: 'add paragraph below code block' })
    .last()
    .click()
  await page.keyboard.type('/code')
  await page.getByRole('option', { name: /code block/i }).click()

  const codeBlocks = page.locator('.dohc-tiptap-editor pre.dohc-code-block')
  await expect(codeBlocks).toHaveCount(2)
  await expect(
    page.getByRole('button', { name: 'add paragraph below code block' }),
  ).toHaveCount(1)

  const secondToolbarLayout = await page
    .locator('.dohc-code-block-toolbar')
    .nth(1)
    .evaluate((toolbar) => {
      const previous = toolbar.previousElementSibling
      const toolbarBox = toolbar.getBoundingClientRect()
      const previousBox = previous?.getBoundingClientRect()
      return {
        gap: previousBox ? toolbarBox.top - previousBox.bottom : null,
        previousClass: previous?.className,
        previousTag: previous?.tagName,
      }
    })
  expect(secondToolbarLayout.previousTag).toBe('PRE')
  expect(String(secondToolbarLayout.previousClass)).toContain('dohc-code-block')
  expect(secondToolbarLayout.gap).not.toBeNull()
  expect(secondToolbarLayout.gap ?? 0).toBeLessThanOrEqual(18)
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
