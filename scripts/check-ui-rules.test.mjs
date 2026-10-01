import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkUiRules, isRendererSource, scanSource } from "./check-ui-rules.mjs";
import { readWorkspacePackages, selectJavaScript } from "./verification/selection.mjs";

const root = join(import.meta.dirname, "..");
const renderer = "apps/desktop/src/renderer/";
const path = `${renderer}Fixture.tsx`;
const baseline = JSON.parse(readFileSync(join(root, "scripts/ui-rules-allowlist.json"), "utf8"));
const empty = () => ({ overlayDim: { ...baseline.overlayDim, files: {} }, violations: {} });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dohc-ui-rules-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (path, source) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), source);
  };
  return { directory, put };
}

test("hex colors include CSS short, long, and alpha forms", () => {
  const source = 'const colors = ["#abc", "#abcd", "#ABCDEF", "#12345678"];';
  assert.deepEqual(scanSource(path, source).map(finding => finding.value), ["#abc", "#abcd", "#ABCDEF", "#12345678"]);
  assert.deepEqual(scanSource(`${renderer}tokens.ts`, source), []);
  assert.equal(scanSource(`${renderer}nested/tokens.ts`, source).length, 4);
  assert.equal(scanSource(`${renderer}tokens.ts`, 'const classes = "bg-blue-500";').length, 1);
  assert.deepEqual(scanSource(path, 'const x = "#12345 #1234567 #abcdefgh";'), []);
});

test("palette classes cover variants, opacity, gradients, and SVG utilities", () => {
  for (const value of ["bg-zinc-900", "hover:text-blue-500/50", "dark:!border-white", "bg-black/20", "ring-offset-slate-100", "from-red-50", "via-amber-200", "to-green-950", "fill-black", "stroke-white", "border-x-neutral-300", "text-rose-500/[.25]"]) {
    assert.equal(scanSource(path, `<div className="${value}" />`).length, 1, value);
  }
  assert.deepEqual(scanSource(path, '<div className="bg-bg text-ink hover:bg-hover border-line whitespace-nowrap bg-agent ring-accent from-panel to-bg" />'), []);
});

test("blur classes and CSS properties fail in TSX and embedded CSS", () => {
  for (const value of ["backdrop-blur", "sm:backdrop-blur-sm", "backdrop-blur-[1.5px]", "backdrop-blur-none", "[backdrop-filter:blur(2px)]", "-webkit-backdrop-filter: blur(2px)"]) {
    assert.equal(scanSource(path, `const classes = '${value}';`).length, 1, value);
  }
  for (const source of ['const style = { backdropFilter: "blur(2px)" };', 'const style = { "WebkitBackdropFilter": "blur(2px)" };', 'const style = { "backdrop-filter": "blur(2px)" };', 'const style = { backdropFilter };']) {
    assert.equal(scanSource(path, source).length, 1, source);
  }
  assert.deepEqual(scanSource(path, 'const classes = "blur-sm backdrop-brightness-50";'), []);
});

test("icon import, re-export, require, and dynamic import use lucide-react", () => {
  for (const library of ["react-icons/fa", "@heroicons/react/24/outline", "@phosphor-icons/react", "@tabler/icons-react", "@mui/icons-material", "@fortawesome/react-fontawesome", "@iconify/react", "react-feather", "lucide", "lucide-react-native", "@radix-ui/react-icons", "@primer/octicons-react"]) {
    for (const source of [`import { Icon } from "${library}";`, `export { Icon } from '${library}';`, `import "${library}";`, `const icons = import('${library}');`, `const icons = require("${library}");`]) {
      assert.equal(scanSource(path, source).length, 1, source);
    }
  }
  assert.deepEqual(scanSource(path, 'import { X } from "lucide-react"; import "lucide-react/dynamic"; import { Icon } from "./icons"; import React from "react";'), []);
});

test("comments do not count; quoted URLs and template classes still count", () => {
  assert.deepEqual(scanSource(path, '// #600 bg-blue-500\n/* backdrop-blur import "react-icons/fa" */\n<div>{/* #fff text-white */}</div>'), []);
  assert.equal(scanSource(path, 'const url = "https://example.test"; const color = "#fff";').length, 1);
  assert.equal(scanSource(path, 'const classes = `bg-blue-500 ${active ? "text-white" : "text-ink"}`;').length, 2);
  assert.equal(scanSource(path, '\n\nconst color = "#fff";')[0].line, 3);
});

test("renderer TS and TSX are scanned, including untracked files; tests are exempt", t => {
  const { directory, put } = fixture(t);
  for (const excluded of [`${renderer}Fixture.test.tsx`, `${renderer}Fixture.focus.test.ts`, `${renderer}Fixture.spec.tsx`, `${renderer}__tests__/Fixture.ts`, "apps/site/src/Fixture.tsx"]) {
    assert.equal(isRendererSource(excluded), false, excluded);
    put(excluded, 'const color = "#fff";');
  }
  put(`${renderer}tokens.ts`, 'const color = "#fff";');
  assert.deepEqual(checkUiRules(directory, empty()).failures, []);
  put(`${renderer}Fixture.ts`, 'const color = "#fff";');
  assert.match(checkUiRules(directory, empty()).failures.join("\n"), /Fixture\.ts:1: raw-hex/u);
});

test("allowlist rejects growth, new paths, lower counts, and deleted entries", t => {
  const { directory, put } = fixture(t);
  const allowlist = empty();
  allowlist.violations[path] = { "raw-hex": 2 };
  put(path, 'const colors = ["#abc", "#def"];');
  assert.deepEqual(checkUiRules(directory, allowlist).failures, []);
  put(path, 'const colors = ["#abc", "#def", "#fff"];');
  assert.match(checkUiRules(directory, allowlist).failures.join("\n"), /count exceeds 2/u);
  put(path, 'const colors = ["#abc"];');
  assert.match(checkUiRules(directory, allowlist).failures.join("\n"), /count dropped from 2 to 1.*Remove.*lower the count/u);
  rmSync(join(directory, path));
  assert.match(checkUiRules(directory, allowlist).failures.join("\n"), /count dropped from 2 to 0.*Remove/u);
  put(`${renderer}New.tsx`, 'const color = "#fff";');
  assert.match(checkUiRules(directory, allowlist).failures.join("\n"), /New\.tsx:1: raw-hex/u);
});

test("the overlay dim allowance is restricted to its recorded file and count", t => {
  const { directory, put } = fixture(t);
  const allowlist = empty();
  allowlist.overlayDim.files[path] = 1;
  const dim = allowlist.overlayDim.class;
  put(path, `<div className="${dim}" />`);
  assert.deepEqual(checkUiRules(directory, allowlist).failures, []);
  put(path, `<div className="${dim} ${dim}" />`);
  assert.match(checkUiRules(directory, allowlist).failures.join("\n"), /overlay-dim count grew/u);
  put(path, '<div className="bg-scrim" />');
  put(`${renderer}Moved.tsx`, `<div className="${dim}" />`);
  const failures = checkUiRules(directory, allowlist).failures.join("\n");
  assert.match(failures, /Moved\.tsx:1: palette/u);
  assert.match(failures, /overlay-dim count dropped/u);
  assert.deepEqual(baseline.overlayDim.files, {});
});

test("CLI exits nonzero for a planted violation in a temporary fixture", t => {
  const { directory, put } = fixture(t);
  put("scripts/ui-rules-allowlist.json", JSON.stringify(empty()));
  put(path, '<div className="bg-bg text-ink" />');
  const run = () => spawnSync(process.execPath, [join(root, "scripts/check-ui-rules.mjs"), directory], { encoding: "utf8" });
  assert.equal(run().status, 0);
  put(path, '<div className="bg-blue-500" />');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UI rules check failed.*Fixture\.tsx:1: palette: bg-blue-500/su);
});

test("source and full verification include the guard and its fixture tests", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const source = manifest.scripts["test:repo:source"];
  assert.match(source, /node scripts\/check-ui-rules\.mjs/u);
  assert.match(source, /scripts\/check-ui-rules\.test\.mjs/u);
  assert.match(manifest.scripts["test:repo"], /pnpm test:repo:source/u);
  const packages = readWorkspacePackages(root);
  assert.equal(selectJavaScript([path], packages).repository, "source");
  for (const changed of ["scripts/check-ui-rules.mjs", "scripts/ui-rules-allowlist.json", "package.json"]) {
    assert.equal(selectJavaScript([changed], packages).repository, "full", changed);
  }
});
