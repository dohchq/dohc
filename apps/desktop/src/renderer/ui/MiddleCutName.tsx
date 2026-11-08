// A name on one line, cut in the middle when it is too long: its start gives
// way behind an "…", and its end never shrinks. CSS does the cut, so a row
// measures nothing on render or scroll.
//
// The two parts are two boxes, and Chromium reads two boxes as two words. The
// caller names its row with the whole name in `aria-label`.

// The end keeps the name's last five characters before its extension. Five
// hold a copy number such as " (2)", a version such as "-v12", or a short
// last word.
const KEPT_END = 5;

// An extension is a last dot, not the first character, then 1 to 15
// characters with no dot or space. "code-workspace" has 14. A longer suffix
// would make an end too wide to fit and too rigid to shrink.
const EXTENSION = /\.[^.\s]{1,15}$/;

const SPACE = /\s/;

export function splitName(name: string): { start: string; end: string } {
  const extension = EXTENSION.exec(name);
  const extensionStart = extension && extension.index > 0 ? extension.index : name.length;
  // Code points, so the cut never splits a surrogate pair.
  const stem = Array.from(name.slice(0, extensionStart));
  let cut = Math.max(0, stem.length - KEPT_END);
  // Each part drops a space at its own edge, so the cut moves left until no
  // space touches it. The end then keeps its spaces inside, where they show
  // as they do in one line.
  while (cut > 0 && (SPACE.test(stem[cut - 1]!) || SPACE.test(stem[cut]!))) cut -= 1;
  return { start: stem.slice(0, cut).join(""), end: stem.slice(cut).join("") + name.slice(extensionStart) };
}

export function MiddleCutName(props: { name: string }) {
  const { start, end } = splitName(props.name);
  if (!start) return <span className="min-w-0 flex-1 truncate">{props.name}</span>;
  return (
    <span className="flex min-w-0 flex-1 overflow-hidden whitespace-nowrap">
      <span data-name-start="" className="min-w-0 truncate">{start}</span>
      <span data-name-end="" className="shrink-0">{end}</span>
    </span>
  );
}
