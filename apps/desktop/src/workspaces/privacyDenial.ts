import { accessSync, constants } from "node:fs";
import { opendir } from "node:fs/promises";
import { PRIVACY_DENIED } from "../ipc/errorWords";

// macOS refuses dohc a folder the person has not allowed in Privacy &
// Security, such as Documents or a removable volume, with EPERM, and the
// refusal covers reads. A file locked in Finder also fails writes with EPERM,
// but it still reads, so an error that names a readable path is not a
// privacy refusal. Ordinary file permissions fail with EACCES.

function errnoOf(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, "code") : undefined;
}

/** Whether a file system error is macOS refusing dohc a folder. */
export function isPrivacyDenial(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin" || !(error instanceof Error)) return false;
  // A worker hands back only the message, which still leads with the code.
  if (errnoOf(error) !== "EPERM" && !error.message.startsWith("EPERM:")) return false;
  const path: unknown = Reflect.get(error, "path");
  if (typeof path !== "string") return true;
  try {
    accessSync(path, constants.R_OK);
    return false;
  } catch (cause) {
    return errnoOf(cause) === "EPERM";
  }
}

/** The error with the privacy code the renderer explains, or the error itself. */
export function withPrivacyDenial(error: unknown, platform: NodeJS.Platform = process.platform): unknown {
  return isPrivacyDenial(error, platform)
    ? Object.assign(new Error((error as Error).message, { cause: error }), { code: PRIVACY_DENIED })
    : error;
}

/**
 * Fails an open whose root macOS refuses, since every file and engine call in
 * it would fail. Anything else the root answers is left to the open.
 */
export async function assertRootNotPrivacyDenied(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "darwin") return;
  try {
    await (await opendir(rootPath)).close();
  } catch (error) {
    if (isPrivacyDenial(error, platform)) throw error;
  }
}
