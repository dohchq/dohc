// Computes a fence long enough that no backtick run in value can be
// confused with the delimiter.
export function backtickFence(value: string, minimum: number): string {
  const longest = Array.from(value.matchAll(/`+/g))
    .reduce((max, match) => Math.max(max, match[0].length), 0)
  return '`'.repeat(Math.max(minimum, longest + 1))
}
