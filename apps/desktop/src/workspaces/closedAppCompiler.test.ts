import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileClosedApp } from "./closedAppCompiler";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const file = (path: string, source: string) => { const bytes = new TextEncoder().encode(source); return { path, bytes, sha256: hash(bytes) }; };
const bounds = { maxInputFiles: 8, maxInputBytes: 100_000, maxOutputBytes: 100_000 };
afterEach(() => vi.unstubAllEnvs());

describe("closed app compiler", () => {
  it("captures SQL as metadata without admitting SQL imports into scripts", async () => {
    const schema = file("app/schema.sql", "CREATE TABLE responses(id TEXT PRIMARY KEY);");
    const result = await compileClosedApp({ entryPath: "app/backend.ts", bounds,
      inputs: [file("app/backend.ts", "globalThis.operations = { list: () => [] };"), schema] });
    expect(result.dependencyLock.map(input => input.path)).toEqual(["app/backend.ts"]);
    await expect(compileClosedApp({ entryPath: "app/backend.ts", bounds,
      inputs: [file("app/backend.ts", "import './schema.sql';"), schema] })).rejects.toThrow(/Unsupported closed app input type/);
    await expect(compileClosedApp({ entryPath: schema.path, bounds, inputs: [schema] })).rejects.toThrow(/entry must be a script/);
  });
  it("binds a collection schema as captured metadata without allowing it as code", async () => {
    const schema = file("responses/collection.yaml", "fields: {}\n");
    const result = await compileClosedApp({ entryPath: "main.js", bounds,
      inputs: [file("main.js", "document.body.textContent = 'poll';"), schema] });
    expect(result.dependencyLock.map(input => input.path)).toEqual(["main.js"]);
    await expect(compileClosedApp({ entryPath: "main.js", bounds,
      inputs: [file("main.js", "import './responses/collection.yaml';"), schema] })).rejects.toThrow();
  });
  it("bundles ordinary React TSX, createRoot, hooks, CSS and an asset from captured dependencies", async () => {
    const require = createRequire(import.meta.url);
    const reactRoot = dirname(require.resolve("react/package.json"));
    const domRoot = dirname(require.resolve("react-dom/package.json"));
    const schedulerRoot = dirname(createRequire(join(domRoot, "package.json")).resolve("scheduler/package.json"));
    const captured = await Promise.all([
      [reactRoot, "react", "index.js"], [reactRoot, "react", "cjs/react.production.js"],
      [reactRoot, "react", "jsx-runtime.js"], [reactRoot, "react", "cjs/react-jsx-runtime.production.js"],
      [domRoot, "react-dom", "index.js"], [domRoot, "react-dom", "cjs/react-dom.production.js"],
      [domRoot, "react-dom", "client.js"], [domRoot, "react-dom", "cjs/react-dom-client.production.js"],
      [schedulerRoot, "scheduler", "index.js"], [schedulerRoot, "scheduler", "cjs/scheduler.production.js"],
    ].map(async ([root, name, path]) => {
      const bytes = new Uint8Array(await readFile(join(root!, path!)));
      return { path: `deps/${name}/${path}`, bytes, sha256: hash(bytes) };
    }));
    const result = await compileClosedApp({ entryPath: "main.tsx", bounds: { maxInputFiles: 32, maxInputBytes: 5_000_000, maxOutputBytes: 5_000_000 },
      packageMap: { react: "deps/react/index.js", "react/jsx-runtime": "deps/react/jsx-runtime.js",
        "react-dom": "deps/react-dom/index.js", "react-dom/client": "deps/react-dom/client.js", scheduler: "deps/scheduler/index.js" },
      inputs: [...captured, file("main.tsx", `import { useState } from 'react';
        import { createRoot } from 'react-dom/client'; import './style.css'; import picture from './trip.png';
        function Poll() { const [count, setCount] = useState(0); return <button onClick={() => setCount(count + 1)}><img src={picture}/>Votes: {count}</button>; }
        const root = createRoot(document.getElementById('root')!); root.render(<Poll/>);
        globalThis.unmountPoll = () => root.unmount();`), file("style.css", "button { color: blue }"),
        { path: "trip.png", bytes: Uint8Array.from([137, 80, 78, 71]), sha256: hash(Uint8Array.from([137, 80, 78, 71])) }],
    });
    expect(result.dependencyLock.map(input => input.path)).toEqual(expect.arrayContaining(captured.map(input => input.path)));
    expect(result.files.map(output => output.path)).toEqual(["bundle.css", "bundle.js"]);
    const { JSDOM } = require("jsdom") as { JSDOM: new (html: string, options: { runScripts: "outside-only" }) => {
      window: Window & typeof globalThis & { unmountPoll?: () => void };
    } };
    const dom = new JSDOM('<div id="root"></div>', { runScripts: "outside-only" });
    try {
      // Executes a trusted test fixture to prove bundle compatibility, not runtime isolation.
      dom.window.eval(new TextDecoder().decode(result.files.find(output => output.path === "bundle.js")!.bytes));
      await vi.waitFor(() => expect(dom.window.document.querySelector("button")?.textContent).toBe("Votes: 0"));
      expect(dom.window.document.querySelector("img")?.src).toMatch(/^data:image\/png/);
      dom.window.document.querySelector("button")!.click();
      await vi.waitFor(() => expect(dom.window.document.querySelector("button")?.textContent).toBe("Votes: 1"));
    } finally { dom.window.unmountPoll?.(); dom.window.close(); }
  });

  it("pins scoped package mappings and snapshots them before awaiting", async () => {
    const inputs = [file("main.ts", "import value from '@trip/ui/button'; console.log(value)"),
      file("deps/@trip/ui/first.js", "export default 'first'"), file("deps/@trip/ui/second.js", "export default 'second'")];
    const packageMap = { "@trip/ui/button": "deps/@trip/ui/first.js" };
    const pending = compileClosedApp({ entryPath: "main.ts", inputs, packageMap, bounds });
    packageMap["@trip/ui/button"] = "deps/@trip/ui/second.js";
    const first = await pending;
    const second = await compileClosedApp({ entryPath: "main.ts", inputs, packageMap, bounds });
    expect(new TextDecoder().decode(first.files[0]!.bytes)).toContain('"first"');
    expect(first.sourceDigest).not.toBe(second.sourceDigest);
    expect(first.dependencyLockDigest).not.toBe(second.dependencyLockDigest);
  });

  it("supports dotted package names and ignores map insertion order", async () => {
    const inputs = [file("main.ts", "import a from 'trip.ui'; import b from '@trip.tools/ui'; console.log(a, b)"),
      file("deps/first.js", "export default 'first'"), file("deps/second.js", "export default 'second'")];
    const entries = [["trip.ui", "deps/first.js"], ["@trip.tools/ui", "deps/second.js"]];
    const first = await compileClosedApp({ entryPath: "main.ts", inputs, packageMap: Object.fromEntries(entries), bounds });
    const reordered = await compileClosedApp({ entryPath: "main.ts", inputs, packageMap: Object.fromEntries([...entries].reverse()), bounds });
    expect(first.buildDigest).toBe(reordered.buildDigest);
  });

  it("does not grant package subpaths through a root mapping", async () => {
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", "import 'react/jsx-runtime'"), file("deps/react.js", "export {}")],
      packageMap: { react: "deps/react.js" }, bounds })).rejects.toThrow(/outside/);
  });

  it("rejects an override present when the compiler module loads after it is cleared", async () => {
    vi.resetModules();
    vi.stubEnv("ESBUILD_BINARY_PATH", "not-an-approved-compiler");
    try {
      const { compileClosedApp: loadedWithOverride } = await import("./closedAppCompiler");
      vi.unstubAllEnvs();
      await expect(loadedWithOverride({ entryPath: "main.ts", inputs: [file("main.ts", "export {}")], bounds })).rejects.toThrow(/installation/);
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });

  it.each(["react", "react/jsx-runtime", "react-dom/client"])("never resolves installed package %s without an explicit map", async specifier => {
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", `import '${specifier}'`)], bounds })).rejects.toThrow();
  });

  it("refuses missing and escaping package targets, transitive imports, and invalid or oversized maps", async () => {
    const main = file("main.ts", "import 'trip'");
    for (const target of ["missing.js", "../private.js", "/private.js", "C:/private.js"]) {
      await expect(compileClosedApp({ entryPath: "main.ts", inputs: [main], packageMap: { trip: target }, bounds })).rejects.toThrow();
    }
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [main, file("deps/trip.js", "import 'react';")], packageMap: { trip: "deps/trip.js" }, bounds })).rejects.toThrow();
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [main, file("deps/trip.js", "import '../private.js';")], packageMap: { trip: "deps/trip.js" }, bounds })).rejects.toThrow();
    for (const specifier of ["../trip", "@../trip", "trip/../private", "node:fs", "https://host/script.js"]) {
      await expect(compileClosedApp({ entryPath: "main.ts", inputs: [main], packageMap: { [specifier]: "main.ts" }, bounds })).rejects.toThrow();
    }
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [main], packageMap: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`trip${i}`, "main.ts"])), bounds })).rejects.toThrow(/bound/);
  });

  it("bundles declared TypeScript, JSON and literal dynamic imports without executing source", async () => {
    const inputs = [file("src/main.ts", "import { answer } from './answer.ts'; import data from './data.json'; import('./later.ts'); throw new Error(String(answer + data.n))"),
      file("src/answer.ts", "export const answer: number = 42"), file("src/data.json", '{"n":1}'), file("src/later.ts", "export const later = 9")];
    const result = await compileClosedApp({ entryPath: "src/main.ts", inputs, bounds });
    expect(result.dependencyLock.map(input => input.path)).toEqual(["src/answer.ts", "src/data.json", "src/later.ts", "src/main.ts"]);
    expect(result.compiler.version).toBe("0.28.1");
    expect(result.compiler.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.files[0]!.sha256).toBe(hash(result.files[0]!.bytes));
    const again = await compileClosedApp({ entryPath: "src/main.ts", inputs: [...inputs].reverse(), bounds });
    expect(again.buildDigest).toBe(result.buildDigest);
    const changed = await compileClosedApp({ entryPath: "src/main.ts", inputs: [file("src/main.ts", "console.log('changed')")], bounds });
    expect(changed.sourceDigest).not.toBe(result.sourceDigest);
    expect(changed.bundleDigest).not.toBe(result.bundleDigest);
  });

  it.each(["../../private.ts", "./missing.ts", "/etc/passwd", "C:/private.ts", "file:///private.ts", "https://example.test/x.ts", "lodash", "node:fs"])("refuses outside or unresolved import %s", async specifier => {
    await expect(compileClosedApp({ entryPath: "src/main.ts", inputs: [file("src/main.ts", `import '${specifier}'`)], bounds })).rejects.toThrow();
  });

  it("refuses a transitive import of an undeclared private file", async () => {
    await expect(compileClosedApp({ entryPath: "src/main.ts", inputs: [file("src/main.ts", "import './nested.ts'"),
      file("src/nested.ts", "import '../../private.ts'")], bounds })).rejects.toThrow();
  });

  it.each(["console.log(import.meta.url)", "console.log(import /* comment */ . meta ['url'])", "const x = './x'; import(x)", "const x = './x'; import(`./${x}.ts`)", "try { require(name) } catch {}"])("refuses runtime module resolution in %s", async source => {
    await expect(compileClosedApp({ entryPath: "src/main.ts", inputs: [file("src/main.ts", source)], bounds })).rejects.toThrow();
  });

  it("resolves CSS imports and embeds declared passive assets", async () => {
    const result = await compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", "import './style.css'"),
      file("style.css", "@import './other.css'; body { background: url('./image.png') }"), file("other.css", "p { color: red }"),
      { path: "image.png", bytes: Uint8Array.from([137, 80, 78, 71]), sha256: hash(Uint8Array.from([137, 80, 78, 71])) }], bounds });
    expect(result.files.map(output => output.path)).toEqual(["bundle.css", "bundle.js"]);
    expect(new TextDecoder().decode(result.files[0]!.bytes)).toContain("data:image/png");
  });

  it.each(["https://example.test/a.png", "data:image/png;base64,AAAA", "../private.png"])("refuses undeclared CSS URL %s", async url => {
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", "import './style.css'"),
      file("style.css", `body { background: url('${url}') }`)], bounds })).rejects.toThrow();
  });

  it("rejects configuration, unsupported types, mismatched digests and invalid bounds", async () => {
    const input = file("main.ts", "export {};");
    for (const path of ["tsconfig.json", "package.json", "raw.html", "inline.svg", "native.node"]) {
      await expect(compileClosedApp({ entryPath: "main.ts", inputs: [input, file(path, "{}")], bounds })).rejects.toThrow();
    }
    const changed = { ...input, bytes: Uint8Array.from(input.bytes) }; changed.bytes[0]! ^= 1;
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [changed], bounds })).rejects.toThrow(/digest/);
    for (const changedBounds of [{ ...bounds, maxInputFiles: 0 }, { ...bounds, maxInputBytes: 1 }, { ...bounds, maxOutputBytes: 1 }]) {
      await expect(compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", "console.log(1)")], bounds: changedBounds })).rejects.toThrow(/bound/);
    }
  });

  it("owns its snapshot before callers mutate the input list and bytes", async () => {
    const inputs = [file("main.ts", "console.log('captured')")];
    const pending = compileClosedApp({ entryPath: "main.ts", inputs, bounds });
    inputs[0]!.bytes.fill(0); inputs.length = 0;
    const result = await pending;
    expect(new TextDecoder().decode(result.files[0]!.bytes)).toContain("captured");
  });

  it("does not discover parent tsconfig, extends, or package metadata", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dohc-app-config-proof-"));
    try {
      await writeFile(join(parent, "host.ts"), "console.log(1)");
      await writeFile(join(parent, "tsconfig.json"), '{"extends":"./private-config.json"}');
      await writeFile(join(parent, "private-config.json"), "{ invalid private configuration");
      await writeFile(join(parent, "package.json"), "{ invalid host package metadata");
      await writeFile(join(parent, "private.ts"), "export const privateValue = 'not-declared'");
      // Positive control: ordinary filesystem resolution encounters this poisoned host state.
      await expect(build({ absWorkingDir: parent, entryPoints: ["host.ts"], bundle: true, write: false, logLevel: "silent" })).rejects.toThrow();
      vi.stubEnv("TMPDIR", parent); vi.stubEnv("TMP", parent); vi.stubEnv("TEMP", parent);
      const result = await compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", "console.log('closed')")], bounds });
      expect(result.dependencyLock.map(input => input.path)).toEqual(["main.ts"]);
      await expect(compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", `import ${JSON.stringify(join(parent, "private.ts").replaceAll("\\", "/"))}`)], bounds })).rejects.toThrow();
      expect(await readFile(join(parent, "private-config.json"), "utf8")).toContain("invalid private");
    } finally { vi.unstubAllEnvs(); await rm(parent, { recursive: true, force: true }); }
  });
});
