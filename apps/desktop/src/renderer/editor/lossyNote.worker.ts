import {isLossyMarkdown} from '@dohc/ydoc-projection/lossy-markdown';

self.onmessage = ({data}: MessageEvent<{id: number; markdown: string}>) => {
  try {
    self.postMessage({id: data.id, lossy: isLossyMarkdown(data.markdown)});
  } catch (error) {
    self.postMessage({id: data.id, error: String(error)});
  }
};
