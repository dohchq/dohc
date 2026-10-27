import {isLossyMarkdown, sessionVerdict} from '@dohc/ydoc-projection/lossy-markdown';

self.onmessage = ({data}: MessageEvent<{id: number; markdown?: string; state?: Uint8Array; headSha256?: string | null}>) => {
  try {
    if (data.state) {
      if (data.headSha256 === undefined) throw new Error('The note check failed.');
      self.postMessage({id: data.id, ...sessionVerdict(data.state, data.headSha256)});
    }
    else self.postMessage({id: data.id, lossy: isLossyMarkdown(data.markdown ?? '')});
  } catch (error) {
    self.postMessage({id: data.id, error: String(error)});
  }
};
