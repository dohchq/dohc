import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

// One styled markdown renderer for AI prose (the chat) and the live
// previews (dashboard / profile). Maps every element to the
// warm-paper type scale so dohc's output reads as a designed
// document, never a wall of raw text. Streaming-safe: partial
// markdown just renders as far as it parses, then settles.

type Variant = 'chat' | 'compact'

const make = (v: Variant): Components => {
  const compact = v === 'compact'
  const base = compact ? 'text-[11px]' : 'text-[13.5px]'
  const lead = compact ? 'leading-[1.55]' : 'leading-[1.7]'
  return {
    p: ({ children }) => (
      <p className={`${base} ${lead} text-ink-dim [&:not(:first-child)]:mt-2.5`}>
        {children}
      </p>
    ),
    h1: ({ children }) => (
      <h1
        className={`${compact ? 'text-[13px]' : 'text-[17px]'} font-semibold tracking-tight text-ink-strong [&:not(:first-child)]:mt-4 mb-1`}
      >
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2
        className={`${compact ? 'text-[12px]' : 'text-[15px]'} font-semibold tracking-tight text-ink-strong [&:not(:first-child)]:mt-3.5 mb-1`}
      >
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3
        className={`${compact ? 'text-[11.5px]' : 'text-[13.5px]'} font-semibold text-ink-strong [&:not(:first-child)]:mt-3 mb-0.5`}
      >
        {children}
      </h3>
    ),
    ul: ({ children }) => (
      <ul
        className={`${base} ${lead} mt-1.5 flex flex-col gap-1 text-ink-dim [&_ul]:mt-1 [&_ul]:ml-3.5`}
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol
        className={`${base} ${lead} mt-1.5 flex flex-col gap-1 text-ink-dim [counter-reset:li]`}
      >
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className="relative pl-4 before:absolute before:left-1 before:top-[0.62em] before:size-1 before:rounded-full before:bg-ink-faint marker:hidden">
        {children}
      </li>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-ink-strong">{children}</strong>
    ),
    em: ({ children }) => <em className="italic text-ink">{children}</em>,
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
      >
        {children}
      </a>
    ),
    code: ({ children, className }) => {
      const block = (className ?? '').includes('language-')
      if (block)
        return (
          <code className="block font-mono text-[11px] leading-relaxed text-ink-dim">
            {children}
          </code>
        )
      return (
        <code className="rounded bg-page px-1 py-0.5 font-mono text-[0.86em] text-ink">
          {children}
        </code>
      )
    },
    pre: ({ children }) => (
      <pre className="mt-2 overflow-x-auto rounded-lg border border-rule bg-page px-3 py-2">
        {children}
      </pre>
    ),
    blockquote: ({ children }) => (
      <blockquote className="mt-2 border-l-2 border-rule-strong pl-3 text-ink-faint italic">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-3 border-rule" />,
    table: ({ children }) => (
      <div className="mt-2 overflow-x-auto rounded-lg border border-rule">
        <table className="w-full border-collapse text-[11.5px]">
          {children}
        </table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-rule bg-panel px-2.5 py-1.5 text-left font-semibold text-ink-strong">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-rule px-2.5 py-1.5 text-ink-dim">
        {children}
      </td>
    ),
  }
}

const CHAT = make('chat')
const COMPACT = make('compact')

export const Markdown = memo(function Markdown({
  children,
  variant = 'chat',
}: {
  children: string
  variant?: Variant
}) {
  return (
    <div className="break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={variant === 'compact' ? COMPACT : CHAT}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})
