import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, posix, relative } from "node:path";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const productionInputs = { "@dohc/site": ["@dohc/desktop"] };
// These inputs include ordinary tests and separate native/browser proofs.
// Test consumers do not become changed production packages themselves.
const testInputs = {
  "@dohc/desktop": ["@dohc/site", "@dohc/share-web", "@dohc/workspace-api", "@dohc/workspace-postgres"],
  "@dohc/workspace-auth": ["@dohc/workspace-postgres"],
  "@dohc/ydoc-projection": ["@dohc/sync-relay", "@dohc/workspace-engine-client", "@dohc/share-web", "@dohc/desktop",
    "@dohc/service-http", "@dohc/workspace-auth"],
  "@dohc/share-web": ["@dohc/desktop", "@dohc/mcp", "@dohc/cli", "@dohc/workspace-postgres", "@dohc/workspace-engine-client"],
  "@dohc/sync-relay": ["@dohc/share-web", "@dohc/desktop"],
  "@dohc/workspace-api": ["@dohc/workspace-postgres"],
};
// These helpers feed browser proofs and the declared desktop test below.
// The onboarding helper imports the API harness, which reads Postgres SQL.
const desktopProofInputs = {
  "@dohc/workspace-api": ["e2e/helpers/selfHostOnboarding.ts"],
  "@dohc/workspace-postgres": ["e2e/helpers/selfHostOnboarding.ts"],
  "@dohc/share-web": ["e2e/helpers/selfHostOnboarding.ts", "e2e/helpers/sharedDatasetBrowser.ts"],
};
// Keep a helper wrapper from hiding a new unit-test dependency on these inputs.
const desktopProofConsumers = {
  "apps/desktop/e2e/helpers/selfHostOnboarding": ["apps/desktop/e2e/self-host-onboarding.spec.ts", "apps/desktop/e2e/shared-continuity.spec.ts",
    "apps/desktop/src/workspaces/twoDaemonSync.e2e.test.ts"],
  "apps/desktop/e2e/helpers/sharedDatasetBrowser": [
    "apps/desktop/e2e/apps.spec.ts", "apps/desktop/e2e/collection-link-lane.spec.ts",
    "apps/desktop/e2e/dataset-completion.spec.ts", "apps/desktop/e2e/dataset-shared-form.spec.ts",
  ],
};
// External consumers can select compatibility files. A production change in
// the consumer or an input without a file map still selects its complete suite.
const externalTestFiles = {
  "@dohc/desktop": {
    "@dohc/site": ["src/renderer/tokens.test.ts", "src/renderer/workbench/ChatLane.test.tsx", "src/renderer/workbench/ProductDemo.test.tsx"],
    "@dohc/share-web": ["src/workspaces/twoDaemonSync.e2e.test.ts"],
    "@dohc/workspace-api": ["src/workspaces/twoDaemonSync.e2e.test.ts"],
    "@dohc/workspace-postgres": ["src/workspaces/twoDaemonSync.e2e.test.ts"],
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
  // The shutdown budgets also feed plain Node debug and verification proofs.
  return /^(?:crates|vendor|scripts|tools|examples|patches|\.cargo|\.config|\.github)\//u.test(path)
    || path === "apps/desktop/src/shutdownBudgets.ts"
    || /(?:^|\/)package\.json$/u.test(path)
    || /(?:^|\/)(?:tsconfig[^/]*\.json|[^/]+\.config\.[^/]+|\.env(?:\.[^/]*)?)$/u.test(path)
    || /^apps\/desktop\/scripts\//u.test(path);
}

// The states page compares every shared renderer part with its pixel
// baselines, so a renderer change or a change to the gallery itself runs it.
function statesPageInput(path) {
  return /^apps\/desktop\/(?:src\/renderer\/|e2e\/states-page)/u.test(path);
}

function result(selected, affected, full, reason, statesPage = full) {
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
    desktop: desktopScripts || Object.keys(desktopProofInputs).some(input => affected.has(input)),
  };
  proofs.statesPage = proofs.desktop && statesPage;
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
  return result(selected, affected, false, files.length ? "Changed packages, production dependents, and external test consumers." : "No JavaScript inputs changed.",
    files.some(path => statesPageInput(path.replaceAll("\\", "/"))));
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
      const inputPath = posix.normalize(posix.join(posix.dirname(path), reference));
      const proofConsumers = desktopProofConsumers[inputPath.replace(/\.[cm]?[jt]sx?$/u, "")];
      if (proofConsumers && !proofConsumers.includes(path)) {
        findings.push({ path, reference, consumer: consumer.name, input: "@dohc/desktop" });
        continue;
      }
      const input = reference.startsWith("@dohc/")
        ? packages.find(pkg => pkg.name === reference.split("/").slice(0, 2).join("/"))
        : owner(inputPath, packages);
      if (!input || input.name === consumer.name || declared.has(input.name) || productionInputs[consumer.name]?.includes(input.name)) continue;
      if (consumer.name === "@dohc/desktop" && desktopProofInputs[input.name]?.includes(posix.relative(consumer.path, path))) continue;
      if (testFile && testInputs[consumer.name]?.includes(input.name)) {
        const files = externalTestFiles[consumer.name]?.[input.name];
        if (!files || files.includes(posix.relative(consumer.path, path))) continue;
      }
      findings.push({ path, reference, consumer: consumer.name, input: input.name });
    }
  }
  return findings;
}

const gateReadCalls = new Set(["include_str!", "include_bytes!", "read_to_string", "fs::read", "File::open",
  "readFileSync", "readFile", "createReadStream", "existsSync"]);
const gatePathCalls = new Set(["Path::new", "PathBuf::from", "URL", "join", "resolve"]);

export function workflowFilters(workflow) {
  const yaml = require("js-yaml");
  const document = yaml.load(workflow);
  const filterStep = document.jobs.changes.steps.find(step => step.with?.filters);
  return yaml.load(filterStep.with.filters);
}

function gatesFromFilters(files, filters) {
  return Object.fromEntries(["rust", "js"].map(name =>
    [name, files.some(file => filters[name].some(pattern => matchesGlob(file, pattern)))]));
}

export function selectedGates(files, workflow) {
  return gatesFromFilters(files, workflowFilters(workflow));
}

export const isGateReader = path => /\.(?:rs|[cm]?[jt]sx?)$/u.test(path);

function* javascriptGateInputs(path, source, couldFind) {
  // Overlapping quotes retain candidates inside templates, comments, and regexes.
  // Treat every value as a direct read here; the parser decides its actual role.
  let candidate = false;
  for (const match of source.matchAll(/(?=(["'\x60])([^\\\r\n]*?)\1)/gu)) {
    if (couldFind(match[2])) { candidate = true; break; }
  }
  if (!candidate) return;
  const { typescriptLanguage, tsxLanguage } = require("@codemirror/lang-javascript");
  // Lezer treats a CRLF continuation differently from its equivalent LF source.
  source = source.replaceAll("\r\n", "\n");
  const language = /\.[jt]sx$/u.test(path) ? tsxLanguage : typescriptLanguage;
  const cursor = language.parser.parse(source).cursor();
  do {
    if (cursor.name !== "String" && cursor.name !== "TemplateString") continue;
    const node = cursor.node;
    if (node.parent?.name !== "ArgList" || node.name === "TemplateString" && node.getChild("Interpolation")) continue;
    const callNode = node.parent.parent;
    if (callNode.name !== "CallExpression" && callNode.name !== "NewExpression") continue;
    const callee = callNode.name === "NewExpression" ? callNode.getChild("VariableName") : callNode.firstChild;
    const nameNode = callee?.name === "MemberExpression" ? callee.lastChild : callee;
    const call = nameNode ? source.slice(nameNode.from, nameNode.to) : "";
    if (!gateReadCalls.has(call) && !(gatePathCalls.has(call) && (call !== "URL" || callNode.name === "NewExpression"))) continue;
    const literal = source.slice(node.from + 1, node.to - 1);
    if (!literal || /[\\\r\n]/u.test(literal)) continue;
    let firstArgument = node.parent.firstChild.nextSibling;
    while (["LineComment", "BlockComment"].includes(firstArgument?.name)) firstArgument = firstArgument.nextSibling;
    let secondArgument = firstArgument.nextSibling;
    while (["LineComment", "BlockComment", ","].includes(secondArgument?.name)) secondArgument = secondArgument.nextSibling;
    const fileRelativeURL = call === "URL" && node.from === firstArgument.from
      && secondArgument && source.slice(secondArgument.from, secondArgument.to) === "import.meta.url";
    yield { reference: literal, call, fileRelativeURL, directRead: node.from === firstArgument.from && gateReadCalls.has(call) };
  } while (cursor.next());
}

function rustTokens(source) {
  const tokens = [];
  const pattern = /\s+|\/\/[^\n]*|[bc]?"(?:\\[\s\S]|[^"\\])*"|b?'(?:\\(?:u\{[\da-fA-F]+\}|x[\da-fA-F]{2}|[\s\S])|[^'\\\r\n])'|[A-Za-z_]\w*|::|[^\s]/y;
  const rawStart = /(?:br|cr|r)(#*)"/y;
  for (let offset = 0; offset < source.length;) {
    if (source.startsWith("/*", offset)) {
      offset += 2;
      let depth = 1;
      while (depth && offset < source.length) {
        if (source.startsWith("/*", offset)) { depth++; offset += 2; }
        else if (source.startsWith("*/", offset)) { depth--; offset += 2; }
        else offset++;
      }
      continue;
    }
    rawStart.lastIndex = offset;
    const raw = rawStart.exec(source);
    if (raw) {
      const start = rawStart.lastIndex;
      const closing = '"' + raw[1];
      const end = source.indexOf(closing, start);
      tokens.push({ token: "string", value: end < 0 ? undefined : source.slice(start, end) });
      offset = end < 0 ? source.length : end + closing.length;
      continue;
    }
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) { offset++; continue; }
    const token = match[0];
    offset = pattern.lastIndex;
    if (/^\s/u.test(token) || token.startsWith("//")) continue;
    const quoted = token.match(/^[bc]?"([\s\S]*)"$/u);
    const value = quoted?.[1].replace(/\\\r?\n\s*/gu, "");
    tokens.push({ token, value: value && !value.includes("\\") ? value : undefined });
  }
  return tokens;
}

function* rustGateInputs(source) {
  const tokens = rustTokens(source);
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const { token, value } = tokens[index];
    if (token === "(") {
      let end = index - 1;
      let call = tokens[end]?.token ?? "";
      if (call === "!") call = (tokens[--end]?.token ?? "") + "!";
      while (tokens[end - 1]?.token === "::" && /^[A-Za-z_]\w*$/u.test(tokens[end - 2]?.token ?? "")) {
        call = tokens[end - 2].token + "::" + call;
        end -= 2;
      }
      // A fully qualified Rust call can have std:: or another module prefix.
      call = [...gateReadCalls, ...gatePathCalls].find(name => call === name || call.endsWith("::" + name));
      stack.push({ token, call, first: true });
    } else if (token === "[" || token === "{") {
      stack.push({ token });
    } else if (token === ")" || token === "]" || token === "}") {
      stack.pop();
    } else {
      const argument = stack.at(-1);
      if (argument?.call && value && ["(", ","].includes(tokens[index - 1]?.token)
        && [",", ")"].includes(tokens[index + 1]?.token)) {
        yield { reference: value, call: argument.call, directRead: argument.first && gateReadCalls.has(argument.call) };
      }
      if (token === "," && argument) argument.first = false;
    }
  }
}

function manifestRoot(reader, tracked, manifest) {
  for (let directory = posix.dirname(reader);; directory = posix.dirname(directory)) {
    if (tracked.has(posix.join(directory, manifest))) return directory;
    if (directory === ".") return ".";
  }
}

export function gateInputMessage({ reader, input, gate, filterLine }) {
  return `${reader} reads ${input}, but changes to it do not select the ${gate} gate. Add ${filterLine} to the ${gate} filter in .github/workflows/pr-checks.yml.`;
}

export function uncoveredGateInputs(files, trackedPaths, workflow) {
  const tracked = new Set(trackedPaths);
  const filters = workflowFilters(workflow);
  const selections = new Map();
  const gatesFor = path => {
    if (!selections.has(path)) selections.set(path, gatesFromFilters([path], filters));
    return selections.get(path);
  };
  const findings = new Map();
  for (const { path: reader, source } of files) {
    if (!isGateReader(reader)) continue;
    const rust = reader.endsWith(".rs");
    const gates = Object.entries(gatesFor(reader))
      .filter(([gate, selected]) => selected && (gate === "rust") === rust).map(([gate]) => gate);
    if (!gates.length) continue;
    const readerDirectory = posix.dirname(reader);
    const runtimeBase = manifestRoot(reader, tracked, rust ? "Cargo.toml" : "package.json");
    const runtimeBases = rust ? [runtimeBase] : [...new Set([readerDirectory, runtimeBase, "."])];
    const resolveReferences = ({ reference, directRead, call, fileRelativeURL }) => {
      if (rust && (call === "include_str!" || call === "include_bytes!")) return [posix.join(readerDirectory, reference)];
      // A direct read uses cwd, which is not known from its source file.
      if (directRead) return runtimeBases.map(base => posix.join(base, reference));
      if (fileRelativeURL) return [posix.join(readerDirectory, reference)];
      if (/^\.{1,2}\//u.test(reference)) return [posix.join(rust ? runtimeBase : readerDirectory, reference)];
      return [];
    };
    const couldFind = reference => resolveReferences({ reference, directRead: true })
      .some(input => tracked.has(input) && gates.some(gate => !gatesFor(input)[gate]));
    const inputs = rust ? rustGateInputs(source) : javascriptGateInputs(reader, source, couldFind);
    for (const reference of inputs) {
      for (const input of resolveReferences(reference)) {
        if (!tracked.has(input)) continue;
        for (const gate of gates) {
          if (!gatesFor(input)[gate]) findings.set(`${gate}|${reader}|${input}`,
            { reader, input, gate, filterLine: `- '${input.replaceAll("'", "''")}'` });
        }
      }
    }
  }
  return [...findings.values()];
}
