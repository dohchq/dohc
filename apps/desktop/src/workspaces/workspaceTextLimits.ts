import {
  LIVE_MARKDOWN_MAX_BYTES,
  exceedsUtf8Bytes,
  utf8ByteLength,
} from "@dohc/live-session-contract/limits";

export { exceedsUtf8Bytes, utf8ByteLength };

export const WORKSPACE_TEXT_EDITOR_MAX_BYTES = LIVE_MARKDOWN_MAX_BYTES;

// The largest note the WYSIWYG editor opens. MarkdownView shows a larger note
// as the read preview, and a live session seeds at most this much.
export const WYSIWYG_MARKDOWN_THRESHOLD_BYTES = 256 * 1024;

export function workspaceTextLimitReason(observedBytes: number): string {
  return (
    "Workspace text exceeds WORKSPACE_TEXT_EDITOR_MAX_BYTES: " +
    `limit ${WORKSPACE_TEXT_EDITOR_MAX_BYTES} bytes, observed ${observedBytes} bytes`
  );
}
