import { Marked } from 'marked'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'

const reader = new Marked()

// CommonMark strips a paragraph's and a heading's final whitespace, but marked
// keeps it at the end of a note, where dohc's save trims it.
function rendered(markdown: string): string {
  return (reader.parse(markdown, { async: false }) as string)
    .replace(/\s+/gu, ' ')
    .replace(/ (<\/(?:p|h[1-6])>)/gu, '$1')
    .trim()
}

/** Whether marked, the desktop's reader, renders the two the same. */
export function sameMarkdownMeaning(left: string, right: string): boolean {
  return rendered(left) === rendered(right)
}

/**
 * Whether `markdown` is a lossy note: one whose meaning would change if dohc
 * wrote it back from its editor document.
 *
 * A note dohc wrote is its own canonical Markdown, apart from the final
 * newline a save drops, so it skips the render. A note the editor cannot
 * import at all is lossy too.
 */
export function isLossyMarkdown(markdown: string): boolean {
  let canonical: string
  try {
    const doc = markdownToYDoc(markdown)
    try {
      canonical = yDocToMarkdown(doc)
    } finally {
      doc.destroy()
    }
  } catch {
    return true
  }
  if (canonical === markdown.replace(/\r?\n$/u, '')) return false
  return !sameMarkdownMeaning(markdown, canonical)
}
