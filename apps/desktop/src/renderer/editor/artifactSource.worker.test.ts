import {expect,it,vi} from 'vitest';
import * as Y from 'yjs';
import {markdownToYDoc,yDocToMarkdown} from '@dohc/ydoc-projection';
it('destroys each request document and never merges unrelated snapshots',async()=>{
 const postMessage=vi.fn();vi.stubGlobal('self',{postMessage,onmessage:null});const destroyed=vi.spyOn(Y.Doc.prototype,'destroy');
 try{await import('./artifactSource.worker');for(const [id,text] of ['First','Second'].entries()){const doc=markdownToYDoc(text);const snapshot=Y.encodeStateAsUpdate(doc);const expected=yDocToMarkdown(doc);doc.destroy();destroyed.mockClear();
 (self.onmessage as Function)({data:{id,snapshot}});expect(postMessage).toHaveBeenLastCalledWith({id,markdown:expected});expect(destroyed).toHaveBeenCalledTimes(1);}}finally{destroyed.mockRestore();vi.unstubAllGlobals();}
});
