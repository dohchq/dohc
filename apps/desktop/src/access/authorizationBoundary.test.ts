import { createRequire } from "node:module";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const forbidden = /\/access\/[^/]+\.ts$|\/workspaces\/receivedShareStore\.ts$/;
const entries = ["services/sync-relay/src/shareAuthorization.ts", "services/sync-relay/src/shareFilter.ts",
  "packages/app-backend-runtime/src/dataset-host.ts", "apps/desktop/src/workspaces/localDatasetHost.ts", "apps/desktop/src/workspaces/remoteDataset.ts",
  "apps/desktop/src/cli/cliServer.ts", "packages/mcp/src/server.ts", "apps/desktop/src/workspaces/shareWriteGate.ts",
  "apps/desktop/src/workspaces/receivedShareEngineAccess.ts", "apps/desktop/src/workspaces/shareViewInfo.ts",
  "apps/desktop/src/workspaces/shareViewFilesTarget.ts", "apps/desktop/src/workspaces/chatWrites.ts",
  "apps/desktop/src/workspaces/workspaceAuthorityOwner.ts", "apps/desktop/src/workspaces/engineCaptureGate.ts"];
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
      const candidates = specifier.endsWith(".js") ? [target.slice(0, -3) + ".ts", target.slice(0, -3) + ".tsx", target]
        : [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`];
      const found = candidates.find(path => existsSync(path) && statSync(path).isFile());
      if (!found) throw new Error(`Unresolved relative import ${specifier} in ${file}`);
      return [found];
    }
    if (specifier.startsWith("@dohc/")) {
      let found: string;
      try { found = createRequire(file).resolve(specifier); } catch { throw new Error(`Unresolved import ${specifier} in ${file}`); }
      if (!found.endsWith(".ts") && !found.endsWith(".tsx")) throw new Error(`Non-TypeScript import ${specifier} in ${file} resolved to ${found}`);
      return [found];
    }
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
it("walks through .js imports to deeper TypeScript authorization dependencies", () => {
  const deep = resolve(root, "packages/app-backend-runtime/src/dataset-read-result.ts");
  expect(violations(new Map([[deep, 'import "../../../apps/desktop/src/access/accessQuery.js";']]))).toHaveLength(1);
});
it.each(["access/accessQuery", "workspaces/receivedShareStore"])("detects a forbidden dependency through another package on %s", module => {
  const dependency = resolve(root, "packages/workspace-auth/src/session.ts");
  expect(violations(new Map([[dependency, `import "../../../apps/desktop/src/${module}";`]]))).toHaveLength(1);
});
it("refuses to skip an unresolved relative runtime import", () => {
  const entry = resolve(root, "packages/app-backend-runtime/src/dataset-host.ts");
  expect(() => violations(new Map([[entry, 'import "./missing-authority.js";']]))).toThrow("Unresolved relative import");
});
