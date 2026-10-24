import {isLossyMarkdown, sessionVerdict} from '@dohc/ydoc-projection/lossy-markdown';

self.onmessage = ({data}: MessageEvent<{id: number; markdown?: string; state?: Uint8Array}>) => {
  try {
    if (data.state) self.postMessage({id: data.id, ...sessionVerdict(data.state)});
    else self.postMessage({id: data.id, lossy: isLossyMarkdown(data.markdown ?? '')});
  } catch (error) {
    self.postMessage({id: data.id, error: String(error)});
  }
};
