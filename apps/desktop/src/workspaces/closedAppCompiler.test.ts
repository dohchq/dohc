import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppDocument, type AppPage } from "@dohc/app-browser/document";
import { compileClosedApp } from "./closedAppCompiler";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const file = (path: string, source: string) => {
  const bytes = new TextEncoder().encode(source);
  return { path, bytes, sha256: hash(bytes) };
};
const bounds = { maxInputFiles: 8, maxInputBytes: 100_000, maxOutputBytes: 100_000 };
afterEach(() => vi.unstubAllEnvs());

describe("closed app compiler", () => {
  it("captures SQL as metadata without admitting SQL imports into scripts", async () => {
    const schema = file("app/schema.sql", "CREATE TABLE responses(id TEXT PRIMARY KEY);");
    const result = await compileClosedApp({
      entryPath: "app/backend.ts",
      bounds,
      inputs: [file("app/backend.ts", "globalThis.operations = { list: () => [] };"), schema],
    });
    expect(result.dependencyLock.map((input) => input.path)).toEqual(["app/backend.ts"]);
    await expect(
      compileClosedApp({
        entryPath: "app/backend.ts",
        bounds,
        inputs: [file("app/backend.ts", "import './schema.sql';"), schema],
      }),
    ).rejects.toThrow(
      "app/backend.ts imports ./schema.sql. Published apps can include only JavaScript, TypeScript, JSON, CSS, images, and WOFF2 fonts, not .sql.",
    );
    await expect(
      compileClosedApp({ entryPath: schema.path, bounds, inputs: [schema] }),
    ).rejects.toThrow(/entry must be a script/);
  });
  it("bundles ordinary React TSX, createRoot, hooks, CSS and an asset from captured dependencies", async () => {
    const require = createRequire(import.meta.url);
    const reactRoot = dirname(require.resolve("react/package.json"));
    const domRoot = dirname(require.resolve("react-dom/package.json"));
    const schedulerRoot = dirname(
      createRequire(join(domRoot, "package.json")).resolve("scheduler/package.json"),
    );
    const captured = await Promise.all(
      [
        [reactRoot, "react", "index.js"],
        [reactRoot, "react", "cjs/react.production.js"],
        [reactRoot, "react", "jsx-runtime.js"],
        [reactRoot, "react", "cjs/react-jsx-runtime.production.js"],
        [domRoot, "react-dom", "index.js"],
        [domRoot, "react-dom", "cjs/react-dom.production.js"],
        [domRoot, "react-dom", "client.js"],
        [domRoot, "react-dom", "cjs/react-dom-client.production.js"],
        [schedulerRoot, "scheduler", "index.js"],
        [schedulerRoot, "scheduler", "cjs/scheduler.production.js"],
      ].map(async ([root, name, path]) => {
        const bytes = new Uint8Array(await readFile(join(root!, path!)));
        return { path: `deps/${name}/${path}`, bytes, sha256: hash(bytes) };
      }),
    );
    const result = await compileClosedApp({
      entryPath: "main.tsx",
      bounds: { maxInputFiles: 32, maxInputBytes: 5_000_000, maxOutputBytes: 5_000_000 },
      packageMap: {
        react: "deps/react/index.js",
        "react/jsx-runtime": "deps/react/jsx-runtime.js",
        "react-dom": "deps/react-dom/index.js",
        "react-dom/client": "deps/react-dom/client.js",
        scheduler: "deps/scheduler/index.js",
      },
      inputs: [
        ...captured,
        file(
          "main.tsx",
          `import { useState } from 'react';
        import { createRoot } from 'react-dom/client'; import './style.css'; import picture from './trip.png';
        function Poll() { const [count, setCount] = useState(0); return <button onClick={() => setCount(count + 1)}><img src={picture}/>Votes: {count}</button>; }
        const root = createRoot(document.getElementById('root')!); root.render(<Poll/>);
        globalThis.unmountPoll = () => root.unmount();`,
        ),
        file("style.css", "button { color: blue }"),
        {
          path: "trip.png",
          bytes: Uint8Array.from([137, 80, 78, 71]),
          sha256: hash(Uint8Array.from([137, 80, 78, 71])),
        },
      ],
    });
    expect(result.dependencyLock.map((input) => input.path)).toEqual(
      expect.arrayContaining(captured.map((input) => input.path)),
    );
    expect(result.files.map((output) => output.path)).toEqual(["bundle.css", "bundle.js"]);
    const { JSDOM } = require("jsdom") as {
      JSDOM: new (
        html: string,
        options: { runScripts: "outside-only" },
      ) => {
        window: Window & typeof globalThis & { unmountPoll?: () => void };
      };
    };
    const dom = new JSDOM('<div id="root"></div>', { runScripts: "outside-only" });
    try {
      // Executes a trusted test fixture to prove bundle compatibility, not runtime isolation.
      dom.window.eval(
        new TextDecoder().decode(result.files.find((output) => output.path === "bundle.js")!.bytes),
      );
      await vi.waitFor(() =>
        expect(dom.window.document.querySelector("button")?.textContent).toBe("Votes: 0"),
      );
      expect(dom.window.document.querySelector("img")?.src).toMatch(/^data:image\/png/);
      dom.window.document.querySelector("button")!.click();
      await vi.waitFor(() =>
        expect(dom.window.document.querySelector("button")?.textContent).toBe("Votes: 1"),
      );
    } finally {
      dom.window.unmountPoll?.();
      dom.window.close();
    }
  });

  it("refuses missing and escaping package targets, transitive imports, and invalid or oversized maps", async () => {
    const main = file("main.ts", "import 'trip'");
    for (const target of ["missing.js", "../private.js"]) {
      await expect(
        compileClosedApp({
          entryPath: "main.ts",
          inputs: [main],
          packageMap: { trip: target },
          bounds,
        }),
      ).rejects.toThrow();
    }
    await expect(
      compileClosedApp({
        entryPath: "main.ts",
        inputs: [main, file("deps/trip.js", "import 'react';")],
        packageMap: { trip: "deps/trip.js" },
        bounds,
      }),
    ).rejects.toThrow();
    await expect(
      compileClosedApp({
        entryPath: "main.ts",
        inputs: [main, file("deps/trip.js", "import '../private.js';")],
        packageMap: { trip: "deps/trip.js" },
        bounds,
      }),
    ).rejects.toThrow();
    for (const specifier of ["node:fs"]) {
      await expect(
        compileClosedApp({
          entryPath: "main.ts",
          inputs: [main],
          packageMap: { [specifier]: "main.ts" },
          bounds,
        }),
      ).rejects.toThrow();
    }
    await expect(
      compileClosedApp({
        entryPath: "main.ts",
        inputs: [main],
        packageMap: Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`trip${i}`, "main.ts"]),
        ),
        bounds,
      }),
    ).rejects.toThrow(/bound/);
  });

  it.each(["../../private.ts", "node:fs"])(
    "refuses outside or unresolved import %s",
    async (specifier) => {
      await expect(
        compileClosedApp({
          entryPath: "src/main.ts",
          inputs: [file("src/main.ts", `import '${specifier}'`)],
          bounds,
        }),
      ).rejects.toThrow();
    },
  );

  it.each([
    "console.log(import.meta.url)",
    "const x = './x'; import(x)",
    "try { require(name) } catch {}",
  ])("refuses runtime module resolution in %s", async (source) => {
    await expect(
      compileClosedApp({ entryPath: "src/main.ts", inputs: [file("src/main.ts", source)], bounds }),
    ).rejects.toThrow();
  });

  describe("HTML page entry", () => {
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const image = (path: string, bytes = png) => ({ path, bytes, sha256: hash(bytes) });
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const page = (
      html: string,
      ...others: Array<{ path: string; bytes: Uint8Array; sha256: string }>
    ) =>
      compileClosedApp({
        entryPath: "site/index.html",
        bounds,
        inputs: [
          file("site/index.html", /^<!doctype/i.test(html) ? html : `<!doctype html>${html}`),
          ...others,
        ],
      });
    const record = (result: Awaited<ReturnType<typeof compileClosedApp>>) =>
      JSON.parse(
        new TextDecoder().decode(result.files.find((output) => output.path === "page.json")!.bytes),
      ) as AppPage;
    const require = createRequire(import.meta.url);
    type Window = globalThis.Window &
      typeof globalThis & {
        log: string[];
        errors: string[];
        __dohcPage: Record<string, (index: number) => void>;
      };
    const { JSDOM } = require("jsdom") as {
      JSDOM: new (html: string, options: { runScripts: "dangerously" }) => { window: Window };
    };
    /**
     * Parses the published document in a DOM, as a guest's browser would, and waits until parsing ends.
     * JSDOM does not run module scripts, so runModules runs each module stub in document order, as a browser does after parsing.
     */
    const open = async (result: Awaited<ReturnType<typeof compileClosedApp>>) => {
      const document = createAppDocument(result.files, {
        maxBundleBytes: 1_000_000,
        maxDocumentBytes: 10_000_000,
      });
      // jsdom has no matchMedia, which the document's color scheme report reads.
      const dom = new JSDOM(
        document.html.replace(
          "<head>",
          "<head><script>window.log=[];window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));window.matchMedia=()=>({matches:false,addEventListener(){}})</script>",
        ),
        { runScripts: "dangerously" },
      );
      await vi.waitFor(() => expect(dom.window.document.readyState).not.toBe("loading"));
      const runModules = () => {
        for (const stub of [...dom.window.document.querySelectorAll('script[type="module"]')]) {
          try {
            dom.window.eval(stub.textContent!);
          } catch (error) {
            dom.window.errors.push((error as Error).message);
          }
        }
      };
      return {
        dom,
        window: dom.window,
        document: dom.window.document,
        runModules,
        html: document.html,
      };
    };

    it("lets the browser parse the page, so each classic script runs where it stands", async () => {
      const result = await page(
        `<!doctype html><html lang="fr"><head><title>Trip</title>
        <script type="application/json" id="config">{"stop":"Kyoto"}</script>
        <link rel="stylesheet" href="theme.css" id="sheet" media="screen">
        <style id="theme">p { margin: 0 }</style>
        <script>log.push("head:" + JSON.parse(document.getElementById("config").textContent).stop + ":" + !!document.body + ":" + document.getElementById("sheet").media + ":" + !!document.getElementById("theme"));</script></head>
        <body class="trip" style="background: url(map.png)"><div id="box"><script>log.push("parent:" + document.currentScript.parentElement.id + ":" + document.readyState + ":" + !!document.getElementById("after"));</script></div>
        <p id="after">After</p>
        <script src="data.js"></script>
        <script>document.write('<p id="written">Written</p>');</script>
        <script>"use strict"; log.push((function () { return this; })() === undefined ? "strict" : "sloppy");</script>
        <script>throw new Error("first script fails");</script>
        <script>let stops = []; log.push("not reached");</script>
        <script>log.push("after the failures:" + stops.length + ":" + !!document.getElementById("written"));</script>
        <script nomodule>window.legacy = true;</script></body></html>`,
        file("site/data.js", "var stops = ['Tokyo'];"),
        file("site/theme.css", "h1 { color: red }"),
        image("site/map.png"),
        file("site/unused.js", "throw new Error('unused')"),
      );
      expect(result.compiler.recipe).toBe("dohc-closed-app-v3");
      expect(result.files.map((output) => output.path)).toEqual(["bundle.js", "page.json"]);
      expect(result.dependencyLock.map((input) => input.path)).toEqual([
        "site/data.js",
        "site/index.html",
        "site/map.png",
        "site/theme.css",
      ]);
      // A browser that runs modules skips a nomodule script, so its text gets no hash and would not run.
      expect(record(result).scripts).not.toContain("window.legacy = true;");
      const { window, document } = await open(result);
      try {
        expect(document.documentElement.lang).toBe("fr");
        expect(document.title).toBe("Trip");
        expect(document.body.className).toBe("trip");
        expect(document.body.getAttribute("style")).toBe(`background: url(${dataUrl})`);
        expect(window.log).toEqual([
          "head:Kyoto:false:screen:true",
          "parent:box:loading:false",
          "strict",
          "after the failures:1:true",
        ]);
        expect(window.errors).toEqual([
          expect.stringContaining("first script fails"),
          expect.stringMatching(/stops/),
        ]);
        const sheet = document.getElementById("sheet")!;
        expect([
          sheet.tagName,
          sheet.parentElement!.tagName,
          sheet.getAttribute("media"),
          sheet.textContent,
        ]).toEqual(["STYLE", "HEAD", "screen", expect.stringContaining("color: red")]);
        expect(document.getElementById("theme")!.textContent).toMatch(/margin: 0/);
        expect(document.querySelector("#box > script")).not.toBeNull();
        expect(document.body.lastElementChild!.hasAttribute("nomodule")).toBe(true);
        // This test's log script, the link script, the data block, and the inline script; bundle.js removed itself.
        expect(document.querySelectorAll("head > script")).toHaveLength(4);
      } finally {
        window.close();
      }
    });

    it("runs deferred and module scripts from stubs at their places, in document order, each on its own", async () => {
      const result = await page(
        `<script type="module">import { next } from "./shared.js"; log.push("A:" + next()); throw new Error("A fails");</script>
        <script defer id="b" data-step="2" src="b.js"></script>
        <script type="module" src="c.js" id="c"></script>
        <script async src="d.js"></script>
        <p id="end"></p>`,
        file("site/shared.js", "let count = 0; export const next = () => ++count;"),
        file(
          "site/b.js",
          "var fromB = true; log.push('B:' + document.currentScript.id + ':' + document.currentScript.dataset.step + ':' + document.currentScript.hasAttribute('defer'));",
        ),
        file(
          "site/c.js",
          "import { next } from './shared.js'; log.push('C:' + next() + ':' + !!document.getElementById('end') + ':' + fromB);",
        ),
        file("site/d.js", "log.push('D');"),
      );
      const { window, document, runModules } = await open(result);
      try {
        // The first scripts are this test's own log and the link script; bundle.js removed itself.
        const scripts = () => [...document.scripts].slice(2);
        expect(
          scripts().map((script) => [script.getAttribute("type"), script.id, script.textContent]),
        ).toEqual([
          ["module", "", "__dohcPage.module(0);"],
          ["dohc-deferred-0", "b", expect.stringContaining("fromB")],
          ["module", "", "__dohcPage.defer(0);"],
          ["module", "c", "__dohcPage.module(1);"],
          ["dohc-deferred-1", "", "log.push('D');"],
          ["module", "", "__dohcPage.defer(1);"],
        ]);
        expect(document.querySelector('script[async][type="module"]')).not.toBeNull();
        runModules();
        expect(window.log).toEqual(["A:1", "B:b:2:true", "C:2:true:true", "D"]);
        expect(window.errors).toEqual([expect.stringContaining("A fails")]);
        expect(scripts().map((script) => script.getAttribute("type") ?? script.id)).toEqual([
          "module",
          "b",
          "module",
          "",
        ]);
      } finally {
        window.close();
      }
    });

    it("pins every script's hash in the page's security policy, and puts the policy before any page markup", async () => {
      const result = await page(
        '<html data-x="a&quot;b"><head><meta name="description" content="first"><script>window.one = 1;</script></head><body><script src="two.js"></script><template><script>window.three = 3;</script></template></body>',
        file("site/two.js", "window.two = 2;"),
      );
      const document = createAppDocument(result.files, {
        maxBundleBytes: 1_000_000,
        maxDocumentBytes: 10_000_000,
      });
      const pinned = (text: string) =>
        `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
      expect(document.scriptSources).toEqual(
        expect.arrayContaining([
          pinned("window.one = 1;"),
          pinned("window.two = 2;"),
          pinned("window.three = 3;"),
        ]),
      );
      expect(document.html).toMatch(
        /^<!doctype html><html data-x="a&quot;b"><head><meta charset="utf-8">.*<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ('sha256-[A-Za-z0-9+/=]+' ?)+;[^"]*"><script>/,
      );
      expect(document.html.indexOf("Content-Security-Policy")).toBeLessThan(
        document.html.indexOf('name="description"'),
      );
      expect(document.html).not.toMatch(/unsafe-inline'[^;]*script|strict-dynamic|unsafe-eval/);
    });

    describe("CSS that would end its <style> element", () => {
      const injection = ":root { --x: </style><script>window.ran = 1</script><style>; }";
      const template = "<template><script>window.ran = 1</script></template>";

      it("refuses a page stylesheet that esbuild prints with </style> in a custom property", async () => {
        await expect(
          page(
            `<link rel="stylesheet" href="theme.css">${template}`,
            file("site/theme.css", injection),
          ),
        ).rejects.toThrow(
          "site/theme.css contains </style>, which would end the stylesheet early in the page. Write it as \\3c/style instead.",
        );
        await expect(
          page(`<style>${injection.replace("</style>", "<\\/style>")}</style>${template}`),
        ).resolves.toBeTruthy();
      });
    });

    it.each([
      [
        '<script src="https://cdn.example.test/app.js"></script>',
        "site/index.html loads https://cdn.example.test/app.js from outside the app. Save a copy in the app folder and link to that instead.",
      ],
      [
        '<script src="missing.js"></script>',
        "site/index.html links missing.js, which is not in the app. Add the file or fix the link.",
      ],
      [
        '<img src="map.svg">',
        "site/index.html links map.svg as an image. Use a PNG, JPEG, GIF, WebP, or AVIF file instead.",
      ],
      [
        '<link rel="stylesheet" href="app.js">',
        "site/index.html links app.js as a stylesheet. Use a .css file instead.",
      ],
      [
        '<iframe src="other.html"></iframe>',
        "site/index.html embeds other.html in <iframe>. Published apps cannot embed other pages or files.",
      ],
      [
        '<button onclick="go()">Go</button>',
        "site/index.html has an onclick attribute on <button>. Published apps cannot run inline event handlers. Attach the handler in a script.",
      ],
      [
        '<script src="close.js"></script>',
        'site/close.js contains </script> or <!-- with <script>, which would end the script early in the page. Split the text, for example "<" + "/script>".',
      ],
      [
        '<script type="module">window.document.write("x")</script>',
        "A module script in site/index.html calls document.write. Published apps cannot write markup into the page.",
      ],
    ])("refuses %s and names the file", async (html, message) => {
      await expect(
        page(
          html,
          file("site/app.js", "document.writeln('x')"),
          file("site/app.css", "p{}"),
          file("site/close.js", "var s = '</script>';"),
        ),
      ).rejects.toThrow(message);
    });
  });

  describe("stylesheet URLs", () => {
    const css = (source: string) =>
      compileClosedApp({
        entryPath: "app/main.ts",
        bounds,
        inputs: [
          file("app/main.ts", "import './css/style.css'"),
          file("app/css/style.css", source),
        ],
      });

    it.each([
      [
        "url(data:text/html,<b>x</b>)",
        "app/css/style.css embeds a data URL of type text/html. Use an image or a WOFF2 font instead.",
      ],
      [
        "url(https://example.test/a.png)",
        "app/css/style.css loads https://example.test/a.png from outside the app.",
      ],
      [
        "url(../../../private.png)",
        "app/css/style.css imports ../../../private.png, which is outside the workspace.",
      ],
    ])("refuses %s and names the stylesheet", async (url, message) => {
      await expect(css(`.a { background: ${url} }`)).rejects.toThrow(message);
    });
  });

  it("rejects configuration, unsupported types, mismatched digests and invalid bounds", async () => {
    const input = file("main.ts", "export {};");
    for (const path of ["tsconfig.json", "package.json", "raw.html", "inline.svg", "native.node"]) {
      await expect(
        compileClosedApp({ entryPath: "main.ts", inputs: [input, file(path, "{}")], bounds }),
      ).rejects.toThrow();
    }
    const changed = { ...input, bytes: Uint8Array.from(input.bytes) };
    changed.bytes[0]! ^= 1;
    await expect(
      compileClosedApp({ entryPath: "main.ts", inputs: [changed], bounds }),
    ).rejects.toThrow(/digest/);
    for (const changedBounds of [
      { ...bounds, maxInputFiles: 0 },
      { ...bounds, maxInputBytes: 1 },
      { ...bounds, maxOutputFileBytes: 0 },
    ]) {
      await expect(
        compileClosedApp({
          entryPath: "main.ts",
          inputs: [file("main.ts", "console.log(1)")],
          bounds: changedBounds,
        }),
      ).rejects.toThrow(/bound/);
    }
    await expect(
      compileClosedApp({
        entryPath: "main.ts",
        inputs: [file("main.ts", "console.log(1)")],
        bounds: { ...bounds, maxOutputBytes: 1 },
      }),
    ).rejects.toThrow(
      "The built app is 1 KB. A published app can be at most 1 KB. Remove files and dependencies the app does not use.",
    );
  });

  it("owns its snapshot before callers mutate the input list and bytes", async () => {
    const inputs = [file("main.ts", "console.log('captured')")];
    const pending = compileClosedApp({ entryPath: "main.ts", inputs, bounds });
    inputs[0]!.bytes.fill(0);
    inputs.length = 0;
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
      await expect(
        build({
          absWorkingDir: parent,
          entryPoints: ["host.ts"],
          bundle: true,
          write: false,
          logLevel: "silent",
        }),
      ).rejects.toThrow();
      vi.stubEnv("TMPDIR", parent);
      vi.stubEnv("TMP", parent);
      vi.stubEnv("TEMP", parent);
      const result = await compileClosedApp({
        entryPath: "main.ts",
        inputs: [file("main.ts", "console.log('closed')")],
        bounds,
      });
      expect(result.dependencyLock.map((input) => input.path)).toEqual(["main.ts"]);
      await expect(
        compileClosedApp({
          entryPath: "main.ts",
          inputs: [
            file(
              "main.ts",
              `import ${JSON.stringify(join(parent, "private.ts").replaceAll("\\", "/"))}`,
            ),
          ],
          bounds,
        }),
      ).rejects.toThrow();
      expect(await readFile(join(parent, "private-config.json"), "utf8")).toContain(
        "invalid private",
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(parent, { recursive: true, force: true });
    }
  });
});

it("publishes Unicode HTML, script and percent-encoded asset paths", async () => {
  const result = await compileClosedApp({
    entryPath: "会议/index.html",
    bounds,
    inputs: [
      file(
        "会议/index.html",
        '<!doctype html><script src="' +
          encodeURIComponent("скрипт.js") +
          '"></script><img src="' +
          encodeURIComponent("图片.png") +
          '">',
      ),
      file("会议/скрипт.js", 'document.body.dataset.loaded = "yes";'),
      file("会议/图片.png", "image"),
    ],
  });
  expect(result.dependencyLock.map((file) => file.path)).toContain("会议/图片.png");
  expect(result.files.map((file) => file.path)).toContain("page.json");
});
