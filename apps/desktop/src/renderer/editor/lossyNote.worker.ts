import {lossyMarkdownVerdict, sessionVerdict} from '@dohc/ydoc-projection/lossy-markdown';

self.onmessage = ({data}: MessageEvent<{id: number; markdown?: string; state?: Uint8Array}>) => {
  try {
    if (data.state) self.postMessage({id: data.id, ...sessionVerdict(data.state)});
    // The rich editor shows its own nesting refusal before offering an edit.
    else self.postMessage({id: data.id, lossy: lossyMarkdownVerdict(data.markdown ?? '') === 'lossy'});
  } catch (error) {
    self.postMessage({id: data.id, error: String(error)});
  }
};
