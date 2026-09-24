import { readFileSync, writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
it('probe', () => {
  const inputs: string[] = JSON.parse(readFileSync(process.env.PROBE_FILE!, 'utf8'))
  const out = inputs.map(md => { const d = markdownToYDoc(md); try { return `${JSON.stringify(md)} => ${JSON.stringify(yDocToMarkdown(d))}` } finally { d.destroy() } })
  writeFileSync(process.env.OUT!, out.join('\n'))
})
