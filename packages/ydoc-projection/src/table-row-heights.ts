// A resized row keeps its height in an HTML comment on the line above its
// table: `<!-- dohc:table row-heights=1:84,2:120 -->`. Row indexes count from
// the header row. GFM has no row-height syntax, Markdown renderers hide the
// comment, and the Rust projector writes the same bytes, so a local close
// that prunes the Y.Doc and reseeds from the file keeps the height. The
// projection's table and the desktop's read view (through the
// @dohc/ydoc-projection/table-row-heights subpath) both read it here, so a
// row has one height whether its document is read or edited.
export const TABLE_ROW_HEIGHTS_RE =
  /^<!-- dohc:table row-heights=(\d+:\d+(?:,\d+:\d+)*) -->[ \t]*(?:\n+|$)/u

// Every annotation starts with this text, so a reader can skip text that
// holds none.
export const TABLE_ROW_HEIGHTS_COMMENT = '<!-- dohc:table row-heights='

// The Rust projector reads the attribute through `attr_i64`, which accepts
// an integer or a trimmed integer string. Keep the same rule here so both
// projectors write the same annotation for the same Y.Doc.
export function tableRowHeight(value: unknown): number | null {
  const height = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\s*[+-]?\d+\s*$/u.test(value)
      ? Number(value)
      : Number.NaN
  return Number.isSafeInteger(height) && height > 0 ? height : null
}

// The row index and height of each pair in an annotation's
// `TABLE_ROW_HEIGHTS_RE` match, without a pair whose height is not a
// positive integer. An index past the table's last row names no row.
export function tableRowHeights(pairs: string): [number, number][] {
  const rowHeights: [number, number][] = []
  for (const pair of pairs.split(',')) {
    const [index, height] = pair.split(':').map(Number)
    if (Number.isSafeInteger(index) && tableRowHeight(height) !== null) {
      rowHeights.push([index, height])
    }
  }
  return rowHeights
}
