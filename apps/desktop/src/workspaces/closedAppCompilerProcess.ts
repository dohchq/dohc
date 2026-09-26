import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";
import { APP_BUNDLE_CONTENT_TYPES } from "@dohc/app-browser/document";
import { CompilerProcessError, runOwnedCompilerProcess, type CompilerProcessBounds, type CompilerProcessRuntime } from "./compilerProcessSupervisor.ts";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const digest = (domain: string, value: unknown) => sha256(JSON.stringify([domain, value]));
const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Runtime paths are installed dohc assets, never fields from an app manifest. */
export async function compileClosedAppInProcess(
  runtime: Pick<CompilerProcessRuntime, "nodeExecutable" | "workerPath" | "onOwnerSpawn">,
  request: ClosedAppBuildRequest,
  bounds: CompilerProcessBounds,
  signal?: AbortSignal,
): Promise<ClosedAppBuild> {
  if (signal?.aborted) throw new CompilerProcessError("cancelled", "Compiler cancelled.");
  const processBounds = { ...bounds };
  const limit = request.bounds.maxInputBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(request.bounds.maxInputFiles) || request.bounds.maxInputFiles < 1 ||
      !Array.isArray(request.inputs) || request.inputs.length > request.bounds.maxInputFiles) throw new Error("Invalid app input bounds.");
  if (Buffer.byteLength(request.entryPath) > limit) throw new Error("App entry bound exceeded.");
  let inputBytes = 0;
  const packageMap: Record<string, string> = {};
  const entries = Object.entries(request.packageMap ?? {});
  if (entries.length > request.bounds.maxInputFiles) throw new Error("App package map bound exceeded.");
  for (const [name, path] of entries) {
    inputBytes += Buffer.byteLength(name) + Buffer.byteLength(path);
    if (inputBytes > limit) throw new Error("App input bound exceeded.");
    Object.defineProperty(packageMap, name, { value: path, enumerable: true });
  }
  const inputs = request.inputs.map(file => {
    if (!(file.bytes instanceof Uint8Array)) throw new Error("Invalid app input bytes.");
    inputBytes += file.bytes.byteLength + Buffer.byteLength(file.path);
    if (inputBytes > limit) throw new Error("App input bound exceeded.");
    const bytes = Buffer.from(file.bytes);
    if (sha256(bytes) !== file.sha256) throw new Error("App input digest mismatch.");
    return { path: file.path, sha256: file.sha256, bytes: bytes.toString("base64") };
  });
  // Capture caller-owned bytes and metadata before the first await.
  const input = Buffer.from(JSON.stringify({ entryPath: request.entryPath, packageMap, bounds: { ...request.bounds }, inputs }));
  const inventory = inputs.map(file => ({ path: file.path, sha256: file.sha256, byteLength: Buffer.from(file.bytes, "base64").byteLength })).sort((a, b) => ordered(a.path, b.path));
  const sourceDigest = digest("dohc-app-source-v2", { entry: request.entryPath, files: inventory, packages: Object.entries(packageMap).sort(([a], [b]) => ordered(a, b)) });
  const entryPath = request.entryPath;
  const outputLimit = request.bounds.maxOutputBytes;
  const capturedRuntime = { ...runtime, workerArgs: [String(processBounds.maxInputBytes), String(processBounds.maxOutputBytes)] };
  const require = createRequire(import.meta.url);
  const compilerRequire = createRequire(require.resolve("esbuild"));
  const version = compilerRequire("esbuild/package.json").version;
  if (version !== "0.28.1") throw new Error("Unsupported app compiler installation.");
  const binary = compilerRequire.resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`);
  const compiler = { recipe: "dohc-closed-app-v3" as const, version, binarySha256: sha256(await readFile(binary)) };
  const result = await runOwnedCompilerProcess(capturedRuntime, { input, bounds: processBounds, signal });
  const wire = JSON.parse(Buffer.from(result.stdout).toString("utf8"));
  if (!wire || !Array.isArray(wire.files) || wire.files.length < 1 || wire.files.length > 3 || !Array.isArray(wire.dependencyLock) || wire.dependencyLock.length > inventory.length) throw new Error("Invalid compiler response.");
  const seen = new Set<string>();let outputBytes = 0;
  const files: ClosedAppBuild["files"] = wire.files.map((file: Record<string, unknown>) => {
    if (typeof file?.path !== "string" || !Object.hasOwn(APP_BUNDLE_CONTENT_TYPES, file.path)) throw new Error("Invalid compiler output path.");
    if (seen.has(file.path)) throw new Error("Duplicate compiler output.");seen.add(file.path);
    const contentType = APP_BUNDLE_CONTENT_TYPES[file.path]!;
    if (file.contentType !== contentType) throw new Error("Invalid compiler output type.");
    if (typeof file.bytes !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.bytes)) throw new Error("Invalid compiler file bytes.");
    const bytes = Buffer.from(file.bytes, "base64");
    outputBytes += bytes.byteLength;
    if (outputBytes > outputLimit || bytes.byteLength !== file.byteLength || sha256(bytes) !== file.sha256) throw new Error("Compiler output identity mismatch.");
    return { path: file.path, bytes, sha256: sha256(bytes), byteLength: bytes.byteLength, contentType };
  }).sort((a: {path: string}, b: {path: string}) => ordered(a.path, b.path));
  if (!seen.has("bundle.js")) throw new Error("Compiler script output missing.");
  const byPath = new Map(inventory.map(file => [file.path, file]));const used = new Set<string>();
  const dependencyLock: ClosedAppBuild["dependencyLock"] = wire.dependencyLock.map((file: {path: string;sha256: string;byteLength: number}) => {
    const expected = byPath.get(file?.path);
    if (!expected || used.has(file.path) || file.sha256 !== expected.sha256 || file.byteLength !== expected.byteLength) throw new Error("Invalid compiler dependency identity.");
    used.add(file.path);return expected;
  }).sort((a: {path: string}, b: {path: string}) => ordered(a.path, b.path));
  if (!used.has(entryPath)) throw new Error("Compiler entry dependency missing.");
  const dependencyLockDigest = digest("dohc-app-dependencies-v1", dependencyLock);
  const bundleDigest = digest("dohc-app-bundle-v1", files.map(({bytes: _, ...file}) => file));
  const buildDigest = digest("dohc-app-build-v1", {sourceDigest,dependencyLockDigest,compiler,bundleDigest});
  if (wire.sourceDigest !== sourceDigest || wire.dependencyLockDigest !== dependencyLockDigest || wire.bundleDigest !== bundleDigest || wire.buildDigest !== buildDigest ||
      wire.compiler?.recipe !== compiler.recipe || wire.compiler?.version !== compiler.version || wire.compiler?.binarySha256 !== compiler.binarySha256) throw new Error("Compiler build identity mismatch.");
  return { sourceDigest, dependencyLock, dependencyLockDigest, compiler, files, bundleDigest, buildDigest };
}
