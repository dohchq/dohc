#!/usr/bin/env node
// Typecheck owns syntax validity; this guard scans literals through parser recovery.
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const allowlistPath = "scripts/ui-rules-allowlist.json";
const renderer = "apps/desktop/src/renderer/";
const { typescriptLanguage, tsxLanguage } = createRequire(join(repoRoot, "apps/desktop/package.json"))("@codemirror/lang-javascript");
const palette = "slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe";
const colorUtility = new RegExp(`(?<![\\w-])(?:bg|text|border(?:-[xytrblse])?|divide(?:-[xy])?|outline|ring(?:-offset)?|inset-ring|(?:inset-|drop-|text-)?shadow|fill|stroke|accent|caret|decoration|placeholder|from|via|to)-(?:black|white|\\[(?:black|white)\\]|(?:${palette})-\\d{2,3})(?:\\/(?:\\d+|\\[[^\\]]+\\]))?(?![\\w/-])`, "gu");
const iconLibrary = /(?:^|[/@-])(?:icons?|iconify|icon-park|heroicons|lucide|phosphor|feather|fontawesome|fortawesome|octicons|ionicons|remixicon|mdi|boxicons|iconoir|hugeicons)(?:$|[/@-])/iu;
const hex = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])/giu;
const nonColorNames = /^(?:href|src|to|id|hash|querySelector|querySelectorAll|getElementById|closest|matches)$/u;
const styleKey = "(?:color|background(?:-?color|-?image)?|fill|stroke|border(?:-?(?:top|right|bottom|left|block|inline)(?:-?(?:start|end))?)?(?:-?color)?|(?:box|text)-?shadow|outline(?:-?color)?)";
const styleName = new RegExp(`^${styleKey}$`, "iu");
const cssDeclaration = new RegExp(`(?:^|[\\s;{])(?:${styleKey}|--[\\w-]+)\\s*:[^;{}]*$`, "iu");

export function isRendererSource(path) {
  return path.startsWith(renderer) && /\.tsx?$/u.test(path)
    && !/\.(?:test(?:-d)?|testSupport|spec)\./u.test(path)
    && !/(?:^|\/)__tests__\//u.test(path)
    && !/(?:TestHarness|fixture)/iu.test(path)
    && path !== `${renderer}editor/testDocs.ts`;
}

const isComment = node => node?.name === "LineComment" || node?.name === "BlockComment";
function sibling(node, direction) {
  let next = node?.[direction];
  while (isComment(next)) next = next[direction];
  return next;
}

function literalContext(node, source) {
  const text = node => node ? source.slice(node.from, node.to).replace(/^["']|["']$/gu, "") : "";
  const parent = node.parent;
  if (parent.name === "JSXAttribute" || parent.name === "Property") return text(parent.firstChild);
  if (parent.name === "JSXEscape" && parent.parent.name === "JSXAttribute") return text(parent.parent.firstChild);
  const previous = sibling(node, "prevSibling");
  if (parent.name === "VariableDeclaration" && previous?.name === "Equals") {
    let declaration = sibling(previous, "prevSibling");
    if (declaration?.name === "TypeAnnotation") declaration = sibling(declaration, "prevSibling");
    return text(declaration);
  }
  if (parent.name === "AssignmentExpression" && parent.firstChild.name === "MemberExpression") return text(parent.firstChild.lastChild);
  if (parent.name === "ArgList" && parent.parent.name === "CallExpression") {
    const callee = parent.parent.firstChild;
    const name = text(callee.name === "MemberExpression" ? callee.lastChild : callee);
    const firstArgument = sibling(parent.firstChild, "nextSibling");
    if (name === "setProperty" && firstArgument.name === "String" && node !== firstArgument) return text(firstArgument);
    return name;
  }
  return "";
}

export function scanSource(path, source) {
  const findings = [];
  const comments = [];
  const add = (offset, rule, value) => findings.push({
    rule, value, line: source.slice(0, offset).split("\n").length,
  });
  // The editor's parser retains source syntax, including literals in dead code.
  // A compiler transform can erase those literals before the guard sees them.
  const language = path.endsWith(".tsx") ? tsxLanguage : typescriptLanguage;
  const file = language.parser.parse(source);
  const visit = node => {
    if (isComment(node)) {
      comments.push(node);
      return;
    }
    if (["String", "JSXAttributeValue", "TemplateString"].includes(node.name)) {
      const segments = [];
      let start = node.from + 1;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== "Interpolation") continue;
        segments.push([start, child.from]);
        start = child.to;
      }
      segments.push([start, node.to - 1]);
      if (path !== `${renderer}tokens.ts`) {
        const context = literalContext(node, source);
        const colorContext = /(?:color|background|fill|stroke)/iu.test(context);
        const styleContext = styleName.test(context);
        for (const [start, end] of segments) {
          const value = source.slice(start, end);
          for (const match of value.matchAll(hex)) {
            const before = value.slice(0, match.index);
            const after = value.slice(match.index + match[0].length);
            const entireColor = match[0] === value && !nonColorNames.test(context)
              && (colorContext || !/^#\d{3,4}$/u.test(value));
            const cssValue = (/\bvar\([^)]*,\s*$/u.test(before) && !/^#\d{3,4}$/u.test(match[0]))
              || (/[\s(:,]$/u.test(before) && (cssDeclaration.test(before) || styleContext));
            const arbitraryColor = before.endsWith("[") && /^\s*(?:\/[^\]]+)?\]/u.test(after);
            if (entireColor || cssValue || arbitraryColor) add(start + match.index, "raw-hex", match[0]);
          }
        }
      }
      const parent = node.parent;
      const staticImport = parent.name === "ImportDeclaration"
        || (parent.name === "ExportDeclaration" && sibling(node, "prevSibling")?.name === "from");
      const requireCall = parent.name === "ArgList" && parent.parent.name === "CallExpression"
        && source.slice(parent.parent.firstChild.from, parent.parent.firstChild.to) === "require"
        && sibling(parent.firstChild, "nextSibling")?.from === node.from;
      const dynamicImport = parent.name === "DynamicImport" && sibling(parent.getChild("("), "nextSibling")?.from === node.from;
      if (staticImport || requireCall || dynamicImport) {
        const module = source.slice(...segments[0]);
        if (module !== "lucide-react" && !module.startsWith("lucide-react/") && iconLibrary.test(module) && !module.startsWith(".")) add(node.from, "icon-library", module);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(file.topNode);
  const chunks = [];
  let end = 0;
  for (const comment of comments) {
    chunks.push(source.slice(end, comment.from), source.slice(comment.from, comment.to).replace(/[^\r\n]/gu, " "));
    end = comment.to;
  }
  chunks.push(source.slice(end));
  const uncommented = chunks.join("");
  for (const match of uncommented.matchAll(colorUtility)) add(match.index, "palette", match[0]);
  for (const match of uncommented.matchAll(/(?<![\w-])backdrop-blur(?:-[\w.]+|-\[[^\]]+\])?(?![\w-])|(?:-webkit-)?backdrop-filter(?=["']?\s*:|["'`]\s*,)|\b(?:backdropFilter|WebkitBackdropFilter)(?=["']?\s*(?:[:,}]|=(?![=>])))/gu)) add(match.index, "backdrop", match[0]);
  return findings;
}

export function checkUiRules(root, allowlist) {
  const failures = [];
  const counts = {};
  const violations = allowlist?.violations;
  const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const rules = new Set(["raw-hex", "palette", "backdrop", "icon-library"]);
  if (!isRecord(allowlist) || !isRecord(violations)) return { failures: [`${allowlistPath}: invalid violations map.`], counts };
  for (const [path, entries] of Object.entries(violations)) {
    if (!isRendererSource(path) || !isRecord(entries) || !Object.keys(entries).length) {
      failures.push(`${allowlistPath}: invalid entry ${path}. Use a renderer source path and rule counts.`);
      continue;
    }
    for (const [rule, expected] of Object.entries(entries)) {
      if (!rules.has(rule) || !Number.isSafeInteger(expected) || expected <= 0) failures.push(`${allowlistPath}: invalid entry ${path} (${rule}). Use a known rule and positive count.`);
    }
  }
  const paths = globSync(`${renderer}**/*.{ts,tsx}`, { cwd: root }).map(path => path.replaceAll("\\", "/")).filter(isRendererSource).sort();
  for (const path of paths) {
    const findings = scanSource(path, readFileSync(join(root, path), "utf8"));
    for (const finding of findings) {
      const fileCounts = counts[path] ??= {};
      fileCounts[finding.rule] = (fileCounts[finding.rule] ?? 0) + 1;
      const expected = violations[path]?.[finding.rule];
      const allowed = Number.isSafeInteger(expected) && expected > 0 ? expected : 0;
      if (fileCounts[finding.rule] > allowed) failures.push(`${path}:${finding.line}: ${finding.rule}: ${finding.value} (count exceeds ${allowed}). Use interface tokens and lucide-react; remove blur.`);
    }
  }
  for (const [path, entries] of Object.entries(violations)) {
    if (!isRecord(entries)) continue;
    for (const [rule, expected] of Object.entries(entries)) {
      const count = counts[path]?.[rule] ?? 0;
      if (rules.has(rule) && Number.isSafeInteger(expected) && expected > 0 && count < expected) failures.push(`${path}: ${rule} count dropped from ${expected} to ${count}. Remove or lower the entry in ${allowlistPath}.`);
    }
  }
  return { failures, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
  const allowlist = JSON.parse(readFileSync(join(root, allowlistPath), "utf8"));
  const { failures } = checkUiRules(root, allowlist);
  if (failures.length) {
    console.error(`UI rules check failed:\n${failures.map(failure => `- ${failure}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("UI rules check passed.");
  }
}
