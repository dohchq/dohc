export const SHARE_DISCUSSION_BODY_CODE_POINT_LIMIT = 2_000;
export const SHARE_DISCUSSION_BODY_INPUT_BYTE_LIMIT = 8_000;
export const SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT = 40;
export const SHARE_DISCUSSION_NAME_BYTE_LIMIT = 160;

export type ShareDiscussionDisplayNameNormalization =
  | { ok: true; value: string }
  | { ok: false; reason: "too-long" | "empty" };

const SHARE_DISCUSSION_NAME_REMOVALS =
  /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

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
    value.includes("\u0000") ||
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

export function normalizeShareDiscussionDisplayName(
  value: unknown,
): ShareDiscussionDisplayNameNormalization {
  if (typeof value !== "string") return { ok: false, reason: "empty" };

  const normalized = value
    .normalize("NFC")
    .replace(SHARE_DISCUSSION_NAME_REMOVALS, "")
    .trim()
    .replace(/\s+/gu, " ");
  if (normalized.length === 0) return { ok: false, reason: "empty" };
  if (
    exceedsCodePoints(normalized, SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT) ||
    exceedsUtf8Bytes(normalized, SHARE_DISCUSSION_NAME_BYTE_LIMIT)
  ) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, value: normalized };
}
