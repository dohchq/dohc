import { isAbsolute, resolve } from "node:path";
import { canonicalRelayUrl } from "./workspaces/syncCode";

const SHARE_HANDOFF_SCHEME = "dohc";
const SHARE_HANDOFF_URL_PATTERN =
  /^([A-Za-z]+):\/\/([A-Za-z]+)\/([A-Za-z0-9_-]{43})\?relay=([^&#]+)$/u;
const SHARE_HANDOFF_PROTOCOL_PATTERN = /^dohc:/iu;

declare const shareHandoffCodeBrand: unique symbol;
export type ShareHandoffCode = string & {
  readonly [shareHandoffCodeBrand]: true;
};
export type ShareHandoffOfferResult = "stored" | "duplicate" | "replaced";
export type ShareHandoffArgumentIntent = "plain" | "accepted" | "rejected";

export interface ShareHandoffIntent {
  readonly code: ShareHandoffCode;
  readonly relayUrl: string;
}

export interface ShareHandoffIntentSnapshot {
  intent: ShareHandoffIntent | null;
  generation: number;
}

export interface ShareHandoffIntentSlot {
  offer(intent: ShareHandoffIntent): ShareHandoffOfferResult;
  pending(): ShareHandoffIntent | null;
  snapshot(): ShareHandoffIntentSnapshot;
  settle(intent: ShareHandoffIntent): boolean;
}

export interface ShareHandoffWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface NewShareHandoffWindow extends ShareHandoffWindow {
  once(event: "ready-to-show", listener: () => void): void;
}

export interface ProtocolClientRegistrar {
  setAsDefaultProtocolClient(
    scheme: string,
    path?: string,
    args?: string[],
  ): boolean;
}

export interface ProtocolRuntime {
  defaultApp?: boolean;
  execPath: string;
  argv: string[];
}

export function parseShareHandoffUrl(
  rawArgument: string,
): ShareHandoffIntent | null {
  const match = SHARE_HANDOFF_URL_PATTERN.exec(rawArgument);
  if (
    match?.[0] !== rawArgument ||
    match[1]?.toLowerCase() !== SHARE_HANDOFF_SCHEME ||
    match[2]?.toLowerCase() !== "open" ||
    match[3] === undefined ||
    match[4] === undefined
  ) {
    return null;
  }
  let decodedRelayUrl: string;
  try {
    decodedRelayUrl = decodeURIComponent(match[4]);
  } catch {
    return null;
  }
  const relayUrl = canonicalRelayUrl(decodedRelayUrl);
  if (
    relayUrl === null ||
    relayUrl !== decodedRelayUrl ||
    encodeURIComponent(relayUrl) !== match[4]
  ) {
    return null;
  }
  return { code: match[3] as ShareHandoffCode, relayUrl };
}

export function classifyShareHandoffArguments(
  rawArguments: readonly string[],
): ShareHandoffArgumentIntent {
  let sawRejectedProtocolArgument = false;
  for (const rawArgument of rawArguments) {
    if (parseShareHandoffUrl(rawArgument) !== null) return "accepted";
    if (SHARE_HANDOFF_PROTOCOL_PATTERN.test(rawArgument)) {
      sawRejectedProtocolArgument = true;
    }
  }
  return sawRejectedProtocolArgument ? "rejected" : "plain";
}

export function createShareHandoffIntentSlot(): ShareHandoffIntentSlot {
  let pendingIntent: ShareHandoffIntent | null = null;
  let generation = 0;
  return {
    offer(intent) {
      if (
        pendingIntent?.code === intent.code &&
        pendingIntent.relayUrl === intent.relayUrl
      ) {
        return "duplicate";
      }
      const result = pendingIntent === null ? "stored" : "replaced";
      pendingIntent = { code: intent.code, relayUrl: intent.relayUrl };
      generation += 1;
      return result;
    },
    pending() {
      return pendingIntent;
    },
    snapshot() {
      return { intent: pendingIntent, generation };
    },
    settle(intent) {
      if (
        pendingIntent?.code !== intent.code ||
        pendingIntent.relayUrl !== intent.relayUrl
      ) {
        return false;
      }
      pendingIntent = null;
      generation += 1;
      return true;
    },
  };
}

export function receiveShareHandoffArguments(
  rawArguments: readonly string[],
  slot: ShareHandoffIntentSlot,
): boolean {
  let accepted = false;
  for (const rawArgument of rawArguments) {
    const intent = parseShareHandoffUrl(rawArgument);
    if (intent === null) continue;
    slot.offer(intent);
    accepted = true;
  }
  return accepted;
}

export function focusShareHandoffWindow(window: ShareHandoffWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function focusShareHandoffWindowWhenReady(
  window: NewShareHandoffWindow,
): void {
  window.once("ready-to-show", () => focusShareHandoffWindow(window));
}

export function registerShareHandoffProtocol(
  registrar: ProtocolClientRegistrar,
  runtime: ProtocolRuntime,
): boolean {
  if (runtime.argv.includes("--dohc-isolated-test")) {
    const profiles = runtime.argv.filter((argument) => argument.startsWith("--user-data-dir="));
    if (profiles.length !== 1 || !isAbsolute(profiles[0]!.slice("--user-data-dir=".length))) {
      throw new Error("An isolated desktop test requires one absolute --user-data-dir path.");
    }
    // QA must not replace the installed app's OS-level share-link handler.
    return false;
  }
  if (runtime.defaultApp) {
    const appEntry = runtime.argv[1];
    if (!appEntry) return false;
    return registrar.setAsDefaultProtocolClient(
      SHARE_HANDOFF_SCHEME,
      runtime.execPath,
      [resolve(appEntry)],
    );
  }
  return registrar.setAsDefaultProtocolClient(SHARE_HANDOFF_SCHEME);
}
