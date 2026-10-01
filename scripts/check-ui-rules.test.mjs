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
const path = `${renderer}ReviewSample.tsx`;
const empty = () => ({ violations: {} });

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

test("hex colors require a color value rather than an anchor, selector, issue, or URL", () => {
  for (const source of [
    '<a href="#ace" src="#add" to="#abc" id="#feed" hash="#def" />',
    '<a href={"#ace"} />',
    'document.querySelector("#feed"); document.querySelectorAll(`#abc`);',
    'const issue = "#1579"; const text = "see #1234"; const id = "#abc-foo";',
    'const url = "https://example.test/#abc"; const url2 = `https://example.test/#abcd`;',
    'const pattern = /#abc/;',
  ]) assert.deepEqual(scanSource(path, source), [], source);
  for (const source of [
    '<div style={{color: "#1579", background: "#abcd"}} />',
    '<svg color="#abc" fill={"#def"} />',
    'node.style.color = "#1579"; node.style.setProperty("color", "#1234");',
    'const css = `color: #abc; background: #abcd;`;',
    '<div className="bg-[#abc] text-[#abcdef]/50" />',
    'const color = "#abc"; const fallback = "var(--ink, #def)";',
  ]) assert.equal(scanSource(path, source).filter(finding => finding.rule === "raw-hex").length, 2, source);
});

test("palette classes cover variants, opacity, gradients, and SVG utilities", () => {
  for (const value of ["bg-zinc-900", "hover:text-blue-500/50", "dark:!border-white", "bg-black/20", "ring-offset-slate-100", "from-red-50", "via-amber-200", "to-green-950", "fill-black", "stroke-white", "border-x-neutral-300", "text-rose-500/[.25]"]) {
    assert.equal(scanSource(path, `<div className="${value}" />`).length, 1, value);
  }
  assert.deepEqual(scanSource(path, '<div className="bg-bg text-ink hover:bg-hover border-line whitespace-nowrap bg-agent ring-accent from-panel to-bg" />'), []);
});

test("Tailwind 4.3 palettes and color utilities count", () => {
  for (const value of ["bg-mauve-500", "text-olive-600", "border-mist-200", "ring-taupe-300", "inset-ring-blue-500", "inset-shadow-zinc-900", "drop-shadow-red-500", "text-shadow-white", "divide-x-zinc-200", "divide-y-white", "bg-[white]", "text-[black]", "hover:inset-shadow-mauve-500/50", "divide-x-[black]/20"]) {
    assert.equal(scanSource(path, `<div className="${value}" />`).length, 1, value);
  }
});

test("blur classes and CSS properties fail in TSX and embedded CSS", () => {
  for (const value of ["backdrop-blur", "sm:backdrop-blur-sm", "backdrop-blur-[1.5px]", "backdrop-blur-none", "[backdrop-filter:blur(2px)]", "-webkit-backdrop-filter: blur(2px)"]) {
    assert.equal(scanSource(path, `const classes = '${value}';`).length, 1, value);
  }
  for (const source of ['const style = { backdropFilter: "blur(2px)" };', 'const style = { "WebkitBackdropFilter": "blur(2px)" };', 'const style = { "backdrop-filter": "blur(2px)" };', 'const style = { backdropFilter };', 'node.style.backdropFilter = "blur(2px)";', 'node.style.WebkitBackdropFilter = "blur(2px)";', 'node.style.setProperty("backdrop-filter", "blur(2px)");', 'node.style.setProperty(`-webkit-backdrop-filter`, "blur(2px)");']) {
    assert.equal(scanSource(path, source).length, 1, source);
  }
  assert.deepEqual(scanSource(path, 'const classes = "blur-sm backdrop-brightness-50";'), []);
});

test("icon import, re-export, require, and dynamic import use lucide-react", () => {
  for (const library of ["react-icons/fa", "@heroicons/react/24/outline", "@phosphor-icons/react", "@tabler/icons-react", "@mui/icons-material", "@fortawesome/react-fontawesome", "@iconify/react", "react-feather", "lucide", "lucide-react-native", "@radix-ui/react-icons", "@primer/octicons-react", "@mdi/js", "@mdi/react", "boxicons", "boxicons/css/boxicons.css", "@iconoir/react", "iconoir-react", "hugeicons-react", "@hugeicons/react"]) {
    for (const source of [`import { Icon } from "${library}";`, `export { Icon } from '${library}';`, `import "${library}";`, `const icons = import('${library}');`, `const icons = import(\`${library}\`);`, `const icons = require("${library}");`]) {
      assert.equal(scanSource(path, source).length, 1, source);
    }
  }
  assert.deepEqual(scanSource(path, 'import { X } from "lucide-react"; import "lucide-react/dynamic"; import { Icon } from "./icons"; import React from "react";'), []);
  assert.equal(scanSource(path, 'const icons = import(`@mdi/${pack}`);').length, 1);
  assert.deepEqual(scanSource(path, 'const text = `import("react-icons/fa")`;'), []);
});

test("JSX text and regex syntax do not hide violations or expose comments", () => {
  for (const source of [
    '<div>https://example.test <span className="bg-zinc-900" /></div>',
    '<div>// words <span className="bg-zinc-900" /></div>',
    '<div>It\'s <span className="bg-zinc-900" />{/* text-white */}</div>',
    'const pattern = /https?:\\/\\//; const classes = "bg-zinc-900";',
    'const pattern = /[/*]/; const classes = "bg-zinc-900";',
    'const classes = `${active ? "bg-zinc-900" : "bg-bg" /* text-white */}`;',
  ]) assert.deepEqual(scanSource(path, source).map(finding => finding.value), ["bg-zinc-900"], source);
  assert.deepEqual(scanSource(path, '/** bg-zinc-900 #fff */\nconst value = "bg-bg";'), []);
  assert.deepEqual(scanSource(path, '<div>It\'s {/* bg-zinc-900 #fff */}</div>'), []);
});

test("comments do not count; quoted URLs and template classes still count", () => {
  assert.deepEqual(scanSource(path, '// #600 bg-blue-500\n/* backdrop-blur import "react-icons/fa" */\n<div>{/* #fff text-white */}</div>'), []);
  assert.equal(scanSource(path, 'const url = "https://example.test"; const color = "#fff";').length, 1);
  assert.equal(scanSource(path, 'const classes = `bg-blue-500 ${active ? "text-white" : "text-ink"}`;').length, 2);
  assert.equal(scanSource(path, '\n\nconst color = "#fff";')[0].line, 3);
});

test("source literals survive dead branches and keep JSX expression context", () => {
  const source = `
    const classes = false && "bg-blue-500";
    const css = \`color: #abc; /* text-white */\`;
    const url = "https://example.test/*bg-zinc-900*/";
    <div>It's // text-white{/* bg-red-500 */}{"#def"}</div>;
  `;
  const findings = scanSource(path, source);
  assert.deepEqual(findings.filter(finding => finding.rule === "palette").map(finding => finding.value), ["bg-blue-500", "text-white", "bg-zinc-900", "text-white"]);
  assert.deepEqual(findings.filter(finding => finding.rule === "raw-hex").map(finding => finding.value), ["#abc", "#def"]);
  assert.deepEqual(scanSource(path, "<div>#abc</div>"), []);
});

test("comments between syntax nodes preserve import and hex context", () => {
  for (const source of [
    'require(/* text-white */ "react-icons/fa");',
    'import(/* text-white */ `@mdi/${pack}`);',
    'export { Icon } from /* text-white */ "react-icons/fa";',
  ]) assert.deepEqual(scanSource(path, source).map(finding => finding.rule), ["icon-library"], source);
  assert.deepEqual(scanSource(path, 'export default "react-icons/fa";'), []);
  assert.deepEqual(scanSource(path, 'const color = /* text-white */ "#1579";').map(finding => finding.value), ["#1579"]);
  assert.deepEqual(scanSource(path, 'node.style.setProperty(/* text-white */ "color", "#1579");').map(finding => finding.value), ["#1579"]);
});

test("renderer TS and TSX are scanned, including untracked files; tests are exempt", t => {
  const { directory, put } = fixture(t);
  for (const excluded of [`${renderer}Sample.test.tsx`, `${renderer}Sample.focus.test.ts`, `${renderer}Sample.spec.tsx`, `${renderer}__tests__/Sample.ts`, "apps/site/src/Sample.tsx", `${renderer}DesktopWorkspaceShell.testSupport.tsx`, `${renderer}EditorTestHarness.tsx`, `${renderer}editor/fixture.ts`, `${renderer}FileInspector.draft-fixture.ts`, `${renderer}editor/testDocs.ts`]) {
    assert.equal(isRendererSource(excluded), false, excluded);
    put(excluded, 'const color = "#fff";');
  }
  put(`${renderer}tokens.ts`, 'const color = "#fff";');
  assert.deepEqual(checkUiRules(directory, empty()).failures, []);
  put(`${renderer}Sample.ts`, 'const color = "#fff";');
  assert.match(checkUiRules(directory, empty()).failures.join("\n"), /Sample\.ts:1: raw-hex/u);
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
  assert.match(checkUiRules(directory, allowlist).failures.join("\n"), /count dropped from 2 to 1.*Remove or lower the entry/u);
  rmSync(join(directory, path));
  assert.match(checkUiRules(directory, allowlist).failures.join("\n"), /count dropped from 2 to 0.*Remove/u);
  put(`${renderer}New.tsx`, 'const color = "#fff";');
  assert.match(checkUiRules(directory, allowlist).failures.join("\n"), /New\.tsx:1: raw-hex/u);
});

test("malformed allowlist entries fail", t => {
  const { directory, put } = fixture(t);
  for (const entries of [1, null, [], {}, { typo: 1 }, { palette: 0 }, { palette: -1 }, { palette: 1.5 }, { palette: "1" }]) {
    assert.match(checkUiRules(directory, { violations: { [path]: entries } }).failures.join("\n"), /invalid entry/u, JSON.stringify(entries));
  }
  for (const allowlist of [null, {}, { violations: null }, { violations: [] }]) {
    assert.match(checkUiRules(directory, allowlist).failures.join("\n"), /invalid violations map/u);
  }
  assert.match(checkUiRules(directory, { violations: { [`${renderer}Sample.test.tsx`]: { palette: 1 } } }).failures.join("\n"), /invalid entry/u);
  put(path, '<div className="bg-black/20" />');
  assert.match(checkUiRules(directory, empty()).failures.join("\n"), /palette: bg-black\/20/u);
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
  assert.match(result.stderr, /UI rules check failed.*ReviewSample\.tsx:1: palette: bg-blue-500/su);
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
