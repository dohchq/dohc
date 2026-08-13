export const WORKSPACE_TEXT_EDITOR_MAX_BYTES = 2 * 1024 * 1024;

export function utf8ByteLength(value: string): number {
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
  }
  return bytes;
}

export function workspaceTextLimitReason(observedBytes: number): string {
  return (
    "Workspace text exceeds WORKSPACE_TEXT_EDITOR_MAX_BYTES: " +
    `limit ${WORKSPACE_TEXT_EDITOR_MAX_BYTES} bytes, observed ${observedBytes} bytes`
  );
}
