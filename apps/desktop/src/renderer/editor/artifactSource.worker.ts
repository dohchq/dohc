import * as Y from 'yjs';
import {yDocToArtifactMarkdown} from '@dohc/ydoc-projection';

let current: {id: number; doc: Y.Doc} | null = null;
self.onmessage = ({data}: MessageEvent<{id: number; document: number; snapshot?: Uint8Array}>) => {
  try {
    if (!data.snapshot) {
      if (current?.id === data.document) {current.doc.destroy(); current = null;}
      return;
    }
    if (!current || current.id !== data.document) {
      current?.doc.destroy();
      current = {id: data.document, doc: new Y.Doc()};
    }
    Y.applyUpdate(current.doc, data.snapshot);
    self.postMessage({id: data.id, markdown: yDocToArtifactMarkdown(current.doc)});
  } catch (error) {
    self.postMessage({id: data.id, error: String(error)});
  }
};
