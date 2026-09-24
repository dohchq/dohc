import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_PAGE_MAX_SCRIPTS, createAppDocument, type AppPage } from "@dohc/app-browser/document";
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
      inputs: [file("app/backend.ts", "import './schema.sql';"), schema] })).rejects.toThrow("app/backend.ts imports ./schema.sql. Published apps can include only JavaScript, TypeScript, JSON, CSS, images, and WOFF2 fonts, not .sql.");
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
      packageMap: { react: "deps/react.js" }, bounds })).rejects.toThrow("main.ts imports the package react/jsx-runtime, which app.publish.json does not map.");
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

  it.each(["https://example.test/a.png", "../private.png"])("refuses undeclared CSS URL %s", async url => {
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", "import './style.css'"),
      file("style.css", `body { background: url('${url}') }`)], bounds })).rejects.toThrow();
  });

  describe("HTML page entry", () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    const image = (path: string, bytes = png) => ({ path, bytes, sha256: hash(bytes) });
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const page = (html: string, ...others: Array<{ path: string; bytes: Uint8Array; sha256: string }>) => compileClosedApp({ entryPath: "site/index.html", bounds,
      inputs: [file("site/index.html", html), ...others] });
    const record = (result: Awaited<ReturnType<typeof compileClosedApp>>) => JSON.parse(new TextDecoder().decode(result.files.find(output => output.path === "page.json")!.bytes)) as AppPage;
    const require = createRequire(import.meta.url);
    type Window = globalThis.Window & typeof globalThis & { log: string[]; errors: string[]; blobs: Blob[] };
    const { JSDOM } = require("jsdom") as { JSDOM: new (html: string, options: { runScripts: "dangerously" }) => { window: Window } };
    /** Runs the published document in a DOM, as a guest's browser would load it, and waits until parsing ends. */
    const open = async (result: Awaited<ReturnType<typeof compileClosedApp>>) => {
      const document = createAppDocument(result.files, { maxBundleBytes: 1_000_000, maxDocumentBytes: 10_000_000 });
      const dom = new JSDOM(document.html.replace("</head>", "<script>window.log=[];window.errors=[];window.blobs=[];window.addEventListener('error',e=>window.errors.push(e.message));" +
        "URL.createObjectURL=blob=>'blob:test/'+(window.blobs.push(blob)-1)</script></head>"), { runScripts: "dangerously" });
      await vi.waitFor(() => expect(dom.window.document.readyState).not.toBe("loading"));
      await new Promise(resolve => dom.window.setTimeout(resolve, 0));
      return dom;
    };

    it("builds the page in order, so each classic script sees only what precedes it and stands where it was written", async () => {
      const result = await page(`<!doctype html><html lang="fr"><head><title>Trip</title>
        <script type="application/json" id="config">{"stop":"Kyoto"}</script>
        <script>log.push("head:" + JSON.parse(document.getElementById("config").textContent).stop + ":" + !!document.getElementById("after"));</script></head>
        <body class="trip"><div id="box"><script>log.push("parent:" + document.currentScript.parentElement.id + ":" + document.readyState);</script></div>
        <p id="after">After</p>
        <script src="data.js"></script>
        <script>"use strict"; log.push((function () { return this; })() === undefined ? "strict" : "sloppy");</script>
        <script>throw new Error("first script fails");</script>
        <script>let stops = []; log.push("not reached");</script>
        <script>log.push("after the failures:" + stops.length + ":" + !!document.getElementById("after"));</script>
        <script nomodule>log.push("nomodule");</script></body></html>`,
        file("site/data.js", "var stops = ['Tokyo'];"), file("site/unused.js", "throw new Error('unused')"));
      expect(result.compiler.recipe).toBe("dohc-closed-app-v3");
      expect(result.files.map(output => output.path)).toEqual(["bundle.js", "page.json"]);
      expect(result.dependencyLock.map(input => input.path)).toEqual(["site/data.js", "site/index.html"]);
      const dom = await open(result);
      try {
        const document = dom.window.document;
        expect(document.documentElement.lang).toBe("fr");
        expect(document.title).toBe("Trip");
        expect(document.body.className).toBe("trip");
        expect(document.getElementById("config")!.textContent).toBe('{"stop":"Kyoto"}');
        expect(dom.window.log).toEqual(["head:Kyoto:false", "parent:box:loading", "strict", "after the failures:1:true"]);
        expect(dom.window.errors).toEqual([expect.stringContaining("first script fails"), expect.stringMatching(/stops/)]);
        expect(document.querySelector("#box > script")).not.toBeNull();
        expect(document.body.lastElementChild!.hasAttribute("nomodule")).toBe(true);
      } finally { dom.window.close(); }
    });

    // JSDOM does not run a script whose text is set after insertion, as browsers do for deferred scripts; the @apps e2e covers that order in Chromium.
    it("runs module scripts in document order once parsing ends, each on its own, sharing imported modules", async () => {
      const result = await page(`<script type="module">import { next } from "./shared.js"; log.push("A:" + next() + ":" + document.currentScript); throw new Error("A fails");</script>
        <script defer src="b.js"></script>
        <script type="module" src="c.js"></script>
        <p id="end"></p>`,
        file("site/shared.js", "let count = 0; export const next = () => ++count;"),
        file("site/b.js", "log.push('B:' + document.readyState + ':' + document.currentScript.hasAttribute('defer'));"),
        file("site/c.js", "import { next } from './shared.js'; log.push('C:' + next() + ':' + !!document.getElementById('end'));"));
      expect(record(result)).toMatchObject({ modules: 2, scripts: [expect.stringContaining("'B:'")] });
      // Scripts before any content land in <head>, as a browser parses them.
      expect(record(result).head.filter(node => typeof node === "object" && "tag" in node && node.tag === "script"))
        .toEqual([expect.objectContaining({ module: 0, children: [] }), expect.objectContaining({ defer: 0, attrs: [["defer", ""]] }), expect.objectContaining({ module: 1, attrs: [["type", "module"]] })]);
      const dom = await open(result);
      try {
        await vi.waitFor(() => expect(dom.window.log).toHaveLength(2));
        expect(dom.window.log).toEqual(["A:1:null", "C:2:true"]);
        expect(dom.window.errors).toEqual([expect.stringContaining("A fails")]);
      } finally { dom.window.close(); }
    });

    it("keeps each stylesheet's media condition", async () => {
      const result = await page('<link rel="stylesheet" href="print.css" media="print"><style media="(min-width: 600px)">p { color: blue }</style><style>p { margin: 0 }</style>',
        file("site/print.css", "body { color: red }"));
      const css = new TextDecoder().decode(result.files[0]!.bytes);
      expect(css).toMatch(/@media print {\s*body {\s*color: red;/);
      expect(css).toMatch(/@media \(min-width: 600px\) {\s*p {\s*color: blue;/);
      expect(css).toMatch(/}\s*}\s*(?:\/\*[^*]*\*\/\s*)?p {\s*margin: 0;/);
    });

    it("embeds each local image once and shares one blob URL across its references", async () => {
      const result = await page(`<img alt="a" src="map.png"><img alt="b" srcset="map.png 1x, img/Big.PNG 2x" src="https://example.test/remote.png">
        <picture><source srcset="map.png"><img alt="c" src="//cdn.example.test/x.png"></picture><video poster="map.png" src="https://example.test/v.mp4"></video>
        <div style="background: url('img/Big.PNG')"></div><svg><image href="map.png"/><use xlink:href="#icon"/></svg>
        <template><img alt="d" src="map.png"><script>window.fromTemplate = true;</script></template>`, image("site/map.png"), image("site/img/Big.PNG"));
      expect(result.dependencyLock.map(input => input.path)).toEqual(["site/img/Big.PNG", "site/index.html", "site/map.png"]);
      expect(record(result).images).toEqual([dataUrl, dataUrl]);
      expect(record(result).scripts).toEqual(["window.fromTemplate = true;"]);
      const dom = await open(result);
      try {
        const document = dom.window.document;
        expect(dom.window.blobs.map(blob => [blob.type, blob.size])).toEqual([["image/png", png.byteLength], ["image/png", png.byteLength]]);
        expect(Buffer.from(await dom.window.blobs[0]!.arrayBuffer())).toEqual(Buffer.from(png));
        expect(document.querySelector("img[alt=a]")!.getAttribute("src")).toBe("blob:test/0");
        expect(document.querySelector("img[alt=b]")!.getAttribute("srcset")).toBe("blob:test/0 1x, blob:test/1 2x");
        expect(document.querySelector("img[alt=b]")!.getAttribute("src")).toBe("https://example.test/remote.png");
        expect(document.querySelector("source")!.getAttribute("srcset")).toBe("blob:test/0");
        expect(document.querySelector("img[alt=c]")!.getAttribute("src")).toBe("//cdn.example.test/x.png");
        expect(document.querySelector("video")!.getAttribute("poster")).toBe("blob:test/0");
        expect(document.querySelector("div")!.getAttribute("style")).toBe("background: url('blob:test/1')");
        expect(document.querySelector("image")!.getAttribute("href")).toBe("blob:test/0");
        expect(document.querySelector("use")!.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("#icon");
        const template = document.querySelector("template")!.content;
        expect(template.querySelector("img")!.getAttribute("src")).toBe("blob:test/0");
        expect(template.querySelector("script")!.textContent).toBe("window.fromTemplate = true;");
        expect((dom.window as unknown as { fromTemplate?: boolean }).fromTemplate).toBeUndefined();
      } finally { dom.window.close(); }
    });

    it("keeps building the page after page markup or scripts replace document methods", async () => {
      const dom = await open(await page(`<img name="createElement" alt="clobber"><form name="createComment"><input name="appendChild"><input name="setAttribute" value="x"></form>
        <script>document.createElement = () => { throw new Error("replaced"); }; document.createTextNode = null; Node.prototype.appendChild = null;</script>
        <!-- note --><p id="later" title="kept">Later</p><script>log.push("ran:" + document.getElementById("later").title)</script>`));
      try {
        expect(dom.window.log).toEqual(["ran:kept"]);
        expect(dom.window.errors).toEqual([]);
        expect(dom.window.document.querySelectorAll("form input")).toHaveLength(2);
      } finally { dom.window.close(); }
    });

    it("keeps attributes the DOM methods refuse, such as @click", async () => {
      const dom = await open(await page('<button @click="open = true" :class="{ on: open }" x-on:keydown.enter="go()">Go</button>'));
      try {
        const button = dom.window.document.querySelector("button")!;
        expect([...button.attributes].map(attribute => [attribute.name, attribute.value])).toEqual([["@click", "open = true"], [":class", "{ on: open }"], ["x-on:keydown.enter", "go()"]]);
      } finally { dom.window.close(); }
    });

    it("resolves links from the first local <base> outside templates and removes only its address", async () => {
      const result = await page('<template><base href="wrong/"></template><base href="assets/" target="_blank"><link rel="stylesheet" href="style.css"><img alt="m" src="map.png">',
        file("site/assets/style.css", "h1 { color: blue }"), image("site/assets/map.png"));
      expect(result.dependencyLock.map(input => input.path)).toEqual(["site/assets/map.png", "site/assets/style.css", "site/index.html"]);
      const dom = await open(result);
      try {
        const bases = dom.window.document.querySelectorAll("base");
        expect(bases).toHaveLength(1);
        expect([...bases[0]!.attributes].map(attribute => attribute.name)).toEqual(["target"]);
        expect(dom.window.document.querySelector("template")!.content.querySelector("base")!.getAttribute("href")).toBe("wrong/");
      } finally { dom.window.close(); }
    });

    it(`refuses a page with more than ${APP_PAGE_MAX_SCRIPTS} scripts and names it`, async () => {
      await expect(page("<script>1</script>".repeat(APP_PAGE_MAX_SCRIPTS))).resolves.toBeTruthy();
      await expect(page("<script>1</script>".repeat(APP_PAGE_MAX_SCRIPTS + 1))).rejects.toThrow(`site/index.html has more than ${APP_PAGE_MAX_SCRIPTS} scripts. Published apps can run at most ${APP_PAGE_MAX_SCRIPTS}. Combine some scripts into one file.`);
    });

    it("names the largest image when embedded images make the page too large", async () => {
      const big = Uint8Array.from({ length: 30_000 }, (_, index) => index % 251);
      const small = { entryPath: "site/index.html", inputs: [file("site/index.html", '<img src="big.png"><img srcset="big.png 2x"><img src="map.png">'), image("site/big.png", big), image("site/map.png")] };
      await expect(compileClosedApp({ ...small, bounds: { ...bounds, maxOutputBytes: 100_000 } })).resolves.toBeTruthy();
      await expect(compileClosedApp({ ...small, bounds: { ...bounds, maxOutputBytes: 100_000, maxOutputFileBytes: 20_000 } }))
        .rejects.toThrow("site/index.html is 40 KB once its images are embedded. A published page can be at most 20 KB. The largest image is site/big.png (30 KB). Use smaller images.");
    });

    it.each([
      ['<script src="https://cdn.example.test/app.js"></script>', "site/index.html loads https://cdn.example.test/app.js from outside the app. Save a copy in the app folder and link to that instead."],
      ['<link rel="stylesheet" href="//fonts.example.test/a.css">', "site/index.html loads //fonts.example.test/a.css from outside the app."],
      ['<script src="missing.js"></script>', "site/index.html links missing.js, which is not in the app. Add the file or fix the link."],
      ['<img src="map.svg">', "site/index.html links map.svg as an image. Use a PNG, JPEG, GIF, WebP, or AVIF file instead."],
      ['<img src="my%20map.png">', "site/index.html links my map.png. Rename it using only letters, digits, and _ @ . / -, then publish again."],
      ['<img srcset="missing.png 2x">', "site/index.html links missing.png, which is not in the app."],
      ['<link rel="stylesheet" href="app.js">', "site/index.html links app.js as a stylesheet. Use a .css file instead."],
      ['<link rel="stylesheet" href="app.css" disabled>', "site/index.html links the stylesheet app.css as disabled. Published apps apply every stylesheet."],
      ['<style media="print; } body { color: red">p{}</style>', 'site/index.html gives a <style> the media condition "print; } body { color: red", which published apps cannot carry.'],
      ['<video src="intro.mp4"></video>', "site/index.html links intro.mp4 as audio or video. Published apps cannot include local audio or video."],
      ['<iframe src="other.html"></iframe>', "site/index.html embeds other.html in <iframe>. Published apps cannot embed other pages or files."],
      ['<iframe srcdoc="<p>hi</p>"></iframe>', "site/index.html embeds a page with <iframe srcdoc>. Published apps cannot embed other pages."],
      ['<svg><script>alert(1)</script></svg>', "site/index.html has a <script> inside <svg>. Published apps run only HTML scripts. Move the script out of the SVG."],
      ['<template><script src="app.js"></script></template>', 'site/index.html has a <script src="app.js"> inside <template>. Published apps can run only inline scripts from templates.'],
      ['<base href="https://example.test/">', "site/index.html sets its base address to https://example.test/. Remove the <base> element"],
      ['<button onclick="go()">Go</button>', "site/index.html has an onclick attribute. Published apps cannot run inline event handlers. Attach the handler in a script."],
      ["<script>import('./app.js')</script>", 'A script in site/index.html imports a module. Load it with <script type="module"> instead.'],
      ["<script>let = ;</script>", "A script in site/index.html is not valid JavaScript"],
      ["<script>document.write('<p>hi</p>')</script>", "A script in site/index.html calls document.write. Published apps cannot write markup where a script stands."],
      ['<script defer src="app.js"></script>', "site/app.js calls document.writeln."],
      ['<script type="module">window.document.write("x")</script>', "A module script in site/index.html calls document.write. Published apps cannot write markup into the page."],
      ['<script type="module">import "./secret.ts"</script>', "site/index.html imports ./secret.ts, which is not in the app. Add the file, or list it in app.publish.json."],
      ['<script type="module">import "./data.yaml"</script>', "site/index.html imports ./data.yaml. Published apps can include only JavaScript, TypeScript, JSON, CSS, images, and WOFF2 fonts, not .yaml."],
      ["<frameset></frameset>", "site/index.html uses <frameset>. Published apps need a page with a <body>."],
      ["<div =x>hi</div>", 'site/index.html has an attribute named "=x". A published page cannot carry that name. Rename or remove the attribute.'],
      ["<div a\u00a0b>hi</div>", `site/index.html has an attribute named ${JSON.stringify("a\u00a0b")}. A published page cannot carry that name.`],
    ])("refuses %s and names the file", async (html, message) => {
      await expect(page(html, file("site/app.js", "document.writeln('x')"), file("site/app.css", "p{}"))).rejects.toThrow(message);
    });

    it("accepts the same forms when the files are in the app", async () => {
      const result = await page('<script src="app.js"></script><link rel="stylesheet" href="app.css"><img src="map.png"><img srcset="map.png 2x"><script type="module">import "./secret.ts"</script><template><script>1</script></template><svg><image href="map.png"/></svg>',
        file("site/app.js", "window.app = 1;"), file("site/app.css", "p{}"), image("site/map.png"), file("site/secret.ts", "export const secret: number = 1;"));
      expect(result.dependencyLock.map(input => input.path)).toEqual(["site/app.css", "site/app.js", "site/index.html", "site/map.png", "site/secret.ts"]);
    });

    it("accepts HTML as the entry and only as the entry", async () => {
      await expect(page("<p>Only a page</p>")).resolves.toMatchObject({ files: [{ path: "bundle.js" }, { path: "page.json" }] });
      await expect(compileClosedApp({ entryPath: "site/main.js", bounds, inputs: [file("site/main.js", "export {}"), file("site/index.html", "<p>")] })).rejects.toThrow(/Unsupported closed app input type/);
    });
  });

  describe("stylesheet URLs", () => {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const css = (source: string, ...others: Array<{ path: string; bytes: Uint8Array; sha256: string }>) => compileClosedApp({ entryPath: "app/main.ts", bounds,
      inputs: [file("app/main.ts", "import './css/style.css'"), file("app/css/style.css", source), ...others] });

    it("resolves bare names from the stylesheet, keeps fragments, and keeps written image data URLs", async () => {
      const result = await css(`@import "theme.css"; .a { background: url(img/bg.png?v=2#x) } .b { marker: url(#arrow) }
        .c { background: url(data:image/png;base64,iVBORw==) } @font-face { font-family: A; src: url(Font.WOFF2?#iefix) }`,
        file("app/css/theme.css", "p { color: red }"), { path: "app/css/img/bg.png", bytes: png, sha256: hash(png) }, { path: "app/css/Font.WOFF2", bytes: png, sha256: hash(png) });
      const output = new TextDecoder().decode(result.files[0]!.bytes);
      expect(output).toContain("color: red");
      expect(output).toContain("url(#arrow)");
      expect(output).toContain("url(data:image/png;base64,iVBORw==)");
      expect(output.match(/url\(data:(?:image\/png|font\/woff2)/g)).toHaveLength(3);
    });

    it.each([
      ["url(img/missing.png)", "app/css/style.css imports img/missing.png, which is not in the app."],
      ["url(img/my%20bg.png)", "app/css/style.css imports img/my%20bg.png. Rename it using only letters, digits, and _ @ . / -, then publish again."],
      ["url(img/bg.svg)", "app/css/style.css imports img/bg.svg. Published apps can include only JavaScript, TypeScript, JSON, CSS, images, and WOFF2 fonts, not .svg."],
      ["url(data:text/html,<b>x</b>)", "app/css/style.css embeds a data URL of type text/html. Use an image or a WOFF2 font instead."],
      ["url(https://example.test/a.png)", "app/css/style.css loads https://example.test/a.png from outside the app."],
      ["url(../../../private.png)", "app/css/style.css imports ../../../private.png, which is outside the workspace."],
    ])("refuses %s and names the stylesheet", async (url, message) => {
      await expect(css(`.a { background: ${url} }`)).rejects.toThrow(message);
    });
  });

  it("rejects configuration, unsupported types, mismatched digests and invalid bounds", async () => {
    const input = file("main.ts", "export {};");
    for (const path of ["tsconfig.json", "package.json", "raw.html", "inline.svg", "native.node"]) {
      await expect(compileClosedApp({ entryPath: "main.ts", inputs: [input, file(path, "{}")], bounds })).rejects.toThrow();
    }
    const changed = { ...input, bytes: Uint8Array.from(input.bytes) }; changed.bytes[0]! ^= 1;
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [changed], bounds })).rejects.toThrow(/digest/);
    for (const changedBounds of [{ ...bounds, maxInputFiles: 0 }, { ...bounds, maxInputBytes: 1 }, { ...bounds, maxOutputFileBytes: 0 }]) {
      await expect(compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", "console.log(1)")], bounds: changedBounds })).rejects.toThrow(/bound/);
    }
    await expect(compileClosedApp({ entryPath: "main.ts", inputs: [file("main.ts", "console.log(1)")], bounds: { ...bounds, maxOutputBytes: 1 } }))
      .rejects.toThrow("The built app is 1 KB. A published app can be at most 1 KB. Remove files and dependencies the app does not use.");
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
