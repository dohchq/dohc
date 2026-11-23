interface NativeBridge {
  postMessage(message: string): void;
}

/** Sends one message to the app. */
export function post(kind: string, payload: Record<string, unknown> = {}) {
  // Android's web view without a message handler, as the warm one, still has the object, but no postMessage.
  const bridge = (window as Window & { ReactNativeWebView?: Partial<NativeBridge> })
    .ReactNativeWebView;
  if (typeof bridge?.postMessage === "function")
    bridge.postMessage(JSON.stringify({ kind, ...payload }));
}
