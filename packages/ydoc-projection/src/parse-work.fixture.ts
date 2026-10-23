import { Lexer } from 'marked'

// The work `run` does in searches and copies, in characters: each regular
// expression attempt, each string search from where it starts to the end of
// its match, or to the end of the text when it finds none; each split,
// replacement and join of a whole text; and each key list it builds.
//
// One `exec` makes an attempt at each place from where it starts until one
// matches: only the first place for an anchored pattern. An attempt reads
// its match, and may read on past it, or past where it fails, in a
// repetition or a look-around. A pattern with no unbounded repetition and no
// back reference reads at most a constant number of characters at each
// attempt, so it counts one for each attempt and its match. Any other pattern
// counts what its reviewed model below says an attempt can read. A pattern
// with neither counts the rest of the text, and `by` names it as unmodelled.
//
// Each search for a reference, an escape, a link, a code span or a tag that
// marked masks also counts a copy of the text it masks, which marked's own
// masking loop makes.
const INLINE = Lexer.rules.inline.gfm
const BLOCK = Lexer.rules.block.gfm

/**
 * How far one attempt reads past where it starts, beyond its match and a
 * constant number of characters: as far as `reach` matches there, as far as
 * `fail` matches there when the attempt fails, and as far as `tail` matches
 * past the match when it matches. `rest` reads to the end of the text, from
 * its one attempt when anchored or from where the search starts. Only
 * an attempt where `start` matches reads more than a constant number.
 */
export type ReadModel = 'rest' | {
  reach?: RegExp | ((input: string, at: number) => number)
  fail?: RegExp
  tail?: RegExp
  start?: RegExp
}

const LINE = /[^\n]*/y
const TWO_LINES = /[^\n]*\n?[^\n]*/y
const THREE_LINES = /[^\n]*\n?[^\n]*\n?[^\n]*/y
// A list item's first line, from its marker.
const ITEM_LINE = / *(?:[-+*]|\d{1,9}[.)])[^\n]*/y
// A list item's line, then each following line a list marker may start, then
// one more.
const LIST_LINES = /(?:[-+*]|\d{1,9}[.)])[^\n]*(?:\n[-+*0-9][^\n]*)*\n?[^\n]*\n?/y
const SENTINEL = /\uE000DOHC_PARSE_\d*/y
// A link label: to its closing bracket, with each nested bracket, escape, and
// code span, which may run past a bracket to the next backtick.
const LABEL = String.raw`!?\[(?:\\[\s\S]?|\[(?:\\[\s\S]|[^\[\]\\])*\]|\`+[^\`]*\`*|[^\[\]\\\`])*(?:\[(?:\\[\s\S]?|[^\[\]\\])*)?`
const REFERENCE = new RegExp(String.raw`${LABEL}(?:\]\[?(?:\\[\s\S]?|[^\[\]\\])*\]?)?`, 'y')
const BLOCK_SKIP_LINK = /\[(?:[^\[\]`]|`+[^`]*`*)*(?:\]\((?:\\[\s\S]?|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*(?:\((?:\\[\s\S]?|[^\\()])*)?\)?)?/y
// Each delimiter run of a kind, and the text before it, that marked's
// right-delimiter rule reads from a place: a branch that reads text up to a
// run, or one that starts at a character and reads the run after it.
const runReach = (delimiter: string) => new RegExp(`[^${delimiter}]*${delimiter}*`, 'y')
// The branch only the start of the text can match reads to the third
// delimiter character.
const THREE_DELIMITERS = /[^_*]*[_*]{0,2}[^_*]*[_*]{0,2}[^_*]*[_*]{0,2}/y
const fromStart = (first: RegExp, rest?: RegExp) => (input: string, at: number) =>
  Math.max(at === 0 ? sticky(first, input, at) : 0, rest ? sticky(rest, input, at) : 0)
const afterFirstBranch = (rule: RegExp) => rule.source.slice(rule.source.indexOf('|') + 1)
// marked's dynamic list rules, for each indentation they allow.
const INDENTS = [0, 1, 2, 3]
const BULLETS = ['\\-', '\\+', '\\*', '\\d{1,9}\\.', '\\d{1,9}\\)']
// The importer's text rule without the email look-aheads, its paragraph rule
// without the table rows, and its search for a line that interrupts a
// paragraph: see `linearTextRule`, `paragraphRule` and `setextRule`.
const EMAIL_LOOKAHEAD = /\|(\[\^[^\]]*\])?\(\?=\[([^\]]*)\]\+@\)/g
const TEXT_PLAIN = INLINE.text.source.replace(EMAIL_LOOKAHEAD, '')
const TABLE_OWN = BLOCK.table.source.slice(1)
const TABLE_AT = BLOCK.paragraph.source.indexOf(TABLE_OWN)
const PARAGRAPH = BLOCK.paragraph.source.slice(0, TABLE_AT) + TABLE_OWN.slice(0, TABLE_OWN.indexOf(String.raw`(?:\n((?:(?! *\n|`))
  + String.raw`(?:\n|$)` + BLOCK.paragraph.source.slice(TABLE_AT + TABLE_OWN.length)
const SETEXT_RULE = /^\^\(\?!(.+)\)\(\(\?:\.\|\\n\(\?!\\s\*\?\\n\|\1\)\)\+\?\)\\n \{0,3\}\(=\+\|-\+\) \*\(\?:\\n\+\|\$\)$/
const INTERRUPT = new RegExp(String.raw`\n(?=\s*?\n|${SETEXT_RULE.exec(BLOCK.lheading.source)![1]})`, 'g')

const MODELS: Array<[ReadModel, Array<RegExp | string>]> = [
  // An attempt that matches reads its match and a constant more; one that
  // fails, a constant number.
  [{}, [BLOCK.heading, BLOCK.text, /^ */u]],
  // A run of the characters it repeats.
  [{ reach: /[ \t\n]*/y }, [BLOCK.newline]],
  [{ reach: / {0,3}[-_*\t ]*\n*/y }, [BLOCK.hr, ...INDENTS.map(n => `^ {0,${n}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`)]],
  [{ reach: /[-*_ \t]*/y }, [/^(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/u, /^(?:\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/u]],
  [{ reach: / {0,3}[-_*\t ]*/y }, [/^ {0,3}(?:>|#{1,6}(?:[ \t]|$)|(?:```|~~~)|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$|(?:\*[ \t]*){3,}$|<[a-zA-Z!/])/]],
  [{ reach: /[ \t]*/y }, [/^[ \t]*$/, /^[ \t]*$/u, /^[ \t]*\n/u, /^[ \t]*/u]],
  [{ reach: /[ \t|:-]*/y }, [/^[ \t|:]*-[ \t|:-]*$/, /^[ \t|:]*-[ \t|:-]*$/u]],
  [{ reach: /[ :-]*/y }, [/^ *-+: *$/, /^ *:-+: *$/, /^ *:-+ *$/]],
  [{ reach: / {0,3}\|? */y }, [/ {0,3}(?:\| *)?:?-/y]],
  [{ reach: / {0,3}(?:`*|~*)/y }, [/^ {0,3}(`{3,}|~{3,})/, /^(?:`{3,}|~{3,})/u, /^(?:`{3,}|~{3,})/]],
  [{ reach: /\s*/y }, [/^(\s+)(?:```)/]],
  [{ reach: /[`~]*/y }, [/^([`~]+|[^`~])/]],
  [{ reach: /\*+|_+/y }, [INLINE.emStrongLDelim]],
  [{ reach: /[A-Za-z ]*/y }, [/^[A-Za-z ]+$/u]],
  [{ reach: /&#\d*/y }, [/^&#(\d+);$/]],
  [{ reach: /(?:\[[ xX]\])?[ \t]*/y }, [/^\[[ xX]\] +\S/, /^\[[ xX]\] +/, /^\[[ xX]\][ \t]+/u, /^\[([ xX])\][ \t]*(?:\n|$)/u]],
  [{ reach: /[-+*.)0-9]*[ \t]*/y }, [/^(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$)/u]],
  [{ reach: /[ \t]*[-+*.)0-9]*[ \t]*/y }, [/^[ \t]*(?:(?:[-+*]|[0-9]{1,9}[.)])[ \t]+)?/u]],
  [{ reach: /\s*[-+*]?\s*(?:\[[ xX]\]?)?\s*/y }, [/^(\s*)[-+*]\s+\[([ xX])\]\s+/]],
  [{ reach: /<\/?\s*[\w-]*/y }, [/^<\/[\s]*[\w-]+/i, /^<[\s]*([\w-]+)(\s|>|\/|$)/i, /^<\/\s*([\w-]+)/]],
  [{ reach: /[\w.-]*/y }, [/[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/y]],
  [{ reach: SENTINEL }, [/\uE000DOHC_PARSE_\d+\uE001/uy, /^\uE000DOHC_PARSE_\d+\uE001/u]],
  [{ reach: /(?:<!-- dohc:table row-heights=[\d:,]*(?: -->[ \t]*\n*)?)?/y }, [/^<!-- dohc:table row-heights=(\d+:\d+(?:,\d+:\d+)*) -->[ \t]*(?:\n+|$)/u]],
  // A rule that reads within its first line, once the syntax that starts it
  // does. Each of dohc's that ends in `$` reads one line the importer split
  // from the rest, so its nested repetitions never backtrack.
  [{ reach: ITEM_LINE }, [
    BLOCK.list, /^[ ]*(?:[-+*]|[0-9]{1,9}[.)])(?: \[([ xX])\])? *\n/u, /^[ ]*[-+*] \[([ xX])\] *\n?$/u,
    ...INDENTS.map(n => `^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
    ...BULLETS.map(bullet => `^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  ]],
  [{ reach: / {0,3}<[^\n]*/y }, [/^<(.*)>$/, ...INDENTS.map(n => `^ {0,${n}}<(?:[a-z].*>|!--)`)]],
  [{ reach: /\[![^\n]*/y }, [/^\[!([^\]\n]+)\]([+-]?)[ \t]*(.*)$/]],
  [{ reach: LINE }, [
    /^([ \t]*)([^\n]*)$/u,
    /^([ \t]*(?:>[ \t]*)*(?:(?:[-+*][ \t]+(?:\[[ xX]\][ \t]+)?|[0-9]{1,9}[.)][ \t]+)(?:>[ \t]*)*)*)([^\n]*)$/u,
  ]],
  // A fence's opening line, then, once it opens, its match: a fence without
  // a closing one runs to the end.
  [{ fail: / {0,3}(?:`+[^`\n]*|~*)/y }, [BLOCK.fences]],
  // Indented lines, then the next line's indentation.
  [{ tail: /[ \t]*/y }, [BLOCK.code]],
  // Each line looks ahead at the next, whether a block interrupts it.
  [{ tail: TWO_LINES }, [BLOCK.blockquote]],
  // A table checks its first two lines, and each row the next line.
  [{ reach: TWO_LINES, tail: TWO_LINES }, [BLOCK.table]],
  // Each line looks ahead at the next two, whether they start a table.
  [{ tail: THREE_LINES }, [PARAGRAPH]],
  // An HTML block that fails reads its first line, or a closing tag's white
  // space and the line after it; one that matches, the blank lines that end
  // it. Each branch before the one that matches fails within its prefix.
  [{ fail: / {0,3}<\/?[\w-]*\s*[^\n]*/y, tail: /[ \t\n]*/y }, [BLOCK.html]],
  // dohc's flat lists read their items' lines, then a line or two past them.
  [{ reach: LIST_LINES }, [
    /^(?:(?:[-+*]|[0-9]{1,9}[.)]) (?:\[[ xX]\] )?[A-Za-z][^\n\t]*(?:\n|$))+(?:\n[A-Za-z][^\n\t]*\n?)?$/u,
    /^([-+*]) \[[ xX]\] [A-Za-z][^\n\t]*(?:\n\1 \[[ xX]\] [A-Za-z][^\n\t]*)*(?=\n\n[A-Za-z]|\n?$)/u,
    /^([-+*]) [A-Za-z][^\n\t]*(?:\n\1 [A-Za-z][^\n\t]*)*(?=\n\n[A-Za-z]|\n?$)/u,
    /^[0-9]{1,9}([.)]) [A-Za-z][^\n\t]*(?:\n[0-9]{1,9}\1 [A-Za-z][^\n\t]*)*(?=\n\n[A-Za-z]|\n?$)/u,
    /^(?:(?:[-+*]|[0-9]{1,9}[.)]) (?![ \t]*(?:\n|$))[^\n\[]+(?:\n|$))+(?:\n|$)(?![ \t\n0-9*+-])/u,
  ]],
  // A definition's label to the next bracket, its destination to white
  // space or `>`, and a title to its closing quote or parenthesis.
  [{ reach: new RegExp(String.raw` {0,3}\[(?:\\[\s\S]?|[^\[\]\\])*\]?:? *\n?[ \t]*(?:<[^>\n]*>?|\S*)\s*(?:"(?:\\"?|[^"\\])*"?|'[^']*'?|\([^()]*\)?)? *\n*`, 'y') }, [BLOCK.def]],
  // A setext heading reads up to its underline, or, without one, the rest.
  [{ fail: /[\s\S]*/y }, [BLOCK.lheading]],
  // A reference link's label, then its reference's.
  [{ reach: REFERENCE }, [INLINE.reflink]],
  [{ reach: /!?\[(?:\\[\s\S]?|[^\[\]\\])*\]?(?:\[\]?)?/y }, [INLINE.nolink]],
  // A link's label, its destination, and a title to its closing quote or
  // parenthesis.
  [{
    reach: new RegExp(String.raw`${LABEL}(?:\]\(\s*(?:<(?:\\[\s\S]?|[^\n<>\\])*>?|[^ \t\n\x00-\x1f]*)\s*(?:"(?:\\"?|[^"\\])*"?|'(?:\\'?|[^'\\])*'?|\((?:\\\)?|[^)\\])*\)?)?\s*\)?)?`, 'y'),
  }, [INLINE.link]],
  [{ reach: /<[^\s\x00-\x1f<>]*/y }, [INLINE.autolink]],
  // A comment, an instruction, a CDATA section or a declaration to its end,
  // a closing tag's name and white space, and an opening tag's attributes,
  // each quoted value to its closing quote.
  [{
    reach: /<(?:!--[\s\S]*?(?:-->|$)|!\[CDATA\[[\s\S]*?(?:\]\]>|$)|![a-zA-Z]+(?:\s[\s\S]*?(?:>|$))?|\?[\s\S]*?(?:\?>|$)|\/[a-zA-Z][\w:-]*\s*|[a-zA-Z][\w-]*(?:\s|[\w.:-]|=|"[^"]*"?|'[^']*'?|[^\s"'=<>`])*)?/y,
  }, [INLINE.tag]],
  // A code span reads to the run that closes it, or, without one, the rest.
  [{ fail: /`[\s\S]*/y }, [INLINE.code]],
  [{ reach: /[A-Za-z0-9._+-]*@?[\w.-]*/y }, [INLINE.url]],
  // marked's hard break looks ahead through the white space after it; the
  // importer's reads only its spaces.
  [{ reach: / *\\?\n?\s*/y }, [INLINE.br]],
  [{ reach: / */y }, [/( {2,}|\\)\n/y]],
  // The text rule looks ahead for a hard break's spaces where it stops.
  [{ tail: / */y }, [TEXT_PLAIN]],
  // An underline to its closing `++`, or, without one, the rest.
  [{ reach: /\+\+(?:[\s\S]+?\+\+|[\s\S]*)/y }, [/^(\+\+)([\s\S]+?)(\+\+)/]],
  // marked's right-delimiter rules, as the importer reads them too.
  [{ reach: fromStart(THREE_DELIMITERS, runReach('\\*')), start: /[^*]/gu }, [INLINE.emStrongRDelimAst]],
  [{ reach: runReach('\\*'), start: /[^*]/gu }, [afterFirstBranch(INLINE.emStrongRDelimAst)]],
  [{ reach: fromStart(THREE_DELIMITERS, runReach('_')), start: /[^_]/gu }, [INLINE.emStrongRDelimUnd]],
  [{ reach: runReach('_'), start: /[^_]/gu }, [afterFirstBranch(INLINE.emStrongRDelimUnd)]],
  [{ reach: fromStart(/[^~]*/y), start: /^/g }, [INLINE.delRDelim]],
  [{ reach: THREE_DELIMITERS }, [/[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/uy, /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/uy]],
  [{ reach: /[^~]*/y }, [/[^~]+(?=[^~])/uy]],
  // Searches whose attempts read more only where one of their characters
  // starts. marked's masks read a reference link's labels; and a link's
  // label and, after `](`, its destination to its closing parenthesis, a
  // code span to the next backtick, and a tag to its end.
  [{ reach: REFERENCE, start: /[![]/g }, [INLINE.reflinkSearch]],
  [{
    reach: (input, at) => sticky(input[at] === '[' ? BLOCK_SKIP_LINK : input[at] === '<' ? /<[^<>]*/y : /`+[^`]*`*/y, input, at),
    start: /[[`<]/g,
  }, [INLINE.blockSkip]],
  [{ reach: SENTINEL, start: /\uE000/g }, [/\uE000DOHC_PARSE_\d+\uE001/gu, /\uE000DOHC_PARSE_\d+\uE001|&(?:amp|lt|gt);/gu]],
  [{ reach: /&#?\d*/y, start: /&/g }, [/&(?:#(\d+)|(amp|lt|gt));/g]],
  [{ reach: /\| */y, start: /\|/g }, [/^\||\| *$/g]],
  [{ reach: /\s*/y, start: /\s/g }, [/\s+/g]],
  [{ reach: /\s*/y, start: /\n/g }, [/\n[^\S\n]*(?:\n[^\S\n]*)+$/]],
  [{ reach: /\n*/y, start: /\n/g }, [/\n+$/u]],
  [{ reach: /\n[ \t]*\n?[ \t]*/y, start: /\n/g }, [/\n[ \t]*$/, /\n[ \t]*\n$/u, /\n[ \t]*\n[ \t]*$/]],
  [{ reach: /\n {0,3}(?:=*|-*) */y, start: /\n/g }, [/\n {0,3}(?:=+|-+) *(?:\n|$)/g, /\n {0,3}((?:=+|-+) *)(?=\n|$)/g]],
  // Whether the next line can interrupt a paragraph.
  [{ reach: /\n[^\n]*\n?/y, start: /\n/g }, [INTERRUPT]],
  // marked's url rule trims its match with this one, which matches from the
  // start of the link and reads the rest for a parenthesis or an entity. The
  // others read marked's own rules' sources, which no note changes.
  ['rest', [INLINE._backpedal, EMAIL_LOOKAHEAD, /^\^\((?:\\.|[^)\\])*\)/, SETEXT_RULE]],
]
const READ_MODELS = new Map(MODELS.flatMap(([model, patterns]) =>
  patterns.map(pattern => [typeof pattern === 'string' ? pattern : pattern.source, model] as const)))
const MASKS = new Set([INLINE.anyPunctuation, INLINE.blockSkip, INLINE.reflinkSearch].map(rule => rule.source))

/** Each pattern's reviewed model, by its source. */
export const MODELLED: ReadonlyMap<string, ReadModel> = READ_MODELS
/** The importer's own versions of marked's rules, as the counter models them. */
export const IMPORTER_RULES = { paragraph: new RegExp(PARAGRAPH), interrupt: INTERRUPT, text: new RegExp(TEXT_PLAIN) }

const { exec } = RegExp.prototype
function sticky(pattern: RegExp, text: string, at: number): number {
  pattern.lastIndex = at
  return (Reflect.apply(exec, pattern, [text]) as RegExpExecArray | null)?.[0].length ?? 0
}

// The top-level alternatives of a pattern's source.
function alternatives(source: string): string[] {
  const found: string[] = []
  let depth = 0
  let from = 0
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at]
    if (character === '\\') at += 1
    else if (character === '[') {
      for (at += 1; at < source.length && source[at] !== ']'; at += 1) if (source[at] === '\\') at += 1
    } else if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === '|' && depth === 0) {
      found.push(source.slice(from, at))
      from = at + 1
    }
  }
  return [...found, source.slice(from)]
}

// Whether a pattern repeats anything without bound or refers back to a group.
function unbounded(source: string): boolean {
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at]
    if (character === '\\') {
      const next = source[at + 1] ?? ''
      if ((next >= '1' && next <= '9') || next === 'k') return true
      at += 1
    } else if (character === '[') {
      for (at += 1; at < source.length && source[at] !== ']'; at += 1) if (source[at] === '\\') at += 1
    } else if (character === '*' || character === '+') return true
    else if (character === '{') {
      let end = at + 1
      while (source[end]! >= '0' && source[end]! <= '9') end += 1
      if (end > at + 1 && source[end] === ',' && source[end + 1] === '}') return true
    }
  }
  return false
}

type Kind = { anchored: boolean; model: ReadModel | undefined; bounded: boolean; mask: boolean }
const kinds = new WeakMap<RegExp, Kind>()
function kindOf(pattern: RegExp): Kind {
  let found = kinds.get(pattern)
  if (!found) {
    const { source } = pattern
    found = {
      anchored: pattern.sticky || (!pattern.multiline && alternatives(source).every(branch => branch.startsWith('^'))),
      model: READ_MODELS.get(source),
      bounded: !unbounded(source),
      mask: MASKS.has(source),
    }
    kinds.set(pattern, found)
  }
  return found
}

// Where an attempt at `at` reads to: past its match `end`, or -1 when it fails.
function readTo(model: Exclude<ReadModel, 'rest'>, input: string, at: number, end: number): number {
  let to = Math.max(at + 1, end + 1)
  const { reach, fail, tail } = model
  if (reach) to = Math.max(to, at + 1 + (typeof reach === 'function' ? reach(input, at) : sticky(reach, input, at)))
  if (fail && end < 0) to = Math.max(to, at + 1 + sticky(fail, input, at))
  if (tail && end >= 0) to = Math.max(to, end + 1 + sticky(tail, input, end))
  return Math.min(to, Math.max(input.length, at + 1))
}

/**
 * The characters `run` reads, as above. With `by`, adds each search's share
 * under the method or pattern that read it.
 */
export function parseWork(run: () => void, by?: Map<string, number>): number {
  const string = String.prototype
  const array = Array.prototype
  const { indexOf, lastIndexOf, includes, endsWith, split, replace, replaceAll } = string
  const { join, findIndex, indexOf: arrayIndexOf, includes: arrayIncludes } = array
  const { keys } = Object
  const search = (text: string, pattern: string, from: number): number => Reflect.apply(indexOf, text, [pattern, from]) as number
  let work = 0
  const add = (amount: number, key: () => string) => {
    work += amount
    if (by) {
      const name = key()
      by.set(name, (by.get(name) ?? 0) + amount)
    }
  }
  let masked: string | undefined
  const patched: Array<{ target: object; name: string; value: unknown }> = []
  const patch = (target: object, name: string, value: unknown) => {
    patched.push({ target, name, value: Reflect.get(target, name) })
    Reflect.set(target, name, value)
  }
  patch(string, 'indexOf', function (this: string, pattern: string, from = 0) {
    const at = search(this, pattern, from)
    add((at < 0 ? this.length : at + String(pattern).length) - Math.max(from, 0), () => `indexOf ${JSON.stringify(pattern)}`)
    return at
  })
  patch(string, 'lastIndexOf', function (this: string, pattern: string, from = Infinity) {
    const at = Reflect.apply(lastIndexOf, this, [pattern, from]) as number
    add(Math.min(from, this.length) - Math.max(at, 0), () => `lastIndexOf ${JSON.stringify(pattern)}`)
    return at
  })
  patch(string, 'includes', function (this: string, pattern: string, from = 0) {
    const at = search(this, pattern, from)
    add((at < 0 ? this.length : at + String(pattern).length) - Math.max(from, 0), () => `includes ${JSON.stringify(pattern)}`)
    return Reflect.apply(includes, this, [pattern, from]) as boolean
  })
  // Checking the end of a text marked joined copies it.
  patch(string, 'endsWith', function (this: string, ...args: unknown[]) {
    add(this.length, () => 'endsWith')
    return Reflect.apply(endsWith, this, args) as boolean
  })
  // A split with a limit reads only to the last piece it keeps.
  patch(string, 'split', function (this: string, separator: unknown, limit?: number) {
    let end = this.length
    if (typeof separator === 'string' && separator && limit !== undefined) {
      let from = 0
      for (let piece = 0; piece < limit && from <= this.length; piece += 1) {
        const at = search(this, separator, from)
        from = at < 0 ? Infinity : at + separator.length
      }
      end = Math.min(from, this.length)
    }
    add(end, () => `split ${String(separator)}`)
    return Reflect.apply(split, this, [separator, limit]) as string[]
  })
  for (const [name, original] of [['replace', replace], ['replaceAll', replaceAll]] as const) {
    patch(string, name, function (this: string, ...args: unknown[]) {
      add(this.length, () => `${name} ${String(args[0])}`)
      return Reflect.apply(original, this, args) as unknown
    })
  }
  patch(array, 'join', function (this: unknown[], ...args: unknown[]) {
    const joined = Reflect.apply(join, this, args) as string
    add(joined.length, () => 'join')
    return joined
  })
  for (const [name, original] of [['findIndex', findIndex], ['indexOf', arrayIndexOf]] as const) {
    patch(array, name, function (this: unknown[], ...args: unknown[]) {
      const at = Reflect.apply(original, this, args) as number
      add(at < 0 ? this.length : at + 1, () => `array ${name}`)
      return at
    })
  }
  patch(array, 'includes', function (this: unknown[], ...args: unknown[]) {
    const at = Reflect.apply(arrayIndexOf, this, args) as number
    add(at < 0 ? this.length : at + 1, () => 'array includes')
    return Reflect.apply(arrayIncludes, this, args) as boolean
  })
  patch(Object, 'keys', (value: object) => {
    const list = keys(value)
    add(list.length, () => 'Object.keys')
    return list
  })
  patch(RegExp.prototype, 'exec', function (this: RegExp, input: string) {
    const from = this.global || this.sticky ? this.lastIndex : 0
    const match = Reflect.apply(exec, this, [input]) as RegExpExecArray | null
    const { anchored, model, bounded, mask } = kindOf(this)
    const pattern = () => `/${this.source.slice(0, 70)}/`
    const end = match ? match.index + match[0].length : -1
    if (!model && !bounded) {
      add(Math.max(1, input.length - from), () => `unmodelled ${pattern()}`)
    } else if (model === 'rest') {
      add(Math.max(1, input.length - from), pattern)
    } else if (anchored) {
      // A `^` pattern searched from past the start fails at once.
      const at = this.sticky || from === 0 ? from : -1
      add(at < 0 ? 1 : readTo(model ?? {}, input, at, end) - at, pattern)
    } else {
      // One for each attempt before the one that matches, and what that one reads.
      const last = match ? match.index : input.length
      add(Math.max(0, last - from) + readTo(model ?? {}, input, last, end) - last, pattern)
      if (model) {
        const { start } = model
        let read = 0
        const attempt = (at: number) => { read += readTo(model, input, at, -1) - at - 1 }
        if (start) {
          start.lastIndex = from
          for (let found = Reflect.apply(exec, start, [input]) as RegExpExecArray | null; found && found.index < last;
            found = Reflect.apply(exec, start, [input]) as RegExpExecArray | null) {
            attempt(found.index)
            if (!found[0]) start.lastIndex += 1
          }
        } else {
          for (let at = from; at < last; at += 1) attempt(at)
        }
        add(read, () => `${pattern()} hidden`)
      }
    }
    // marked's masking loop copies the text around each mask.
    if (mask && input !== masked) {
      add(input.length, () => `${pattern()} copied`)
      masked = input
    }
    return match
  })
  try {
    run()
    return work
  } finally {
    for (const { target, name, value } of patched.reverse()) Reflect.set(target, name, value)
  }
}
