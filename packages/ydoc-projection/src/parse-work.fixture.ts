import { Lexer } from 'marked'

// The work `run` does in searches and copies, in characters: each search from
// where it starts to the end of its match, or to the end of the text when it
// finds none; each split, replacement and join of a whole text; and each key
// list it builds. An anchored pattern reads only its match, except where one
// `exec` hides what a pattern reads past where it stops, which these models
// count too:
// - marked's text rule looks ahead through the email characters after its
//   match, and its url rule reads the characters an address's local part may
//   hold;
// - its link rule reads a destination with no `)` to the next white space,
//   its code rule the rest for a closing run, its autolink rule to the next
//   white space or angle bracket, and its tag rule the rest for a comment's,
//   an instruction's, a declaration's or a CDATA section's end;
// - its definition rule reads a label to the next bracket, its setext rule
//   the rest of the block text, its table rule the first line, and its
//   paragraph rule, where it stops before a table, that table's rows;
// - a wikilink start that repeats its label reads to the end of the line from
//   each `[[` it tries;
// - each other text marked's masks search is a copy of the text it masked.
const INLINE = Lexer.rules.inline.gfm
const BLOCK = Lexer.rules.block.gfm
const EMAIL_CHARACTERS = /[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]*/y
const LOCAL_PART = /[A-Za-z0-9._+-]*/y
const LINK_DESTINATION = /!?\[[^\]]*\]\([^ \t\n\x00-\x1f]*/y
const AUTOLINK_BODY = /<[^\s\x00-\x1f<>]*/y
const DEFINITION_LABEL = / {0,3}\[(?:\\[\s\S]|[^[\]\\])*/y
const TAG_ENDS: Array<[RegExp, string]> = [[/<!--/y, '-->'], [/<\?/y, '?>'], [/<!\[CDATA\[/y, ']]>'], [/<![a-zA-Z]/y, '>']]
const TABLE = new RegExp(BLOCK.table.source.slice(1), 'y')
const MASKS = new Set([INLINE.anyPunctuation, INLINE.blockSkip, INLINE.reflinkSearch])
const RULES = new Map([INLINE.text, INLINE.url, INLINE.link, INLINE.code, INLINE.autolink, INLINE.tag, BLOCK.def, BLOCK.lheading,
  BLOCK.table, BLOCK.paragraph, ...MASKS].map(rule => [rule.source, rule]))

/**
 * The characters `run` reads, as above. With `by`, adds each search's share
 * under the method or pattern that read it.
 */
export function parseWork(run: () => void, by?: Map<string, number>): number {
  const string = String.prototype
  const array = Array.prototype
  const { exec } = RegExp.prototype
  const { indexOf, lastIndexOf, includes, endsWith, split, replace, replaceAll } = string
  const { join, findIndex, indexOf: arrayIndexOf, includes: arrayIncludes } = array
  const { keys } = Object
  const search = (text: string, pattern: string, from: number): number => Reflect.apply(indexOf, text, [pattern, from]) as number
  const sticky = (pattern: RegExp, text: string, at: number): number => {
    pattern.lastIndex = at
    return (Reflect.apply(exec, pattern, [text]) as RegExpExecArray | null)?.[0].length ?? 0
  }
  // Whether a pattern is anchored, and whether it repeats a wikilink's label
  // after `[[`, read once per pattern without the counted methods.
  const kinds = new WeakMap<RegExp, { anchored: boolean; wikilink: boolean }>()
  const kind = (pattern: RegExp) => {
    let found = kinds.get(pattern)
    if (!found) {
      const { source } = pattern
      let wikilink = false
      for (let at = 0; at < source.length; at += 1) {
        if (source[at] === '\\') at += 1
        else if (source[at] === '+' || source[at] === '*') wikilink = true
      }
      wikilink &&= search(source, '\\[\\[', 0) >= 0
      found = { anchored: pattern.sticky || (source[0] === '^' && !pattern.multiline), wikilink }
      kinds.set(pattern, found)
    }
    return found
  }
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
    const { anchored, wikilink } = kind(this)
    const pattern = () => `/${this.source.slice(0, 70)}/`
    add(anchored ? match?.[0].length ?? 0 : (match ? match.index + match[0].length : input.length) - from, pattern)
    const hidden = (amount: number) => add(amount, () => `${pattern()} hidden`)
    // By source, so another copy of marked's rules counts too.
    const rule = RULES.get(this.source)
    if (rule === INLINE.text && match) hidden(sticky(EMAIL_CHARACTERS, input, match[0].length))
    else if (rule === INLINE.url && !match) hidden(sticky(LOCAL_PART, input, 0))
    else if (rule === INLINE.link && !match) hidden(sticky(LINK_DESTINATION, input, 0))
    else if (rule === INLINE.code && !match && input[0] === '`') hidden(input.length)
    else if (rule === INLINE.autolink && !match) hidden(sticky(AUTOLINK_BODY, input, 0))
    else if (rule === INLINE.tag && !match) {
      for (const [opener, end] of TAG_ENDS) {
        if (!sticky(opener, input, 0)) continue
        const at = search(input, end, 1)
        hidden(at < 0 ? input.length : at)
        break
      }
    } else if (rule === BLOCK.def && !match) hidden(sticky(DEFINITION_LABEL, input, 0))
    else if (rule === BLOCK.lheading && !match) hidden(input.length)
    else if (rule === BLOCK.table && !match) {
      const line = search(input, '\n', 0)
      hidden(line < 0 ? input.length : line)
    } else if (rule === BLOCK.paragraph && match) {
      const end = match.index + match[0].length
      if (input[end] === '\n') hidden(sticky(TABLE, input, end + 1))
    } else if (rule && MASKS.has(rule) && input !== masked) {
      hidden(input.length)
      masked = input
    }
    if (wikilink) {
      const end = this.sticky ? from + 1 : match ? match.index + 1 : input.length
      for (let at = search(input, '[[', from); at >= 0 && at <= end; at = search(input, '[[', at + 1)) {
        const line = search(input, '\n', at)
        hidden((line < 0 ? input.length : line) - at)
      }
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
