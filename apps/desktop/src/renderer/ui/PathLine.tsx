// A path on one line: its first folder, the folders after it, and its name.
// Too long for the line, the folders after the first give way first, cut
// from their start behind an "…" that always stays. Then the name gives way,
// cut at its end. The first folder never shrinks. The caller puts the full
// path in a tooltip.

export type PathParts = { first: string; middle: string; name: string };

// Splits a path as the OS spells it: a Windows path starts with a drive or
// "\\" and uses "\"; any other path uses "/". The three parts join back into
// the path.
export function splitPath(path: string): PathParts {
  const separator = /^([A-Za-z]:\\|\\\\)/.test(path) ? "\\" : "/";
  const nameStart = path.lastIndexOf(separator) + 1;
  // The first folder runs through the separator after its own name: "C:\",
  // "\\server\", "/home/". Without one, or past the name, it is all before the name.
  const afterFirst = path.indexOf(separator, path.search(separator === "\\" ? /[^\\]/ : /[^/]/)) + 1;
  const firstEnd = afterFirst === 0 ? nameStart : Math.min(afterFirst, nameStart);
  return { first: path.slice(0, firstEnd), middle: path.slice(firstEnd, nameStart), name: path.slice(nameStart) };
}

export function PathLine(props: { path: string; className?: string }) {
  const { first, middle, name } = splitPath(props.path);
  return (
    <span className={`flex min-w-0 whitespace-nowrap ${props.className ?? ""}`}>
      <span className="shrink-0">{first}</span>
      <span className="flex min-w-0">
        {/* Laid out from the right, so a cut takes the start. It keeps room
            for "…" and the separator after it, so the line never reads
            "C:\Personal" when folders are missing. */}
        {middle ? (
          <span dir="rtl" className="min-w-[1.5em] truncate text-left">
            <bdi dir="ltr">{middle}</bdi>
          </span>
        ) : null}
        <span className={`shrink-0 truncate ${middle ? "max-w-[calc(100%-1.5em)]" : "max-w-full"}`}>{name}</span>
      </span>
    </span>
  );
}
