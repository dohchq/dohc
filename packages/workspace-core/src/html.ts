/**
 * Escape text for interpolation into HTML markup. Exactly five literal
 * substitutions, `&` first so existing entities double-escape. Not a
 * sanitizer, URL check, or Markdown renderer; callers own their markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
