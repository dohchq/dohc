#!/usr/bin/env node
import { globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const allowlistPath = "scripts/ui-rules-allowlist.json";
const renderer = "apps/desktop/src/renderer/";
const palette = "slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const colorUtility = new RegExp(`(?<![\\w-])(?:bg|text|border(?:-[xytrblse])?|divide|outline|ring(?:-offset)?|shadow|fill|stroke|accent|caret|decoration|placeholder|from|via|to)-(?:black|white|(?:${palette})-\\d{2,3})(?:\\/(?:\\d+|\\[[^\\]]+\\]))?(?![\\w/-])`, "gu");
const iconLibrary = /(?:^|[/@-])(?:icons?|iconify|icon-park|heroicons|lucide|phosphor|feather|fontawesome|fortawesome|octicons|ionicons|remixicon)(?:$|[/@-])/iu;

export function isRendererSource(path) {
  return path.startsWith(renderer) && /\.tsx?$/u.test(path)
    && !/\.(?:test(?:-d)?|spec)\./u.test(path)
    && !/(?:^|\/)__tests__\//u.test(path);
}

// Keep quoted values intact while skipping comments, including issue numbers.
const sourceChunks = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu;

export function scanSource(path, source) {
  const findings = [];
  const add = (offset, rule, value) => findings.push({
    rule, value, line: source.slice(0, offset).split("\n").length,
  });
  const uncommented = source.replace(sourceChunks, chunk => chunk.startsWith("/") ? chunk.replace(/[^\r\n]/gu, " ") : chunk);
  if (path !== `${renderer}tokens.ts`) {
    for (const match of uncommented.matchAll(/#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{4}\b|#[\da-f]{3}\b/giu)) add(match.index, "raw-hex", match[0]);
  }
  for (const match of uncommented.matchAll(colorUtility)) add(match.index, "palette", match[0]);
  for (const match of uncommented.matchAll(/(?<![\w-])backdrop-blur(?:-[\w.]+|-\[[^\]]+\])?(?![\w-])|(?:-webkit-)?backdrop-filter(?=["']?\s*:)|\b(?:backdropFilter|WebkitBackdropFilter)(?=["']?\s*[:,}])/gu)) add(match.index, "backdrop", match[0]);
  for (const match of uncommented.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)(["'])([^"'\r\n]+)\1/gu)) {
    const module = match[2];
    if (module !== "lucide-react" && !module.startsWith("lucide-react/") && iconLibrary.test(module) && !module.startsWith(".")) {
      add(match.index, "icon-library", module);
    }
  }
  return findings;
}

export function checkUiRules(root, allowlist) {
  const failures = [];
  const counts = {};
  const dimCounts = {};
  const paths = globSync(`${renderer}**/*.{ts,tsx}`, { cwd: root }).map(path => path.replaceAll("\\", "/")).filter(isRendererSource).sort();
  for (const path of paths) {
    const findings = scanSource(path, readFileSync(join(root, path), "utf8"));
    for (const finding of findings) {
      if (finding.rule === "palette" && finding.value === allowlist.overlayDim.class && Object.hasOwn(allowlist.overlayDim.files, path)) {
        dimCounts[path] = (dimCounts[path] ?? 0) + 1;
        continue;
      }
      const fileCounts = counts[path] ??= {};
      fileCounts[finding.rule] = (fileCounts[finding.rule] ?? 0) + 1;
      const allowed = allowlist.violations[path]?.[finding.rule] ?? 0;
      if (fileCounts[finding.rule] > allowed) failures.push(`${path}:${finding.line}: ${finding.rule}: ${finding.value} (count exceeds ${allowed}). Use interface tokens and lucide-react; remove blur.`);
    }
  }
  for (const [entries, actual] of [[allowlist.violations, counts], [allowlist.overlayDim.files, dimCounts]]) {
    for (const [path, rules] of Object.entries(entries)) {
      const expectedCounts = typeof rules === "number" ? { "overlay-dim": rules } : rules;
      for (const [rule, expected] of Object.entries(expectedCounts)) {
        const count = rule === "overlay-dim" ? actual[path] ?? 0 : actual[path]?.[rule] ?? 0;
        if (!isRendererSource(path) || !Number.isSafeInteger(expected) || expected <= 0) {
          failures.push(`${allowlistPath}: invalid entry ${path} (${rule}). Use a renderer source path and positive count.`);
        } else if (count < expected) {
          failures.push(`${path}: ${rule} count dropped from ${expected} to ${count}. Remove the fixed entry from ${allowlistPath}; lower the count if violations remain.`);
        } else if (rule === "overlay-dim" && count > expected) {
          failures.push(`${path}: overlay-dim count grew from ${expected} to ${count}. Use bg-scrim.`);
        }
      }
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
