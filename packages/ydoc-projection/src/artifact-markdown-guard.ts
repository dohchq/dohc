/** Import equality alone does not prove the engine's reading of these spellings. */
export function canPreserveMarkdownSource(source: unknown): source is string {
  return (
    typeof source === "string" &&
    !source.includes("<") &&
    !source.includes("&") &&
    !source.includes("]:")
  );
}

export function omitsFinalMarkdownNewline(source: string, projection: string): boolean {
  if (
    source.length === 0 ||
    source.endsWith("\n") ||
    source.endsWith("\r") ||
    !projection.endsWith("\n")
  )
    return false;
  const newlineLength = projection.endsWith("\r\n") ? 2 : 1;
  return projection.length - source.length === newlineLength && projection.startsWith(source);
}
