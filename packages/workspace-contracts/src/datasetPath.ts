import { validateUserWritePath, stripWindowsAliasSuffix } from "./workspacePaths";

/** A relative source address, never an authorization grant. */
export function parseDatasetPath(value: unknown): string {
  const fail = () => { throw new Error("Use the caller-relative dataset.json path."); };
  if (typeof value !== "string" || value.length > 1024 || (value !== "dataset.json" && !value.endsWith("/dataset.json"))) return fail();
  const checked = validateUserWritePath(value);
  if (!checked.ok || checked.normalized !== value || value.split("/").some(part => stripWindowsAliasSuffix(part).toLowerCase() === ".env")) return fail();
  return value;
}
