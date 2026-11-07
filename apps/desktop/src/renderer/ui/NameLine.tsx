// A name cut in its middle, so a short extension stays: "product-pl….md".
// Only the last part of a path has an extension: "v1.2/README" has none.
export function NameLine(props: { name: string; title?: string; className?: string }) {
  const dot = props.name.lastIndexOf(".");
  const base = props.name.lastIndexOf("/") + 1;
  const cut = dot > base && props.name.length - dot <= 12 ? dot : props.name.length;
  return (
    <span className={`flex min-w-0 ${props.className ?? ""}`} title={props.title}>
      <span className="truncate">{props.name.slice(0, cut)}</span>
      <span className="shrink-0 whitespace-pre">{props.name.slice(cut)}</span>
    </span>
  );
}
