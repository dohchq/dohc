/** Import equality alone does not prove the engine's reading of these spellings. */
export function canPreserveMarkdownSource(source: unknown): source is string {
  return typeof source === 'string'
    && !source.includes('<') && !source.includes('&') && !source.includes(']:')
}
