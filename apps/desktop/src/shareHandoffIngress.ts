import { resolve } from "node:path";

const SHARE_HANDOFF_SCHEME = "dohc";
const SHARE_HANDOFF_URL_PATTERN =
  /^dohc:\/\/open\/([A-Za-z0-9_-]{43})$/;

declare const shareHandoffCodeBrand: unique symbol;
export type ShareHandoffCode = string & {
  readonly [shareHandoffCodeBrand]: true;
};
export type ShareHandoffOfferResult = "stored" | "duplicate" | "replaced";

export interface ShareHandoffIntentSnapshot {
  code: ShareHandoffCode | null;
  generation: number;
}

export interface ShareHandoffIntentSlot {
  offer(code: ShareHandoffCode): ShareHandoffOfferResult;
  pending(): ShareHandoffCode | null;
  snapshot(): ShareHandoffIntentSnapshot;
  settle(code: ShareHandoffCode): boolean;
}

export interface ShareHandoffWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
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

export function parseShareHandoffUrl(rawArgument: string): ShareHandoffCode | null {
  const match = SHARE_HANDOFF_URL_PATTERN.exec(rawArgument);
  if (match?.[0] !== rawArgument) return null;
  return (match?.[1] as ShareHandoffCode | undefined) ?? null;
}

export function createShareHandoffIntentSlot(): ShareHandoffIntentSlot {
  let pendingCode: ShareHandoffCode | null = null;
  let generation = 0;
  return {
    offer(code) {
      if (pendingCode === code) return "duplicate";
      const result = pendingCode === null ? "stored" : "replaced";
      pendingCode = code;
      generation += 1;
      return result;
    },
    pending() {
      return pendingCode;
    },
    snapshot() {
      return { code: pendingCode, generation };
    },
    settle(code) {
      if (pendingCode !== code) return false;
      pendingCode = null;
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
    const code = parseShareHandoffUrl(rawArgument);
    if (code === null) continue;
    slot.offer(code);
    accepted = true;
  }
  return accepted;
}

export function focusShareHandoffWindow(window: ShareHandoffWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function registerShareHandoffProtocol(
  registrar: ProtocolClientRegistrar,
  runtime: ProtocolRuntime,
): boolean {
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
