import { Marked } from 'marked'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'

const reader = new Marked()

function rendered(markdown: string): string {
  return (reader.parse(markdown, { async: false }) as string).replace(/\s+/gu, ' ').trim()
}

/**
 * Whether `markdown` is a lossy note: one whose meaning would change if dohc
 * wrote it back from its editor document. marked renders the file and dohc's
 * canonical Markdown of it, and any difference in the HTML counts.
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
  return rendered(markdown) !== rendered(canonical)
}
