import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative } from "node:path";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const productionInputs = { "@dohc/site": ["@dohc/desktop"] };
// These inputs include ordinary tests and separate native/browser proofs.
// Test consumers do not become changed production packages themselves.
const testInputs = {
  // The onboarding fixture imports the API harness, which reads Postgres SQL.
  "@dohc/desktop": ["@dohc/site", "@dohc/workspace-api", "@dohc/workspace-postgres", "@dohc/share-web"],
  "@dohc/workspace-auth": ["@dohc/workspace-postgres"],
  "@dohc/ydoc-projection": ["@dohc/sync-relay", "@dohc/workspace-engine-client", "@dohc/share-web", "@dohc/desktop"],
  "@dohc/share-web": ["@dohc/desktop", "@dohc/mcp", "@dohc/cli", "@dohc/workspace-postgres", "@dohc/workspace-engine-client"],
  "@dohc/sync-relay": ["@dohc/share-web", "@dohc/desktop"],
  "@dohc/workspace-api": ["@dohc/workspace-postgres"],
};
// External consumers can select compatibility files. A production change in
// the consumer or an input without a file map still selects its complete suite.
const externalTestFiles = {
  "@dohc/desktop": {
    "@dohc/site": ["src/renderer/workbench/ChatLane.test.tsx", "src/renderer/workbench/ProductDemo.test.tsx"],
  },
  "@dohc/ydoc-projection": {
    "@dohc/desktop": ["src/liveRestoreDrain.test.ts", "src/ownerDesktopTransport.test.ts"],
  },
};
const databasePackages = new Set(["@dohc/workspace-postgres", "@dohc/workspace-auth", "@dohc/workspace-api", "@dohc/share-web"]);

export function readWorkspacePackages(root) {
  const workspace = require("js-yaml").load(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
  if (!Array.isArray(workspace?.packages) || !workspace.packages.length || workspace.packages.some(pattern => typeof pattern !== "string")) {
    throw new Error("pnpm-workspace.yaml must declare workspace package patterns.");
  }
  const patterns = workspace.packages.filter(pattern => !pattern.startsWith("!")).map(pattern => `${pattern.replace(/\/$/u, "")}/package.json`);
  const exclude = ["**/node_modules/**", ...workspace.packages.filter(pattern => pattern.startsWith("!")).map(pattern => `${pattern.slice(1).replace(/\/$/u, "")}/**`)];
  const names = new Set();
  return [...globSync(patterns, { cwd: root, exclude })].map(path => {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (!manifest.name || names.has(manifest.name)) throw new Error(`Missing or duplicate workspace package name: ${path}`);
    names.add(manifest.name);
    return { name: manifest.name, path: relative(root, join(root, dirname(path))).replaceAll("\\", "/"), manifest };
  }).filter(pkg => pkg.path !== "").sort((a, b) => a.name.localeCompare(b.name));
}

function dependencies(pkg) {
  return new Set(dependencyFields.flatMap(field => Object.keys(pkg.manifest[field] ?? {})));
}

function owner(path, packages) {
  return packages.filter(pkg => path === pkg.path || path.startsWith(pkg.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function sharedInput(path) {
  // Examples feed desktop staging, relay compiler tests, and runtime tests.
  // Native fixtures and goldens are also imported directly by JavaScript tests.
  return /^(?:crates|vendor|scripts|tools|examples|patches|\.cargo|\.config|\.github)\//u.test(path)
    || /(?:^|\/)package\.json$/u.test(path)
    || /(?:^|\/)(?:tsconfig[^/]*\.json|[^/]+\.config\.[^/]+|\.env(?:\.[^/]*)?)$/u.test(path)
    || /^apps\/desktop\/scripts\//u.test(path);
}

function result(selected, affected, full, reason) {
  const testFiles = {};
  if (!full) for (const name of selected) {
    if (affected.has(name)) continue;
    const inputs = testInputs[name]?.filter(input => affected.has(input)) ?? [];
    if (inputs.length && inputs.every(input => externalTestFiles[name]?.[input])) {
      testFiles[name] = [...new Set(inputs.flatMap(input => externalTestFiles[name][input]))].sort();
    }
  }
  const desktopScripts = selected.has("@dohc/desktop") && !testFiles["@dohc/desktop"];
  const proofs = {
    accounts: selected.has("@dohc/workspace-api"),
    selfHostNative: selected.has("@dohc/share-web"),
    desktop: desktopScripts,
  };
  return {
    packages: [...selected].sort(), affected: [...affected].sort(), full, reason, proofs, testFiles, desktopScripts,
    repository: full ? "full" : "source",
    needs: {
      postgres: proofs.desktop || proofs.selfHostNative || [...selected].some(name => databasePackages.has(name)),
      engine: proofs.desktop || proofs.selfHostNative,
      desktop: proofs.desktop,
    },
  };
}

export function selectJavaScript(files, packages, { full = false } = {}) {
  const all = new Set(packages.map(pkg => pkg.name));
  const everything = reason => result(all, all, true, reason);
  if (full) return everything("Full JavaScript verification was requested.");
  const affected = new Set();
  for (const original of files) {
    const path = original.replaceAll("\\", "/");
    if (sharedInput(path)) return everything(`Shared verification input changed: ${path}`);
    const pkg = owner(path, packages);
    if (!pkg) return everything(`No package owns the changed JavaScript input: ${path}`);
    affected.add(pkg.name);
  }
  for (const pkg of packages) {
    for (const field of dependencyFields) {
      for (const [name, version] of Object.entries(pkg.manifest[field] ?? {})) {
        if (String(version).startsWith("workspace:") && !all.has(name)) return everything(`Unresolved workspace dependency: ${pkg.name} -> ${name}`);
      }
    }
  }
  const graph = packages.map(pkg => ({ name: pkg.name, inputs: new Set([...dependencies(pkg), ...(productionInputs[pkg.name] ?? [])]) }));
  let previousSize;
  do {
    previousSize = affected.size;
    for (const { name, inputs } of graph) if ([...inputs].some(input => affected.has(input))) affected.add(name);
  } while (affected.size !== previousSize);
  const selected = new Set(affected);
  for (const pkg of packages) if (testInputs[pkg.name]?.some(input => affected.has(input))) selected.add(pkg.name);
  return result(selected, affected, false, files.length ? "Changed packages, production dependents, and external test consumers." : "No JavaScript inputs changed.");
}

// This guard checks literal imports, CSS sources, and fixture paths. Computed
// paths and subprocess inputs still need an explicit input audit during review.
export function uncoveredWorkspaceInputs(files, packages) {
  const findings = [];
  for (const { path, source } of files) {
    const consumer = owner(path, packages);
    if (!consumer || path.endsWith("/package.json")) continue;
    const declared = dependencies(consumer);
    const testFile = /(?:^|\/)e2e\//u.test(path) || /\.(?:test(?:-d)?|spec|integration(?:-helper)?)\.[^/]+$/u.test(path)
      || path === "packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.ts";
    for (const match of source.matchAll(/(["'`])((?:\.{1,2}\/|@dohc\/)[^"'`\r\n]+)\1/gu)) {
      const reference = match[2];
      const input = reference.startsWith("@dohc/")
        ? packages.find(pkg => pkg.name === reference.split("/").slice(0, 2).join("/"))
        : owner(posix.normalize(posix.join(posix.dirname(path), reference)), packages);
      if (!input || input.name === consumer.name || declared.has(input.name) || productionInputs[consumer.name]?.includes(input.name)) continue;
      if (testFile && testInputs[consumer.name]?.includes(input.name)) {
        const files = externalTestFiles[consumer.name]?.[input.name];
        if (!files || files.includes(posix.relative(consumer.path, path))) continue;
      }
      findings.push({ path, reference, consumer: consumer.name, input: input.name });
    }
  }
  return findings;
}
