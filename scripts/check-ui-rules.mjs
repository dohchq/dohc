#!/usr/bin/env node
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const allowlistPath = "scripts/ui-rules-allowlist.json";
const renderer = "apps/desktop/src/renderer/";
// TypeScript 7's parser requires a native server; use the pinned JS parser.
const ts = createRequire(join(repoRoot, "apps/desktop/package.json"))("typescript-parser");
const palette = "slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe";
const colorUtility = new RegExp(`(?<![\\w-])(?:bg|text|border(?:-[xytrblse])?|divide(?:-[xy])?|outline|ring(?:-offset)?|inset-ring|(?:inset-|drop-|text-)?shadow|fill|stroke|accent|caret|decoration|placeholder|from|via|to)-(?:black|white|\\[(?:black|white)\\]|(?:${palette})-\\d{2,3})(?:\\/(?:\\d+|\\[[^\\]]+\\]))?(?![\\w/-])`, "gu");
const iconLibrary = /(?:^|[/@-])(?:icons?|iconify|icon-park|heroicons|lucide|phosphor|feather|fontawesome|fortawesome|octicons|ionicons|remixicon|mdi|boxicons|iconoir|hugeicons)(?:$|[/@-])/iu;
const hex = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])/giu;
const nonColorNames = /^(?:href|src|to|id|hash|querySelector|querySelectorAll|getElementById|closest|matches)$/u;

export function isRendererSource(path) {
  return path.startsWith(renderer) && /\.tsx?$/u.test(path)
    && !/\.(?:test(?:-d)?|testSupport|spec)\./u.test(path)
    && !/(?:^|\/)__tests__\//u.test(path)
    && !/(?:TestHarness|fixture)/iu.test(path)
    && path !== `${renderer}editor/testDocs.ts`;
}

// Parser tokens preserve JSX text, regex literals, and template expressions.
function withoutComments(file, source) {
  const chunks = [];
  let end = 0;
  const visit = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(file);
    if (children.length) {
      children.forEach(visit);
    } else if (node.kind !== ts.SyntaxKind.EndOfFileToken) {
      const start = node.getStart(file);
      chunks.push(source.slice(end, start).replace(/[^\r\n]/gu, " "), source.slice(start, node.end));
      end = node.end;
    }
  };
  visit(file);
  chunks.push(source.slice(end).replace(/[^\r\n]/gu, " "));
  return chunks.join("");
}

function literalContext(node) {
  const parent = node.parent;
  if (ts.isJsxAttribute(parent) || ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) return parent.parent.name.getText();
  if (ts.isBinaryExpression(parent) && parent.right === node && ts.isPropertyAccessExpression(parent.left)) return parent.left.name.text;
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "setProperty" && parent.arguments[1] === node && ts.isStringLiteral(parent.arguments[0])) return parent.arguments[0].text;
    return ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText();
  }
  return "";
}

export function scanSource(path, source) {
  const findings = [];
  const add = (offset, rule, value) => findings.push({
    rule, value, line: source.slice(0, offset).split("\n").length,
  });
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const uncommented = withoutComments(file, source);
  const visit = node => {
    if (path !== `${renderer}tokens.ts` && (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node))) {
      const start = node.getStart(file);
      const value = source.slice(start + 1, node.end - (node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ? 2 : 1));
      const context = literalContext(node).replace(/^["']|["']$/gu, "");
      const colorContext = /(?:color|background|fill|stroke)/iu.test(context);
      for (const match of value.matchAll(hex)) {
        const before = value.slice(0, match.index);
        const after = value.slice(match.index + match[0].length);
        const entireColor = match[0] === value && !nonColorNames.test(context)
          && (colorContext || !/^#\d{3,4}$/u.test(value));
        const cssValue = /:\s*$/u.test(before) || /\bvar\([^)]*,\s*$/u.test(before);
        const arbitraryColor = before.endsWith("[") && /^\s*(?:\/[^\]]+)?\]/u.test(after);
        if (entireColor || cssValue || arbitraryColor) add(start + 1 + match.index, "raw-hex", match[0]);
      }
    }
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier = node.arguments[0];
    if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier) || ts.isTemplateExpression(specifier))) {
      const module = ts.isTemplateExpression(specifier) ? specifier.head.text : specifier.text;
      if (module !== "lucide-react" && !module.startsWith("lucide-react/") && iconLibrary.test(module) && !module.startsWith(".")) add(specifier.getStart(file), "icon-library", module);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const match of uncommented.matchAll(colorUtility)) add(match.index, "palette", match[0]);
  for (const match of uncommented.matchAll(/(?<![\w-])backdrop-blur(?:-[\w.]+|-\[[^\]]+\])?(?![\w-])|(?:-webkit-)?backdrop-filter(?=["']?\s*:|["'`]\s*,)|\b(?:backdropFilter|WebkitBackdropFilter)(?=["']?\s*[:,}=])/gu)) add(match.index, "backdrop", match[0]);
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
