import { phoneConnectAddress } from "@dohc/workspace-contracts/phone-connect";
import { checkServerAddress } from "../server/origin";

// Scanning a computer's Connect a phone code on Connect: what a scanned code's text means, which scan counts, and
// whether the phone may use its camera. Nothing here touches the camera, so tests can run it.

export type ScannedCode = { readonly origin: string } | { readonly problem: "insecure" | "invalid" };

/** A scanned code's server origin, under the rules for a typed address. Text without its scheme isn't a code a computer made. */
export function readScannedCode(text: string, options: { readonly developmentServer: boolean }): ScannedCode {
  const address = phoneConnectAddress(text);
  if (address === null) return { problem: "invalid" };
  const checked = checkServerAddress(address, options);
  return "origin" in checked ? checked : { problem: checked.problem === "insecure" ? "insecure" : "invalid" };
}

/**
 * Reads each code the camera reports until one holds a server address. The camera reports a code many times a second,
 * so after the first address every later report answers null.
 */
export function scanReader(options: { readonly developmentServer: boolean }): (text: string) => ScannedCode | null {
  let found = false;
  return text => {
    if (found) return null;
    const scanned = readScannedCode(text, options);
    if ("origin" in scanned) found = true;
    return scanned;
  };
}

/**
 * Holds a scanned origin until the scanner's sheet has gone. iOS can't present the approval page's browser from a
 * sheet still sliding away, so Connect starts only once the sheet is dismissed. A sheet closed without a scan holds
 * nothing, and each origin is taken once.
 */
export function pendingScan(): { hold(origin: string): void; take(): string | null } {
  let held: string | null = null;
  return {
    hold: origin => { held = origin; },
    take: () => {
      const origin = held;
      held = null;
      return origin;
    },
  };
}

/** What the camera's permission currently is, as expo-camera reports it. */
export interface CameraPermission {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}

export interface CameraPermissions {
  get(): Promise<CameraPermission>;
  request(): Promise<CameraPermission>;
}

/** Asks for the camera only when the phone may still ask; once the person has refused, only Settings can allow it. */
export async function cameraAccess(permissions: CameraPermissions): Promise<"granted" | "denied"> {
  const current = await permissions.get();
  if (current.granted) return "granted";
  if (!current.canAskAgain) return "denied";
  return (await permissions.request()).granted ? "granted" : "denied";
}
