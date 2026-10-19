import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import * as Y from 'yjs'
import {markdownToYDoc} from '../../../packages/ydoc-projection/src/import-export'
import {createEngineMarkdownReader} from '../../../packages/ydoc-projection/src/engine-markdown-reader'
const directory = process.argv[2]!
const reader = createEngineMarkdownReader({maxStructVisits:1e6,maxValueNodeVisits:5e6,maxDecodedPayloadByteVisits:1e8,
  maxStructClientGroupVisits:1e6,maxDeleteClientGroupVisits:1e6,maxDeleteIntervalVisits:1e6,maxIndexOperations:1e7})
const document = {workspaceId:'w', mainVersionId:'main', objectId:'fixture', lineageClaimId:'l'}
function save(name:string, source:string, earlier:string) {
  const base=markdownToYDoc(earlier,{clientID:1234}), bytes=Buffer.from(source), checkpoint=Y.encodeStateAsUpdate(base)
  const result=reader.construct({document,currentPath:'note.md',source:bytes,checkpoint})
  if(result.kind!=='accepted') {base.destroy();return result}
  Y.applyUpdate(base,result.delta)
  writeFileSync(join(directory,`${name}.source`),bytes)
  writeFileSync(join(directory,`${name}.checkpoint`),checkpoint)
  writeFileSync(join(directory,`${name}.proof`),Y.encodeStateAsUpdate(base))
  base.getMap('meta').set('dohcMarkdownSourceProjectionSha256','0'.repeat(64))
  writeFileSync(join(directory,`${name}.forged`),Y.encodeStateAsUpdate(base))
  base.destroy();return {kind:'accepted',bytes:bytes.length}
}
const note='# Reader fixture\n\nA **bold** paragraph with [a link](https://example.com).\n\n- First item\n- Second item\n'
const results:any={note:save('note',note,note.replace('bold','earlier')),bom:save('bom','\ufeff'+note,note)}
const paragraph='A **bold** paragraph with _emphasis_, `code`, and [a link](https://example.com).\n\n'
const nested='- **parent** and notes\n  - _child_ with `Vec<T>` and & text\n  - sibling\n\n'
const blocks='# Workload\n\n'+(paragraph+nested).repeat(40)
const source=blocks+'x'.repeat(49999-blocks.length)+'\n'
results.warm=save('warm',source,source.replace('**parent**','**earlier**'))
// Maximum public source bound, with one short changed paragraph and an unchanged long block.
const largest='# Maximum\n\n'+'x'.repeat(2*1024*1024-12)+'\n'
results.largest=save('largest',largest,largest.replace('Maximum','Earlier'))
writeFileSync(join(directory,'fixtures.json'),JSON.stringify(results,null,2)+'\n')
console.log(results)
