import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { APP_BUNDLE_CONTENT_TYPES, APP_PAGE_MAX_DEPTH, APP_PAGE_MAX_SCRIPTS, createAppDocument, type AppDocumentFile, type AppPage } from "@dohc/app-browser/document";
import { APP_PUBLICATION_MAX_BUNDLE_BYTES, APP_PUBLICATION_MAX_DOCUMENT_BYTES } from "@dohc/security-contract/app-publication";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (html: string, options?: { runScripts: "dangerously" }) => {
  window: Window & typeof globalThis & { value?: string; log?: string[] };
} };

const limits = { maxBundleBytes: 4096, maxDocumentBytes: 8192 };
function file(path: string, text: string): AppDocumentFile {
  const bytes = Buffer.from(text);
  return { path, bytes, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: APP_BUNDLE_CONTENT_TYPES[path] ?? "text/css; charset=utf-8" };
}

describe("compiled app document", () => {
  it("pins loader and exact script text, preserving UTF-8 and original line endings", () => {
    const original = 'window.value="😀";\r\nwindow.ready=true;\r';
    const output = createAppDocument([file("bundle.js", original)], limits);
    const dom = new JSDOM(output.html, { runScripts: "dangerously" });
    const scripts = [...dom.window.document.querySelectorAll("script")];
    expect(scripts).toHaveLength(2);
    expect(scripts[1]!.textContent).toBe(original);
    for (const node of scripts) {
      const source = `'sha256-${createHash("sha256").update(node.textContent!).digest("base64")}'`;
      expect(output.scriptSources).toContain(source);
      expect(dom.window.document.querySelector('meta[http-equiv]')!.getAttribute("content")).toContain(source);
    }
    expect(dom.window.value).toBe("😀");
    expect(output.byteLength).toBe(Buffer.byteLength(output.html));
    dom.window.close();
  });

  it.each(['</script><script src="https://evil.test/a.js">', '</ScRiPt\n>', '<!--<script>', '</style><img src=x>'])
    ("keeps HTML syntax inside source text: %s", attack => {
      const output = createAppDocument([file("bundle.js", `window.value=${JSON.stringify(attack)}`), file("bundle.css", `/*${attack}*/`)], limits);
      const dom = new JSDOM(output.html, { runScripts: "dangerously" });
      expect(dom.window.value).toBe(attack);
      expect(dom.window.document.querySelectorAll("script[src],img")).toHaveLength(0);
      expect(dom.window.document.querySelector("style")!.textContent).toBe(`/*${attack}*/`);
      dom.window.close();
    });

  it("refuses altered bytes, active asset names, duplicates, and missing scripts", () => {
    const altered = file("bundle.js", "console.log(1)");
    altered.bytes[0] = 0;
    for (const inventory of [[altered], [file("../bundle.js", "")], [file("bundle.js", ""), file("bundle.js", "")], [file("bundle.css", "")]]) {
      expect(() => createAppDocument(inventory, limits)).toThrow();
    }
  });

  it("bounds original and rendered bytes independently", () => {
    const inputs = [file("bundle.js", "/*😀*/")];
    expect(() => createAppDocument(inputs, { ...limits, maxBundleBytes: 7 })).toThrow("bundle exceeds");
    expect(() => createAppDocument(inputs, { ...limits, maxDocumentBytes: 100 })).toThrow("document exceeds");
  });

  it("admits sixfold JSON escaping within the shared publication document limit", () => {
    const source = "/*" + "<\u0000".repeat(32_768) + "*/";
    const input = file("bundle.js", source);
    const output = createAppDocument([input], {maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES, maxDocumentBytes: APP_PUBLICATION_MAX_DOCUMENT_BYTES});
    expect(output.byteLength).toBeGreaterThan(input.byteLength * 5);
    expect(output.byteLength).toBeLessThanOrEqual(input.byteLength * 6 + 64 * 1024);
    expect(APP_PUBLICATION_MAX_DOCUMENT_BYTES).toBe(APP_PUBLICATION_MAX_BUNDLE_BYTES * 6 + 64 * 1024);
  });

  it("rejects invalid UTF-8 rather than executing replacement text", () => {
    const input = file("bundle.js", "");
    input.bytes = Uint8Array.from([0xff]);input.byteLength = 1;
    input.sha256 = createHash("sha256").update(input.bytes).digest("hex");
    expect(() => createAppDocument([input], limits)).toThrow();
  });

  describe("page record", () => {
    const script = (run: number): AppPage["head"][number] => ({ tag: "script", attrs: [], children: [], run });
    const page = (overrides: Partial<AppPage> = {}): AppPage => ({ htmlAttributes: [["lang", "fr"]], bodyAttributes: [["class", "trip"]],
      head: [{ tag: "title", attrs: [], children: ["Trip"] }, script(0)],
      body: [{ tag: "main", attrs: [["id", "box"]], children: [script(1), { tag: "p", attrs: [["id", "after"]], children: ["After"] }] },
        script(2), { comment: " end " }, script(3)],
      scripts: ["window.log = ['head:' + !!document.body.firstChild];", "log.push('box:' + document.currentScript.parentElement.id + ':' + !!document.getElementById('after'));",
        "throw new Error('stops only itself');", "log.push('last:' + !!document.getElementById('after'));"],
      images: [], modules: 0, ...overrides });
    const build = (value: unknown, bundle = "") => createAppDocument([file("bundle.js", bundle), file("page.json", JSON.stringify(value))], { maxBundleBytes: 1_000_000, maxDocumentBytes: 10_000_000 });

    it("builds the page node by node, running each classic script as its own hashed script where it stands", () => {
      const output = build(page());
      const dom = new JSDOM(output.html, { runScripts: "dangerously" });
      expect(dom.window.document.documentElement.lang).toBe("fr");
      expect(dom.window.document.title).toBe("Trip");
      expect(dom.window.document.body.className).toBe("trip");
      expect(dom.window.log).toEqual(["head:false", "box:box:false", "last:true"]);
      expect(dom.window.document.body.innerHTML).toBe('<main id="box"><script>' + page().scripts[1] + '</script><p id="after">After</p></main>' +
        `<script>${page().scripts[2]}</script><!-- end --><script>${page().scripts[3]}</script>`);
      for (const text of page().scripts) expect(output.scriptSources).toContain(`'sha256-${createHash("sha256").update(text).digest("base64")}'`);
      dom.window.close();
    });

    it("keeps page text out of the HTML parser", () => {
      const attack = "</script><script src=\"https://evil.test/a.js\"></script>";
      const dom = new JSDOM(build(page({ head: [script(0)], body: [{ tag: "p", attrs: [["title", attack]], children: [attack] }],
        scripts: [`window.value = ${JSON.stringify(attack)};`] })).html, { runScripts: "dangerously" });
      expect(dom.window.value).toBe(attack);
      expect(dom.window.document.querySelectorAll("script[src]")).toHaveLength(0);
      expect(dom.window.document.querySelector("p")!.textContent).toBe(attack);
      dom.window.close();
    });

    it("fills each image reference from the page's one copy of the image", () => {
      const png = "data:image/png;base64,iVBORw0KGgo=";
      const dom = new JSDOM(build(page({ head: [], body: [{ tag: "img", attrs: [["src", [0]], ["srcset", [0, " 1x, ", 0, " 2x"]]], children: [] }], scripts: [], images: [png] })).html, { runScripts: "dangerously" });
      expect(dom.window.document.querySelector("img")!.getAttribute("srcset")).toBe(`${png} 1x, ${png} 2x`);
      dom.window.close();
    });

    it.each([
      ["an unknown field", { ...page(), extra: true }],
      ["a missing field", (() => { const { modules: _, ...rest } = page(); return rest; })()],
      ["a script index past the scripts", page({ body: [script(9)] })],
      ["an image index past the images", page({ body: [{ tag: "img", attrs: [["src", [0]]], children: [] }] })],
      ["an image that is not a data URL", page({ images: ["https://example.test/a.png"] })],
      ["an attribute name with a space", page({ bodyAttributes: [["on click", "x"]] })],
      ["an unknown namespace", { ...page(), body: [{ tag: "x", ns: "xul", attrs: [], children: [] }] }],
      ["a script that is not text", page({ scripts: [1 as unknown as string] })],
      [`more than ${APP_PAGE_MAX_SCRIPTS} scripts`, page({ scripts: Array.from({ length: APP_PAGE_MAX_SCRIPTS + 1 }, (_, index) => `${index}`) })],
      [`elements nested more than ${APP_PAGE_MAX_DEPTH} deep`, page({ body: [Array.from({ length: APP_PAGE_MAX_DEPTH + 1 }).reduce<AppPage["body"][number]>(child => ({ tag: "div", attrs: [], children: [child] }), "x")] })],
    ])("refuses a page record with %s", (_name, value) => {
      expect(() => build(value)).toThrow("Invalid app page.");
    });
  });

  it("produces one document identity regardless of input inventory order", () => {
    const inputs = [file("bundle.css", "body { color: red; }"), file("bundle.js", "window.ready=true;")];
    expect(createAppDocument(inputs, limits)).toEqual(createAppDocument([...inputs].reverse(), limits));
  });
});
