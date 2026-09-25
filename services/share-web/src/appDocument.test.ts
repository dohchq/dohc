import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { APP_BUNDLE_CONTENT_TYPES, APP_PAGE_MAX_SCRIPTS, appPageProblem, createAppDocument, type AppDocumentFile, type AppPage } from "@dohc/app-browser/document";
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
    const scripts = ["window.log = ['head:' + !!document.body];", "log.push('box:' + document.currentScript.parentElement.id + ':' + !!document.getElementById('after'));",
      "throw new Error('stops only itself');", "log.push('last:' + !!document.getElementById('after'));"];
    const page = (overrides: Partial<AppPage> = {}): AppPage => ({ htmlAttributes: [["lang", "fr"], ["data-note", 'a "quoted" & value']],
      head: `<title>Trip</title><script>${scripts[0]}</script>`,
      body: `<body class="trip"><main id="box"><script>${scripts[1]}</script><p id="after">After</p></main><script>${scripts[2]}</script><!-- end --><script>${scripts[3]}</script></body>`,
      scripts, ...overrides });
    const build = (value: unknown, bundle = "window.registry = true;") =>
      createAppDocument([file("bundle.js", bundle), file("page.json", JSON.stringify(value))], { maxBundleBytes: 1_000_000, maxDocumentBytes: 10_000_000 });

    it("lets the browser parse the page after the policy and bundle.js, pinning every script by hash", () => {
      const output = build(page());
      expect(output.html).toMatch(/^<!doctype html><html lang="fr" data-note="a &quot;quoted&quot; &amp; value"><head><meta charset="utf-8">.*<meta http-equiv="Content-Security-Policy" content="[^"]*"><script>window\.registry = true;<\/script><title>Trip<\/title>/);
      const dom = new JSDOM(output.html, { runScripts: "dangerously" });
      expect(dom.window.document.documentElement.getAttribute("data-note")).toBe('a "quoted" & value');
      expect(dom.window.document.title).toBe("Trip");
      expect(dom.window.document.body.className).toBe("trip");
      expect(dom.window.log).toEqual(["head:false", "box:box:false", "last:true"]);
      for (const text of [...scripts, "window.registry = true;"]) expect(output.scriptSources).toContain(`'sha256-${createHash("sha256").update(text).digest("base64")}'`);
      expect(output.scriptSources).toHaveLength(5);
      dom.window.close();
    });

    it.each([
      ["an unknown field", { ...page(), extra: true }],
      ["a missing field", (() => { const { scripts: _, ...rest } = page(); return rest; })()],
      ["a body that is not a <body> element", page({ body: "<p>no body</p>" })],
      ["a script that is not text", page({ scripts: [1 as unknown as string] })],
      ["an <html> attribute name that would split when parsed", page({ htmlAttributes: [["=x", ""]] })],
      ["an <html> attribute name with a quote", page({ htmlAttributes: [['a"b', ""]] })],
      [`more than ${APP_PAGE_MAX_SCRIPTS} scripts`, page({ scripts: Array.from({ length: APP_PAGE_MAX_SCRIPTS + 1 }, (_, index) => `${index}`) })],
    ])("refuses a page record with %s", (_name, value) => {
      expect(() => build(value)).toThrow("Invalid app page.");
      expect(appPageProblem(value)).not.toBeNull();
    });

    it.each(["var a = '</script>';", "var a = '<!--<script>';"])("refuses a page whose bundle.js would end its own <script> early: %s", bundle => {
      expect(() => build(page(), bundle)).toThrow("Invalid app page.");
    });

    it("refuses a page with a separate bundle.css, since its CSS belongs in the page", () => {
      expect(() => createAppDocument([file("bundle.js", ""), file("bundle.css", "p{}"), file("page.json", JSON.stringify(page()))], limits)).toThrow("Invalid app page.");
    });

    it("says what is wrong in words that follow the page's name", () => {
      expect(appPageProblem(page())).toBeNull();
      expect(appPageProblem(page({ htmlAttributes: [["=x", ""]] }))).toBe('has an attribute named "=x" on <html>. A published page cannot carry that name. Rename or remove the attribute.');
    });
  });

  it("produces one document identity regardless of input inventory order", () => {
    const inputs = [file("bundle.css", "body { color: red; }"), file("bundle.js", "window.ready=true;")];
    expect(createAppDocument(inputs, limits)).toEqual(createAppDocument([...inputs].reverse(), limits));
  });
});
