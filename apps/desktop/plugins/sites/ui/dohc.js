// The dohc SDK, spelled out.
//
// A panel is static files dohc serves on their own origin, so it has no
// bundler and cannot resolve `@dohc/sdk` by name. This is that package's
// postMessage protocol written by hand, and it stays in step with
// `packages/sdk/src/index.ts` — the two protocol strings below are
// DOHC_SDK_PROTOCOL and DOHC_THEME_PROTOCOL.

const SDK_PROTOCOL = "dohc:sdk:v1";
const THEME_PROTOCOL = "dohc:theme:v1";
const REQUEST_TIMEOUT_MS = 10_000;

const hostOrigin = new URL(window.location.href).searchParams.get("dohcHostOrigin");
const responseOrigin = hostOrigin === "file://" ? "null" : hostOrigin;
const postOrigin = hostOrigin === "file://" ? "*" : hostOrigin;
let nextRequestId = 1;
const subscriptionListeners = new Map();
const queuedSubscriptionEvents = new Map();
let pendingSubscribeCount = 0;

// A failed request has no id to close. Grant-abort disposal eventually removes
// its main-process authority and registry record. MAX_PLUGIN_FILE_WATCHES_PER_OWNER = 16
// bounds each owner until then.
function collectUnclaimedSubscriptionEvents() {
  if (pendingSubscribeCount !== 0) return;
  for (const subscriptionId of queuedSubscriptionEvents.keys()) {
    if (!subscriptionListeners.has(subscriptionId)) {
      queuedSubscriptionEvents.delete(subscriptionId);
    }
  }
}

function retainPendingSubscribe() {
  let pending = true;
  pendingSubscribeCount += 1;
  return () => {
    if (!pending) return;
    pending = false;
    pendingSubscribeCount -= 1;
    collectUnclaimedSubscriptionEvents();
  };
}

/**
 * Asks dohc for something.
 *
 * @param {string} method
 * @param {unknown} [params]
 * @returns {Promise<any>}
 */
export function request(method, params) {
  if (!hostOrigin || !postOrigin) {
    return Promise.reject(new Error("This panel has no dohc host origin."));
  }
  const id = `sites-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`dohc did not answer ${method}.`));
    }, REQUEST_TIMEOUT_MS);

    /** @param {MessageEvent} event */
    function onMessage(event) {
      if (event.source !== window.parent || event.origin !== responseOrigin) return;
      const response = event.data;
      if (
        !response ||
        response.protocol !== SDK_PROTOCOL ||
        response.id !== id ||
        typeof response.ok !== "boolean"
      ) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (response.ok) resolve(response.result);
      else reject(new Error(response.error?.message ?? "dohc refused the request."));
    }

    window.addEventListener("message", onMessage);
    window.parent.postMessage({ protocol: SDK_PROTOCOL, id, method, params }, postOrigin);
  });
}

/** @param {string} subscriptionId @param {{ event: string; data: unknown }} event */
function queueSubscriptionEvent(subscriptionId, event) {
  const queued = queuedSubscriptionEvents.get(subscriptionId) ?? [];
  queued.push(event);
  if (queued.length > 200) queued.shift();
  queuedSubscriptionEvents.set(subscriptionId, queued);
}

/** @param {MessageEvent} event */
function handleSubscriptionMessage(event) {
  if (event.source !== window.parent || event.origin !== responseOrigin) return;
  const message = event.data;
  if (
    !message ||
    typeof message !== "object" ||
    message.protocol !== SDK_PROTOCOL ||
    message.type !== "event" ||
    typeof message.subscriptionId !== "string" ||
    message.subscriptionId.length === 0 ||
    typeof message.event !== "string" ||
    message.event.length === 0 ||
    !("data" in message)
  ) {
    return;
  }

  const subscriptionEvent = { event: message.event, data: message.data };
  const listener = subscriptionListeners.get(message.subscriptionId);
  if (listener) listener(subscriptionEvent);
  else queueSubscriptionEvent(message.subscriptionId, subscriptionEvent);
}

// One listener, installed once, for this page's whole lifetime — the page
// itself is the subscription boundary, so there's no second scope this
// listener could outlive and leak into.
window.addEventListener("message", handleSubscriptionMessage);

/**
 * Opens a subscription and returns a function that closes it.
 *
 * @param {string} method
 * @param {unknown} params
 * @param {(event: { event: string; data: unknown }) => void} listener
 */
export async function subscribe(method, params, listener) {
  if (typeof listener !== "function") {
    throw new Error("Subscription listener must be a function.");
  }

  const finishPendingSubscribe = retainPendingSubscribe();
  let result;
  try {
    result = await request(method, params);
  } catch (error) {
    finishPendingSubscribe();
    throw error;
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.subscriptionId !== "string" ||
    result.subscriptionId.length === 0
  ) {
    finishPendingSubscribe();
    throw new Error(`dohc returned an invalid subscription response for ${method}.`);
  }

  const { subscriptionId } = result;
  subscriptionListeners.set(subscriptionId, listener);
  finishPendingSubscribe();
  for (const event of queuedSubscriptionEvents.get(subscriptionId) ?? []) {
    listener(event);
  }
  queuedSubscriptionEvents.delete(subscriptionId);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscriptionListeners.delete(subscriptionId);
    queuedSubscriptionEvents.delete(subscriptionId);
    void request("subscriptions.unsubscribe", { subscriptionId }).catch(() => undefined);
  };
}

/** @param {{ mode: string; density: string; reduceMotion: boolean; tokens: Record<string, string> }} theme */
function writeTheme(theme) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (/^--[A-Za-z0-9-]+$/.test(name)) root.style.setProperty(name, value);
  }
  root.dataset.theme = theme.mode;
  root.dataset.density = theme.density;
  root.dataset.reduceMotion = String(theme.reduceMotion);
}

/**
 * Writes dohc's design tokens onto this page and keeps following them.
 *
 * Listening starts before the first read, so a theme the user changes while
 * the panel is loading is applied rather than lost.
 */
export async function applyTheme() {
  let pushed = false;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== responseOrigin) return;
    const message = event.data;
    if (!message || message.protocol !== THEME_PROTOCOL || !message.theme) return;
    pushed = true;
    writeTheme(message.theme);
  });
  const theme = await request("ui.theme");
  if (!pushed) writeTheme(theme);
}
