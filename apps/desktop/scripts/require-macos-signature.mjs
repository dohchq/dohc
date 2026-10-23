import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const developerIDRequirement = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";

/** mac.sign can suppress identity errors; afterSign also runs when it was skipped. */
export default async function requireMacOSSignature(context, { run: codesign = run } = {}) {
  if (context.electronPlatformName !== "darwin" || !context.packager.forceCodeSigning) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    await codesign("/usr/bin/codesign", ["--verify", "--strict", `-R=${developerIDRequirement}`, app]);
  } catch (cause) {
    throw new Error("Required macOS signing did not produce a valid Apple Developer ID Application signature.", { cause });
  }
}
