interface NativeBridge { postMessage(message: string): void }

/** Sends one message to the app. */
export function post(kind: string, payload: Record<string, unknown> = {}) {
  const bridge = (window as Window & { ReactNativeWebView?: NativeBridge }).ReactNativeWebView;
  bridge?.postMessage(JSON.stringify({ kind, ...payload }));
}
