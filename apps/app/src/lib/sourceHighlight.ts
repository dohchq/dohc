// D4.34 — Prism syntax highlighting for the raw `⟨⟩ source` view.
// Used by AtomView's source editor (react-simple-code-editor). The
// highlighter PRESERVES every character (it only wraps tokens in
// spans), so the highlighted <pre> stays byte-aligned with the
// editable <textarea> underneath it.
import Prism from 'prismjs'
import 'prismjs/components/prism-markup' // html (Prism calls it "markup")
import 'prismjs/components/prism-yaml' // frontmatter
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-json'

export type SourceLang =
  | 'html'
  | 'markdown'
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'css'
  | 'json'

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

function highlightWith(code: string, lang: SourceLang): string {
  const grammar =
    lang === 'html'
      ? Prism.languages.markup
      : Prism.languages[lang] ?? Prism.languages.markdown
  if (!grammar) return escapeHtml(code)
  return Prism.highlight(code, grammar, lang === 'html' ? 'markup' : lang)
}

/** Highlight an atom body: the leading YAML frontmatter block (if
 *  any) as YAML, the rest as HTML or Markdown. Concatenation is
 *  char-exact with the input, so the editor overlay stays aligned. */
export function highlightSource(code: string, lang: SourceLang): string {
  const m = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/.exec(code)
  if (m && Prism.languages.yaml) {
    const fm = Prism.highlight(m[1], Prism.languages.yaml, 'yaml')
    return fm + highlightWith(m[2], lang)
  }
  return highlightWith(code, lang)
}
