const HANDLE_PATTERN = /(^|[^\p{L}\p{N}_])@([A-Za-z0-9-]+)/gu;

function visibleInlineText(
  line: string,
  openDelimiter: string | null,
): { text: string; openDelimiter: string | null } {
  let visible = "";
  let offset = 0;
  while (offset < line.length) {
    if (openDelimiter !== null) {
      const close = line.indexOf(openDelimiter, offset);
      if (close === -1) return { text: visible, openDelimiter };
      offset = close + openDelimiter.length;
      openDelimiter = null;
      continue;
    }
    if (line[offset] !== "`") {
      visible += line[offset];
      offset += 1;
      continue;
    }
    let runEnd = offset + 1;
    while (line[runEnd] === "`") runEnd += 1;
    openDelimiter = line.slice(offset, runEnd);
    offset = runEnd;
  }
  return { text: visible, openDelimiter };
}

export function parseMentionHandles(body: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  let fenced = false;
  let openInlineDelimiter: string | null = null;
  for (const line of body.replace(/\r\n?/gu, "\n").split("\n")) {
    if (openInlineDelimiter === null && line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const visible = visibleInlineText(line, openInlineDelimiter);
    openInlineDelimiter = visible.openDelimiter;
    for (const match of visible.text.matchAll(HANDLE_PATTERN)) {
      const handle = match[2]?.toLowerCase();
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      handles.push(handle);
    }
  }
  return handles;
}
