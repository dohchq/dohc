import { digest } from 'lib0/hash/sha256'
import { Marked } from 'marked'
import type * as Y from 'yjs'
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

const VERDICT_LIMIT = 256
const verdicts = new Map<string, boolean>()

/**
 * isLossyMarkdown, remembered in this thread by the caller's digest of the
 * same bytes, so checking unchanged text again is free.
 */
export function isLossyMarkdownCached(digest: string, markdown: string): boolean {
  let lossy = verdicts.get(digest)
  if (lossy === undefined) {
    lossy = isLossyMarkdown(markdown)
    if (verdicts.size >= VERDICT_LIMIT) verdicts.delete(verdicts.keys().next().value!)
    verdicts.set(digest, lossy)
  }
  return lossy
}

/** What an agent, the CLI or an automation is told when it changes a lossy note. */
export function lossyNoteRefusal(path: string): string {
  return `dohc can't change ${path} without also changing parts it can't show, such as raw HTML or reference links. Edit the file directly instead.`
}

const utf8 = new TextEncoder()
const sha256 = (text: string) => Array.from(digest(utf8.encode(text)), byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * Whether a live note's file is a lossy note. Its file holds the source a
 * current witness records, and the next write would change what that source
 * means. A note with no witness, or one an edit already changed, is not.
 * Neither is one dohc can't write at all; its write refuses on its own.
 */
export function isLossyDocument(doc: Y.Doc): boolean {
  const meta = doc.getMap('meta')
  const source = meta.get('dohcMarkdownSource')
  if (typeof source !== 'string') return false
  let canonical: string
  try {
    canonical = yDocToMarkdown(doc)
  } catch {
    return false
  }
  return meta.get('dohcMarkdownSourceProjectionSha256') === sha256(canonical)
    && !sameMarkdownMeaning(source, canonical)
}
