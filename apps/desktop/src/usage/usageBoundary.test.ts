import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const store = realpathSync(join(root, "apps/desktop/src/usage/usageStore.ts"));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", "dist", ".git", ".agent-artifacts", ".dohc-dev"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}
function resolveImport(value: string, path: string): string | undefined {
  let base: string;
  if (value.startsWith(".")) base = resolve(dirname(path), value);
  else if (value.startsWith("@dohc/")) {
    const [name, ...subpath] = value.slice(6).split("/");
    const packages = [join(root, "packages", name!), join(root, "services", name!), join(root, "apps", name!)];
    const directory = packages.find(candidate => existsSync(join(candidate, "package.json")));
    if (!directory) return;
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { exports?: Record<string, unknown>; main?: string };
    const target = manifest.exports?.[subpath.length ? "./" + subpath.join("/") : "."];
    function entry(input: unknown): string | undefined {
      if (typeof input === "string") return input;
      if (input && typeof input === "object") {
        const object = input as Record<string, unknown>;
        return entry(object.types) ?? entry(object.import) ?? entry(object.default);
      }
    }
    const exportPath = entry(target) ?? (subpath.length ? "src/" + subpath.join("/") : manifest.main ?? "src/index.ts");
    base = resolve(directory, exportPath);
  } else return;
  return [base, ...(/\.[cm]?jsx?$/.test(base) ? [base.replace(/\.[cm]?jsx?$/, ".ts"), base.replace(/\.[cm]?jsx?$/, ".tsx")] : []), ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"].flatMap(extension => [base + extension, join(base, "index" + extension)])]
    .find(candidate => existsSync(candidate) && statSync(candidate).isFile());
}
function imports(path: string): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return [];
  const source = parse(readFileSync(path, "utf8"), { sourceFilename: path, sourceType: "unambiguous", plugins: /\.[jt]sx$/.test(path) ? ["typescript", "jsx"] : ["typescript"], errorRecovery: true });
  const values: string[] = [];
  function visit(input: unknown) {
    if (!input || typeof input !== "object") return;
    if (Array.isArray(input)) { for (const node of input) visit(node); return; }
    const node = input as Record<string, unknown>;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(String(node.type))) {
      const specifier = node.source as { value?: unknown } | undefined;
      if (typeof specifier?.value === "string") values.push(specifier.value);
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as { type?: string; name?: string };
      if (callee.type === "Import" || callee.type === "Identifier" && callee.name === "require") {
        const first = (node.arguments as { value?: unknown }[])[0];
        if (typeof first?.value === "string") values.push(first.value);
      }
    }
    for (const [key, value] of Object.entries(node)) if (!["loc", "tokens", "comments", "errors"].includes(key)) visit(value);
  }
  visit(source);
  return values.flatMap(value => {
    const found = resolveImport(value, path);
    if (!found) return [];
    const target = realpathSync(found);
    const local = relative(root, target);
    return local.startsWith("..") || local.split(/[\\/]/).includes("node_modules") ? [] : [target];
  });
}

describe("usage import boundary", () => {
  it("keeps the collector unreachable from CLI, MCP, every service and preload", () => {
    const entries = [
      ...sources(join(root, "packages/cli")), ...sources(join(root, "packages/mcp")),
      ...sources(join(root, "services")), join(root, "apps/desktop/src/preload.ts"),
    ];
    const checked = new Set<string>();
    function inspect(path: string, chain: string[]) {
      expect(path, chain.map(file => relative(root, file)).join(" -> ")).not.toBe(store);
      if (checked.has(path)) return;
      checked.add(path);
      let dependencies: string[];
      try { dependencies = imports(path); } catch (error) { throw new Error(`Cannot inspect ${path}`, { cause: error }); }
      for (const dependency of dependencies) inspect(dependency, [...chain, dependency]);
    }
    for (const entry of entries) inspect(realpathSync(entry), [entry]);
    expect(checked.size).toBeGreaterThan(entries.length);
  }, 60_000);

  it("wires one deferred startup load with stateDir and orderly shutdown in main", () => {
    const main = readFileSync(join(root, "apps/desktop/src/main.ts"), "utf8");
    expect(main).toContain("createUsageStore({ stateDir, appVersion: app.getVersion(), coverage: RENDERER_USAGE_COVERAGE })");
    const markReady = main.slice(main.indexOf("markReady: () =>"), main.indexOf("startEngine: () =>"));
    expect(markReady).toContain("usageLoad = setImmediate(() => {");
    expect(markReady).toContain("usageStore = createUsageStore({ stateDir, appVersion: app.getVersion(), coverage: RENDERER_USAGE_COVERAGE });");
    expect(main.slice(0, main.indexOf("markReady: () =>"))).not.toMatch(/createUsageStore\(\{/);
    expect(main.match(/usageStore\.load\(/g)).toHaveLength(1);
    expect(markReady).not.toMatch(/if\s*\(/);
    expect(main).toContain("await usageStore?.close().catch(() => {});");
    for (const group of ["version", "crash", "notice"]) {
      expect(main).toContain(`rendererUsage.${group});`);
    }
    expect(main).not.toContain("rendererUsage.search");
    expect(main).not.toContain("rendererUsage.dispatch");
    expect(main).toContain("if (usageLoad) clearImmediate(usageLoad);");
    // Privacy has no counting observer or agent transport registration.
    const usage = readFileSync(join(root, "apps/desktop/src/usage/rendererUsage.ts"), "utf8");
    expect(usage).not.toMatch(/usage\.(read|query|copy)/);
  });
});
