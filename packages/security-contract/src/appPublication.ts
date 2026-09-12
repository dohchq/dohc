import { validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "./enginePathFloor";
import { SHA256_HEX_PATTERN } from "./wirePatterns";
import { parseAppCollectionCapability, type AppCollectionCapability } from "./appCollection";
export { parseAppCollectionCapability, type AppCollectionCapability } from "./appCollection";

/** Publication transport ceilings shared by desktop, relay, and browser launch. */
export const APP_PUBLICATION_MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
export const APP_PUBLICATION_MAX_METADATA_BYTES = 220 * 1024;
export const APP_PUBLICATION_MAX_DOCUMENT_BYTES = APP_PUBLICATION_MAX_BUNDLE_BYTES * 6 + 64 * 1024;

export interface AppPublicationLimits { maxFiles: number; maxMetadataBytes: number; maxBundleBytes: number }
export interface AppPublicationFile { path: string; sha256: string; byteLength: number }
export interface AppPublicationCandidate {
  versionId: string;
  appRoot: string;
  entryPath: string;
  packageMap: Record<string, string>;
  sourceRevision: string;
  sourceDigest: string;
  dependencyLockDigest: string;
  bundleDigest: string;
  buildDigest: string;
  compilerIdentity: { recipe: string; version: string; binarySha256: string };
  inputs: AppPublicationFile[];
  dependencies: string[];
  files: Array<AppPublicationFile & { contentType: string }>;
  capabilities: AppCollectionCapability[];
}
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("Invalid publication record.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.includes("\0") || bytes(value) > max) throw new Error("Invalid publication text.");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !SHA256_HEX_PATTERN.test(value)) throw new Error("Invalid publication digest.");
  return value;
}
function size(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid publication byte length.");
  return value;
}
function path(value: unknown, max: number): string {
  const raw = text(value, max), checked = validateUserWritePath(raw);
  if (!checked.ok || checked.normalized !== raw || classifyEngineFilePath(raw).kind !== "tracked") throw new Error("Invalid publication source path.");
  return raw;
}
/** Fixed compiled bundles with at most one bounded create-only collection. */
export function parseAppPublicationCandidate(value: unknown, limits: AppPublicationLimits): AppPublicationCandidate {
  if (!limits || typeof limits !== "object" ||
      !Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 ||
      !Number.isSafeInteger(limits.maxMetadataBytes) || limits.maxMetadataBytes < 1 ||
      !Number.isSafeInteger(limits.maxBundleBytes) || limits.maxBundleBytes < 1) {
    throw new Error("Invalid publication limits.");
  }
  const row = object(value, ["versionId", "appRoot", "entryPath", "packageMap", "sourceRevision", "sourceDigest", "dependencyLockDigest", "bundleDigest", "buildDigest", "compilerIdentity", "inputs", "dependencies", "files", "capabilities"]);
  if (!Array.isArray(row.inputs) || row.inputs.length < 1 || row.inputs.length > limits.maxFiles ||
      row.inputs.length > limits.maxMetadataBytes ||
      !Array.isArray(row.dependencies) || row.dependencies.length < 1 || row.dependencies.length > row.inputs.length ||
      !Array.isArray(row.files) || row.files.length < 1 || row.files.length > 2 ||
      !Array.isArray(row.capabilities) || row.capabilities.length > 1) throw new Error("Unsupported publication inventory or capabilities.");
  let remainingTextBytes = limits.maxMetadataBytes;
  const readText = (value: unknown): string => {
    const result = text(value, remainingTextBytes);
    remainingTextBytes -= bytes(result);
    return result;
  };
  const readPath = (value: unknown) => path(readText(value), limits.maxMetadataBytes);
  const appRoot = readPath(row.appRoot);
  const seen = new Set<string>();
  const inputs = row.inputs.map(value => {
    const file = object(value, ["path", "sha256", "byteLength"]);
    const filePath = readPath(file.path);
    if (seen.has(filePath)) throw new Error("Publication input is duplicated.");
    seen.add(filePath);
    return { path: filePath, sha256: hash(file.sha256), byteLength: size(file.byteLength) };
  }).sort((a, b) => compare(a.path, b.path));
  const dependencies = row.dependencies.map(readPath).sort(compare);
  if (new Set(dependencies).size !== dependencies.length || dependencies.some(path => !seen.has(path))) throw new Error("Invalid publication dependency.");
  const entryPath = readPath(row.entryPath);
  if (!dependencies.includes(entryPath)) throw new Error("Publication entry dependency is missing.");
  if (!row.packageMap || typeof row.packageMap !== "object" || Array.isArray(row.packageMap)) throw new Error("Invalid publication package map.");
  const entries = Object.entries(row.packageMap);
  if (entries.length > limits.maxFiles) throw new Error("Publication package map bound exceeded.");
  const packageMap = Object.fromEntries(entries.map(([name, value]) => {
    readText(name);
    const target = readPath(value);
    if (!seen.has(target)) throw new Error("Publication package is outside selected inputs.");
    return [name, target] as const;
  }).sort(([a], [b]) => compare(a, b)));
  const outputs = new Set<string>();let total = 0;
  const files = row.files.map(value => {
    const file = object(value, ["path", "sha256", "byteLength", "contentType"]);
    if (file.path !== "bundle.js" && file.path !== "bundle.css") throw new Error("Unsupported publication bundle path.");
    const contentType = file.path === "bundle.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
    if (file.contentType !== contentType || outputs.has(file.path)) throw new Error("Invalid publication bundle type or duplicate.");
    outputs.add(file.path);const byteLength = size(file.byteLength);total += byteLength;
    if (!Number.isSafeInteger(total) || total > limits.maxBundleBytes) throw new Error("Publication bundle bound exceeded.");
    return { path: file.path, sha256: hash(file.sha256), byteLength, contentType };
  }).sort((a, b) => compare(a.path, b.path));
  if (!outputs.has("bundle.js")) throw new Error("Publication script is missing.");
  const compiler = object(row.compilerIdentity, ["recipe", "version", "binarySha256"]);
  const candidate: AppPublicationCandidate = {
    versionId: readText(row.versionId), appRoot, entryPath, packageMap,
    sourceRevision: hash(row.sourceRevision), sourceDigest: hash(row.sourceDigest),
    dependencyLockDigest: hash(row.dependencyLockDigest), bundleDigest: hash(row.bundleDigest), buildDigest: hash(row.buildDigest),
    compilerIdentity: { recipe: readText(compiler.recipe), version: readText(compiler.version), binarySha256: hash(compiler.binarySha256) },
    inputs, dependencies, files, capabilities: row.capabilities.map(parseAppCollectionCapability),
  };
  if (bytes(JSON.stringify(candidate)) > limits.maxMetadataBytes) throw new Error("Publication metadata bound exceeded.");
  return candidate;
}
