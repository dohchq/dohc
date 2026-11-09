import { MarkdownNestingRefusal } from './markdown-nesting-refusal.js'

// Admission is independent of canonical serialization. Code bodies are opaque;
// blank lines end lazy continuation, but not an indented continuation block.
// The editor's import and the desktop's read view both read list lines
// through this one scan, so they agree on which tabs it keeps as text.
export function assertSupportedListMarkdown(markdown: string, preserveContentTabs?: (text: string) => string): string {
  // Flat items beginning with ordinary text cannot introduce child blocks.
  if (!markdown.includes('\r') && /^(?:(?:[-+*]|[0-9]{1,9}[.)]) (?:\[[ xX]\] )?[A-Za-z][^\n\t]*(?:\n|$))+(?:\n[A-Za-z][^\n\t]*\n?)?$/u.test(markdown)) return markdown
  const parents: Array<{ indent: number; column: number; content?: number }> = []
  const lines = markdown.split('\n')
  let changed = false
  let blank = false
  let open: { indent: number; column: number } | undefined
  let fence = ''
  let fenceInList = false
  const protectTabs = (at: number, opaque = false) => {
    if (!preserveContentTabs || !lines[at].includes('\t')) return
    lines[at] = lines[at].replace(opaque ? /^([ \t]*)([^\n]*)$/u : /^([ \t]*(?:>[ \t]*)*(?:(?:[-+*][ \t]+(?:\[[ xX]\][ \t]+)?|[0-9]{1,9}[.)][ \t]+)(?:>[ \t]*)*)*)([^\n]*)$/u,
      (_match, prefix: string, text: string) => prefix + preserveContentTabs(text))
    changed = true
  }
  const refuse = () => { throw new Error('Markdown is not representable by the live document contract') }
  for (let at = 0; at < lines.length; at += 1) {
    let line = lines[at].replace(/\r$/u, '')
    if (line.includes('\t')) line = line.replace(/^[ \t]*(?:(?:[-+*]|[0-9]{1,9}[.)])[ \t]+)?/u, prefix => {
      let column = 0
      const continuation = parents.length > 0 && Array.from(prefix.match(/^[ \t]*/u)![0], character => character === '\t' ? 4 : 1).reduce((sum, width) => sum + width, 0) >= parents[0].column
      return Array.from(prefix, character => {
        const width = character === '\t' ? continuation ? 4 : 4 - column % 4 : 1
        column += width
        return character === '\t' ? ' '.repeat(width) : character
      }).join('')
    })
    if (line && !' \t>_-+*0123456789`~#'.includes(line[0])) {
      if (!fence) { if (open) { parents.pop(); open = undefined } if (blank) parents.length = 0; blank = false }
      if (parents.length || fenceInList && fence) protectTabs(at)
      continue
    }
    if (/^[ \t]*$/u.test(line)) { blank = true; continue }
    let indent = /^ */u.exec(line)![0].length
    let rest = line.slice(indent)
    let quotes = 0
    while (rest === '>' || rest.startsWith('> ')) { rest = rest.slice(2); quotes += 1 }
    const quoteIndent = /^ */u.exec(rest)![0].length
    indent += quoteIndent
    rest = rest.slice(quoteIndent)
    const run = /^(?:`{3,}|~{3,})/u.exec(rest)?.[0] ?? ''
    if (fence) {
      if (fenceInList) protectTabs(at, true)
      if (run[0] === fence[0] && run.length >= fence.length && rest.slice(run.length).trim() === '') fence = ''
      continue
    }
    const rule = indent <= 3 && /^(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/u.test(rest)
    let marker = rule ? null : /^(?:[-+*]|[0-9]{1,9}[.)])(?: |$)/u.exec(rest)
    if (marker && !marker[0].endsWith(' ') && at > 0 && !blank) marker = null
    if (marker && indent >= 4 && indent >= (parents.at(-1)?.content ?? parents.at(-1)?.column ?? 0) + 4) marker = null
    const emptyEnded = !!open && blank
    if (emptyEnded && parents.some(parent => indent > parent.indent && indent < parent.column)) refuse()
    if (open && (blank || (!marker && indent < open.column))) {
      if (blank ? indent > open.indent && indent < open.column : rest.startsWith('\t')) refuse()
      parents.pop()
    }
    open = undefined
    if (marker) {
      while (parents.length && indent <= parents.at(-1)!.indent) parents.pop()
    } else if (blank || run || quotes || rule || /^#{1,6} /u.test(rest)) {
      while (parents.length && indent < parents.at(-1)!.column) parents.pop()
    }
    const inList = parents.length > 0
    if (quotes > 120) throw new MarkdownNestingRefusal('depth')
    if (run) { fence = run; fenceInList = inList; blank = false; continue }
    if (!inList && rule) { blank = false; continue }
    if ((inList || marker)
      && /^(?:\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/u.test(rest)) refuse()
    if (marker) {
      const itemBody = rest.slice(marker[0].length)
      let body = itemBody.replace(/^\[[ xX]\][ \t]+/u, '')
      let emptyChild: { indent: number; column: number } | undefined
      let quoted = false
      let depth = quotes + (parents.length + 1) * 2
      body = body.trimStart()
      while (true) {
        if (depth > 128) throw new MarkdownNestingRefusal('depth')
        if (body.startsWith('> ')) { body = body.slice(2); depth += 1; quoted = true; continue }
        const child = /^(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$)/u.exec(body)
        if (!child) break
        body = body.slice(child[0].length); depth += 2
        if (!quoted && !body.trim()) emptyChild = { indent: indent + rest.length - body.length - child[0].length, column: indent + rest.length - body.length + (/\s$/u.test(child[0]) ? 0 : 1) }
      }
      if (/^(?:\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/u.test(body)) refuse()
      const itemFence = /^(?:`{3,}|~{3,})/u.exec(body)?.[0] ?? ''
      if (itemFence) { fence = itemFence; fenceInList = true }
      if (parents.length && indent < parents.at(-1)!.column) refuse()
      const column = indent + marker[0].trimEnd().length + 1
      parents.push({ indent, column, content: column + (/^ {0,3}[^ ]/u.test(itemBody) ? /^ */u.exec(itemBody)![0].length : 0) })
      if (itemBody.trim() === '') open = parents.at(-1)
      if (emptyChild) { parents.push(emptyChild); open = emptyChild }
      if (itemBody === '') { lines[at] = lines[at].trimEnd(); changed = true }
    }
    if (parents.length) protectTabs(at)
    blank = false
  }
  if (fence.startsWith('~') && fenceInList) refuse()
  return changed ? lines.join('\n') : markdown
}
