import { createRequire } from "node:module";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../.."), require = createRequire(resolve(root, "apps/desktop/package.json"));
const forbidden = /\/access\/[^/]+\.ts$|\/workspaces\/receivedShareStore\.ts$/;
const entries = ["services/sync-relay/src/shareAuthorization.ts", "services/sync-relay/src/shareFilter.ts",
  "packages/app-backend-runtime/src/dataset-host.ts", "apps/desktop/src/workspaces/localDatasetHost.ts", "apps/desktop/src/workspaces/remoteDataset.ts"];
function imports(file: string, source: string): string[] {
  const specifiers = [
    ...source.matchAll(/(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
  ];
  return specifiers.flatMap(match => {
    const specifier = match[1]!;
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(file), specifier);
      return [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`].filter(path => existsSync(path) && statSync(path).isFile()).slice(0, 1);
    }
    if (specifier.startsWith("@dohc/")) { try { return [require.resolve(specifier)]; } catch { throw new Error(`Unresolved import ${specifier}`); } }
    return [];
  });
}
function violations(overrides = new Map<string, string>()): string[] {
  const pending = entries.map(path => resolve(root, path)), seen = new Set<string>(), violations: string[] = [];
  while (pending.length) {
    const file = pending.pop()!; if (seen.has(file)) continue; seen.add(file);
    if (forbidden.test(file.replaceAll("\\", "/"))) { violations.push(file); continue; }
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    pending.push(...imports(file, overrides.get(file) ?? readFileSync(file, "utf8")));
  }
  return violations;
}
it("keeps the runtime authorization import closure independent of Access projections and received inventory", () => {
  expect(violations()).toEqual([]);
});
it.each(["access/accessQuery", "workspaces/receivedShareStore"])("detects an indirect authorization dependency on %s", module => {
  const entry = resolve(root, "apps/desktop/src/workspaces/remoteDataset.ts");
  const specifier = module.startsWith("access/") ? `../${module}` : `./${module.slice("workspaces/".length)}`;
  expect(violations(new Map([[entry, `import { forbidden } from "${specifier}";`]]))).toHaveLength(1);
});
it.each(['import "../access/accessOwner";', 'import("../access/accessOwner")', 'require("../access/accessOwner")'])("detects runtime dependencies through %s", source => {
  const entry = resolve(root, "apps/desktop/src/workspaces/remoteDataset.ts");
  expect(violations(new Map([[entry, source]]))).toHaveLength(1);
});
