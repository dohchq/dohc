export const SHARE_DISCUSSION_BODY_CODE_POINT_LIMIT = 2_000;
export const SHARE_DISCUSSION_BODY_INPUT_BYTE_LIMIT = 8_000;

function exceedsUtf8Bytes(value: string, limit: number): boolean {
  if (value.length > limit) return true;

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
    if (bytes > limit) return true;
  }
  return false;
}

function exceedsCodePoints(value: string, limit: number): boolean {
  let codePoints = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      index += 1;
    }
    codePoints += 1;
    if (codePoints > limit) return true;
  }
  return false;
}

export function normalizeShareDiscussionBody(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    exceedsUtf8Bytes(value, SHARE_DISCUSSION_BODY_INPUT_BYTE_LIMIT)
  ) {
    return null;
  }

  const normalized = value.normalize("NFC");
  if (
    normalized.length === 0 ||
    exceedsCodePoints(normalized, SHARE_DISCUSSION_BODY_CODE_POINT_LIMIT)
  ) {
    return null;
  }
  return normalized;
}
