import * as Y from 'yjs';
import {createArtifactMarkdownProjector} from '@dohc/ydoc-projection';

const artifactMarkdown = createArtifactMarkdownProjector();
self.onmessage = ({data}: MessageEvent<{id: number; snapshot: Uint8Array}>) => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, data.snapshot);
    self.postMessage({id: data.id, markdown: artifactMarkdown(doc)});
  } catch (error) {
    self.postMessage({id: data.id, error: String(error)});
  } finally { doc.destroy(); }
};
