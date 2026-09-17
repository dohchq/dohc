// Computes a fence long enough that no backtick run in value can be
// confused with the delimiter.
export function backtickFence(value: string, minimum: number): string {
  return delimiterFence(value, minimum, '`')
}

export function codeBlockFence(value: string, language: string): string {
  return delimiterFence(value, 3, language.includes('`') ? '~' : '`')
}

function delimiterFence(value: string, minimum: number, delimiter: '`' | '~'): string {
  const longest = Array.from(value.matchAll(delimiter === '`' ? /`+/g : /~+/g))
    .reduce((max, match) => Math.max(max, match[0].length), 0)
  return delimiter.repeat(Math.max(minimum, longest + 1))
}
