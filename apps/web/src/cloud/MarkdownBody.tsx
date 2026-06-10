import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Read-only markdown rendering for cloud viewing. react-markdown never
// injects raw HTML (no rehype-raw), so untrusted bodies stay inert.
export function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="dohc-markdown-body max-w-[72ch] text-[14.5px] leading-relaxed text-ink [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-rule [&_blockquote]:pl-3 [&_blockquote]:text-ink-dim [&_code]:rounded [&_code]:bg-panel [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px] [&_h1]:mt-6 [&_h1]:font-serif [&_h1]:text-[24px] [&_h1]:text-ink-strong [&_h2]:mt-5 [&_h2]:font-serif [&_h2]:text-[19px] [&_h2]:text-ink-strong [&_h3]:mt-4 [&_h3]:text-[15.5px] [&_h3]:font-medium [&_h3]:text-ink-strong [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-rule [&_pre]:bg-panel [&_pre]:p-3 [&_table]:my-3 [&_table]:border-collapse [&_td]:border [&_td]:border-rule [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-rule [&_th]:bg-panel [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  )
}
