// Build desktop Yjs vectors for the ignored commonmark_settle_survey Rust test.
// Uses the same import, witness metadata and v1 updates as settle-parity/yjs.json.
// With existing pnpm dependencies, run from the repository root:
//   node packages/ydoc-projection/scripts/generate-commonmark-settle-survey.mjs <spec.json> <output-directory>
// Then set DOHC_COMMONMARK_VECTORS=<output-directory>/vectors.json and
// DOHC_COMMONMARK_RESULTS=<output.jsonl>, and run:
//   cargo test --offline -p dohc-engine-sync --test commonmark_settle_survey -- --ignored
// Cargo must respect the host's disk floor and CARGO_BUILD_JOBS budget.
import {createHash} from 'node:crypto'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(import.meta.url)
const [specPath, outputDirectory] = process.argv.slice(2)
if (!specPath || !outputDirectory || process.argv.length !== 4) {
  throw new Error('Expected <spec.json> <output-directory>')
}
const tsx = require.resolve('tsx/esm/api', {paths: [root, resolve(root, 'node_modules/.pnpm')]})
const {register} = await import(pathToFileURL(tsx).href)
const unregister = register()
try {
  const {markdownToYDoc, yDocToMarkdown} = await import(pathToFileURL(resolve(root, 'packages/ydoc-projection/src/import-export.ts')).href)
  const Y = await import('yjs')
  const corpusBytes = readFileSync(resolve(specPath))
  const examples = JSON.parse(corpusBytes.toString('utf8'))
  if (!Array.isArray(examples) || examples.length === 0) throw new Error('Expected a nonempty CommonMark spec array')
  const seen = new Set()
  const vectors = [], imports = []
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  for (const example of examples) {
    if (!Number.isSafeInteger(example.example) || example.example < 1 || seen.has(example.example)
      || typeof example.section !== 'string' || typeof example.markdown !== 'string') {
      throw new Error('Invalid or duplicate CommonMark example')
    }
    seen.add(example.example)
    const source = example.markdown
    const row = {example: example.example, section: example.section, source, sourceSha256: sha(source)}
    let doc
    try {
      doc = markdownToYDoc(source, {clientID: example.example})
      const canonical = yDocToMarkdown(doc)
      const meta = doc.getMap('meta')
      doc.transact(() => {
        meta.set('dohcMarkdownSource', source)
        meta.set('dohcMarkdownSourceSha256', sha(source))
        meta.set('dohcMarkdownSourceProjectionSha256', sha(canonical))
      })
      vectors.push({...row, name: `commonmark-${example.example}`, canonical,
        updates: [Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')]})
      imports.push({...row, status: 'imported'})
    } catch (error) {
      imports.push({...row, status: 'import-refused', error: String(error)})
    } finally { doc?.destroy() }
  }
  const output = resolve(outputDirectory)
  mkdirSync(output, {recursive: true})
  writeFileSync(resolve(output, 'spec.json'), corpusBytes)
  writeFileSync(resolve(output, 'vectors.json'), JSON.stringify(vectors) + '\n')
  writeFileSync(resolve(output, 'imports.jsonl'), imports.map(row => JSON.stringify(row)).join('\n') + '\n')
  const manifest = {corpusSha256: sha(corpusBytes), examples: examples.length, imported: vectors.length,
    importRefused: imports.filter(row => row.status === 'import-refused').map(row => row.example),
    vectorsSha256: sha(readFileSync(resolve(output, 'vectors.json'))), node: process.version,
    terminalNewline: 'Source bytes are unchanged. Neither import nor settlement appends a newline.',
    witness: 'Unmarked native-source witness, matching retained settle-parity vectors; not a strict reader admission test.'}
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest, null, 2))
} finally { await unregister() }
