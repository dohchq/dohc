import { isTemporaryMacAppPath } from "./agents/dohcMcpCommand";

const MOVE = 0;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Semver order of two versions: negative, zero or positive; null when either does not parse. */
export function compareAppVersions(left: string, right: string): number | null {
  const a = SEMVER.exec(left.trim());
  const b = SEMVER.exec(right.trim());
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  // A release outranks its prereleases.
  if (a[4] === undefined || b[4] === undefined) return (a[4] === undefined ? 1 : 0) - (b[4] === undefined ? 1 : 0);
  const leftParts = a[4].split(".");
  const rightParts = b[4].split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const x = leftParts[index];
    const y = rightParts[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/u;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x) !== numeric.test(y)) return numeric.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The version of the app at `appPath`: null only when nothing is there, and
 * "" when it cannot be read, such as when the path cannot be checked.
 */
export async function installedAppVersion(
  appPath: string,
  deps: { lstat(path: string): Promise<unknown>; readVersion(appPath: string): Promise<string> },
): Promise<string | null> {
  try {
    await deps.lstat(appPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "";
  }
  return deps.readVersion(appPath).then((version) => version.trim(), () => "");
}

/** Why dohc must not replace the dohc in Applications, or null when it may. */
export function moveRefusal(runningVersion: string, installed: string | null): string | null {
  if (installed === null) return null;
  if (installed === "") return "dohc cannot read the version of the dohc already in Applications. Open that copy, or replace it in Finder.";
  return (compareAppVersions(runningVersion, installed) ?? 0) > 0
    ? null
    : `Applications already has dohc ${installed}. Open that copy instead.`;
}

/**
 * Moves dohc to Applications, reading the dohc already there right before
 * the move, so neither the first move nor a Try again replaces a copy as new
 * or newer. Rejects with why it did not move.
 */
export async function guardedMoveToApplications(deps: {
  runningVersion: string;
  // The version of the app of this bundle's name in Applications: null when
  // there is none, and "" when it cannot be read.
  installedVersion(): Promise<string | null>;
  move(): void;
}): Promise<void> {
  const refusal = moveRefusal(deps.runningVersion, await deps.installedVersion());
  if (refusal) throw new Error(refusal);
  deps.move();
}

/**
 * Offers once to move a packaged macOS dohc that runs outside Applications,
 * such as from its disk image or Downloads. Electron's move asks nothing
 * itself: this question is the person's only say. A decline is remembered.
 * Nothing is offered when Applications already holds this version of dohc
 * or a newer one, or one whose version cannot be read. `move` is the guarded
 * move, which checks again. After a move, Electron quits dohc and opens the
 * moved copy.
 */
export async function offerMoveToApplications(deps: {
  bundlePath: string;
  runningVersion: string;
  isInApplicationsFolder(): boolean;
  declined(): boolean;
  recordDecline(): void;
  installedVersion(): Promise<string | null>;
  showMessageBox(options: {
    type: "question";
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
  }): Promise<{ response: number }>;
  move(): Promise<void>;
  reportMoveFailure(error: unknown): void;
}): Promise<void> {
  if (deps.isInApplicationsFolder() || deps.declined()) return;
  const installed = await deps.installedVersion();
  if (moveRefusal(deps.runningVersion, installed) !== null) return;
  const { response } = await deps.showMessageBox({
    type: "question",
    message: "Move dohc to Applications?",
    detail: [
      ...(isTemporaryMacAppPath(deps.bundlePath) ? ["dohc is running from a disk image or a temporary copy."] : []),
      "dohc moves itself to Applications and opens again.",
      ...(installed !== null ? [`It replaces the older dohc ${installed} already there.`] : []),
    ].join(" "),
    buttons: ["Move to Applications", "Don't move"],
    defaultId: MOVE,
    cancelId: 1,
    noLink: true,
  });
  if (response !== MOVE) {
    deps.recordDecline();
    return;
  }
  try {
    await deps.move();
  } catch (error) {
    deps.reportMoveFailure(error);
  }
}
