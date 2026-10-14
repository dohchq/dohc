import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, posix, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));

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

const gateReadCalls = new Set(["include_str!", "include_bytes!", "read_to_string", "fs::read", "File::open",
  "readFileSync", "readFile", "createReadStream", "existsSync"]);
const gatePathCalls = new Set(["Path::new", "PathBuf::from", "URL", "join", "resolve"]);

function workflowFilters(workflow) {
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
  // Check possible direct paths and URLs here; the parser decides each value's role.
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
    const fileRelativeDirectory = (call === "join" || call === "resolve")
      && ["import.meta.dirname", "__dirname"].includes(source.slice(firstArgument.from, firstArgument.to));
    yield { reference: literal, call, fileRelativeURL, fileRelativeDirectory,
      directRead: node.from === firstArgument.from && gateReadCalls.has(call) };
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
    const resolveReferences = ({ reference, directRead, call, fileRelativeURL, fileRelativeDirectory }) => {
      if (rust && (call === "include_str!" || call === "include_bytes!")) return [posix.join(readerDirectory, reference)];
      // A direct read uses cwd, which is not known from its source file.
      if (directRead) return runtimeBases.map(base => posix.join(base, reference));
      if (fileRelativeURL) {
        try {
          // A fixed POSIX root keeps URL decoding independent of the host.
          const base = pathToFileURL(posix.join("/workspace", reader), { windows: false });
          const input = fileURLToPath(new URL(reference, base), { windows: false });
          return [posix.relative("/workspace", input)];
        } catch { return []; }
      }
      if (fileRelativeDirectory) return [posix.join(readerDirectory, reference)];
      if (/^\.{1,2}\//u.test(reference)) return [posix.join(rust ? runtimeBase : readerDirectory, reference)];
      return [];
    };
    const isUncovered = input => tracked.has(input) && gates.some(gate => !gatesFor(input)[gate]);
    const couldFind = reference => resolveReferences({ reference, directRead: true }).some(isUncovered)
      || /[%?#]/u.test(reference) && resolveReferences({ reference, fileRelativeURL: true }).some(isUncovered);
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
