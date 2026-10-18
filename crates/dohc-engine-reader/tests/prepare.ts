import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import * as Y from '../../../packages/ydoc-projection/node_modules/yjs/dist/yjs.mjs'
import {markdownToYDoc} from '../../../packages/ydoc-projection/src/import-export'
import {createEngineMarkdownReader} from '../../../packages/ydoc-projection/src/engine-markdown-reader'
import rows from '../../../packages/ydoc-projection/src/engine-markdown-reader.fixture.json'
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
const row=rows.find(r=>r.accepted)!
const results:any={note:save('note',row.source,row.earlier),bom:save('bom','\ufeff'+row.source,row.earlier)}
// Reproduce PR 2's 50 KB workload when its task evidence is supplied.
const original=readFileSync(process.argv[3]!,'utf8')
const nested='\n- **parent** and [notes](https://example.com)\n  - _child_ with `Vec<T>` and & text\n  - sibling\n\n'
let source=original.replaceAll('- third item with a little detail\n','- third item with a little detail\n'+nested).slice(0,49996)+'\n'.repeat(4)
if(source.length<50000)source+='x'.repeat(50000-source.length)
results.warm=save('warm',source,source.replaceAll('**parent**','**earlier**'))
// Maximum public source bound, with one short changed paragraph and an unchanged long block.
const largest='# Maximum\n\n'+'x'.repeat(2*1024*1024-12)+'\n'
results.largest=save('largest',largest,largest.replace('Maximum','Earlier'))
writeFileSync(join(directory,'fixtures.json'),JSON.stringify(results,null,2)+'\n')
console.log(results)
