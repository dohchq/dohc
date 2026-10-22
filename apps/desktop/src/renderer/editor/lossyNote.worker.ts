import {isLossyDocumentState, isLossyMarkdown} from '@dohc/ydoc-projection/lossy-markdown';

self.onmessage = ({data}: MessageEvent<{id: number; markdown?: string; state?: Uint8Array}>) => {
  try {
    const lossy = data.state ? isLossyDocumentState(data.state) : isLossyMarkdown(data.markdown ?? '');
    self.postMessage({id: data.id, lossy});
  } catch (error) {
    self.postMessage({id: data.id, error: String(error)});
  }
};
