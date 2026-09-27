import { isAbsolute, resolve } from "node:path";
import {
  DOHC_DEEP_LINK_SCHEME,
  parseShareHandoffUrl,
  type ShareHandoffIntent,
} from "@dohc/workspace-contracts/deep-links";

const SHARE_HANDOFF_PROTOCOL_PATTERN = /^dohc:/iu;

export type ShareHandoffOfferResult = "stored" | "duplicate" | "replaced";
export type ShareHandoffArgumentIntent = "plain" | "accepted" | "rejected";

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
      DOHC_DEEP_LINK_SCHEME,
      runtime.execPath,
      [resolve(appEntry)],
    );
  }
  return registrar.setAsDefaultProtocolClient(DOHC_DEEP_LINK_SCHEME);
}
