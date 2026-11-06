// The code-block languages a person can pick, and the name each one shows.
// The editor's picker and the read view's label both read this list, so it
// imports nothing: the read view's chunk stays free of the editor.
export const CODE_LANGUAGE_OPTIONS = [
  { value: "", label: "Plain text" },
  { value: "typescript", label: "TypeScript" },
  { value: "javascript", label: "JavaScript" },
  { value: "tsx", label: "TSX" },
  { value: "jsx", label: "JSX" },
  { value: "python", label: "Python" },
  { value: "bash", label: "Shell" },
  { value: "json", label: "JSON" },
  { value: "markdown", label: "Markdown" },
  { value: "mermaid", label: "Mermaid" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "sql", label: "SQL" },
  { value: "yaml", label: "YAML" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
] as const;

export function cleanCodeLanguage(value: string): string {
  return (value.trim().match(/^[A-Za-z0-9_+#.-]{0,48}/)?.[0] ?? "").slice(
    0,
    48,
  );
}
