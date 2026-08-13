export const WORKSPACE_TEXT_EDITOR_MAX_BYTES = 2 * 1024 * 1024;

// One walk of the UTF-8 encoding, stopping as soon as the count passes
// `stopAbove`. UTF-8 spends one byte per ASCII unit, two below U+0800, four
// across a surrogate pair, and three for everything else including a lone
// surrogate, which encodes as the replacement character.
function utf8Bytes(value: string, stopAbove: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > stopAbove) return bytes;
  }
  return bytes;
}

/// Whether `value` is more than `limitBytes` of UTF-8, without encoding it.
///
/// `new TextEncoder().encode(value).length` copies the whole body to count it.
/// UTF-8 spends at least one byte and at most three per UTF-16 code unit, so
/// the cheap comparisons settle most calls. The exact walk stops as soon as it
/// passes the limit.
export function exceedsUtf8Bytes(value: string, limitBytes: number): boolean {
  if (value.length > limitBytes) return true;
  if (value.length * 3 <= limitBytes) return false;
  return utf8Bytes(value, limitBytes) > limitBytes;
}

export function utf8ByteLength(value: string): number {
  return utf8Bytes(value, Number.POSITIVE_INFINITY);
}

export function workspaceTextLimitReason(observedBytes: number): string {
  return (
    "Workspace text exceeds WORKSPACE_TEXT_EDITOR_MAX_BYTES: " +
    `limit ${WORKSPACE_TEXT_EDITOR_MAX_BYTES} bytes, observed ${observedBytes} bytes`
  );
}
