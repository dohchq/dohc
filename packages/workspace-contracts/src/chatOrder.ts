// Messages in the order the engine reads a read mark: by time, then by
// message ID. The desktop shows a conversation in it, and the phone picks the
// newest message it marks read by it. The engine compares IDs as SQLite text,
// byte by byte in UTF-8, which is code point order. JavaScript's `<` compares
// UTF-16 units and differs for characters past U+FFFF, so this walks code
// points instead.
export function compareMessageOrder(
  left: { createdAtMs: number; id: string },
  right: { createdAtMs: number; id: string },
): number {
  return left.createdAtMs - right.createdAtMs || compareCodePoints(left.id, right.id);
}

export function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex) ?? 0;
    const rightPoint = right.codePointAt(rightIndex) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  return (left.length - leftIndex) - (right.length - rightIndex);
}
