import { createRequire } from "node:module";
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
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
// packages/app-backend-runtime/scripts/build.mjs lists these entryPoints,
// writes to dist, and sets outExtension to { ".js": ".mjs" }.
const runtimeBuildSources: Record<string, string> = {
  "./dist/automation-worker.mjs": "./src/automation-worker.ts",
  "./dist/child.mjs": "./src/child.ts",
  "./dist/persistent-child.mjs": "./src/persistent-child.ts",
};
function workspaceSource(specifier: string, file: string): string {
  const require = createRequire(file);
  const [scope, name, ...subpath] = specifier.split("/");
  const packageName = `${scope}/${name}`;
  const manifest = require.resolve.paths(packageName)?.map(path => resolve(path, packageName, "package.json")).find(existsSync);
  if (!manifest) throw new Error(`Unresolved import ${specifier} in ${file}`);
  const packageRoot = dirname(realpathSync(manifest));
  const exported = JSON.parse(readFileSync(manifest, "utf8")).exports[subpath.length ? `./${subpath.join("/")}` : "."];
  const types = typeof exported === "object" ? exported?.types : undefined;
  let found: string;
  if (typeof types === "string" && /\.tsx?$/.test(types)) found = resolve(packageRoot, types);
  else if (packageName === "@dohc/app-backend-runtime" && typeof exported === "string" && runtimeBuildSources[exported]) {
    found = resolve(packageRoot, runtimeBuildSources[exported]);
  } else {
    try { found = require.resolve(specifier); } catch { throw new Error(`Unresolved import ${specifier} in ${file}`); }
  }
  if (!found.endsWith(".ts") && !found.endsWith(".tsx")) throw new Error(`Non-TypeScript import ${specifier} in ${file} resolved to ${found}`);
  if (!existsSync(found)) throw new Error(`Unresolved import ${specifier} in ${file}`);
  return found;
}
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
      return [workspaceSource(specifier, file)];
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

it("follows typed and build-only runtime package exports into their dependencies", () => {
  const entry = resolve(root, "apps/desktop/src/workspaces/remoteDataset.ts");
  const runtime = resolve(root, "packages/app-backend-runtime/src/persistent.ts");
  const child = resolve(root, "packages/app-backend-runtime/src/persistent-child.ts");
  const blocked = resolve(root, "apps/desktop/src/access/accessQuery.ts");
  expect(imports(entry, 'import "@dohc/app-backend-runtime/persistent";')).toEqual([runtime]);
  expect(violations(new Map([
    [entry, 'import "@dohc/app-backend-runtime/persistent";'],
    [runtime, 'import "@dohc/app-backend-runtime/persistent-child";'],
    [child, 'import "../../../apps/desktop/src/access/accessQuery";'],
  ]))).toEqual([blocked]);
});
