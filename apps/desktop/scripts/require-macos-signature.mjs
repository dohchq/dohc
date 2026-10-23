import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** mac.sign can suppress identity errors; afterSign also runs when it was skipped. */
export default async function requireMacOSSignature(context, { run: codesign = run } = {}) {
  if (context.electronPlatformName !== "darwin" || !context.packager.forceCodeSigning) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await codesign("/usr/bin/codesign", ["--verify", "--strict", app]);
  const { stderr } = await codesign("/usr/bin/codesign", ["--display", "--verbose=2", app]);
  if (!/^Authority=Developer ID Application: .+$/m.test(stderr)) {
    throw new Error("Required macOS signing did not produce a Developer ID Application signature.");
  }
}
