import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { APP_BUNDLE_CONTENT_TYPES, createAppDocument, type AppDocumentFile, type AppPage } from "@dohc/app-browser/document";
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
    const page = (overrides: Partial<AppPage> = {}): AppPage => ({ html: [["lang", "fr"]], title: "Trip", body: [["class", "trip"]],
      markup: "<main><h1>Trip</h1></main>", scripts: ["window.log = ['first:' + document.querySelector('h1').textContent];", "throw new Error('stops only itself');", "log.push('third');"],
      deferred: ["log.push('deferred:' + document.readyState);", null], ...overrides });
    const build = (value: unknown, script = "log.push('bundle');") =>
      createAppDocument([file("bundle.js", script), file("page.json", JSON.stringify(value))], limits);

    it("inserts the markup, then each classic script as its own hashed script, then deferred scripts once parsing ends", async () => {
      const output = build(page());
      const dom = new JSDOM(output.html, { runScripts: "dangerously" });
      await new Promise(resolve => dom.window.document.readyState === "loading" ? dom.window.addEventListener("DOMContentLoaded", resolve) : resolve(undefined));
      expect(dom.window.document.documentElement.lang).toBe("fr");
      expect(dom.window.document.title).toBe("Trip");
      expect(dom.window.document.body.className).toBe("trip");
      expect(dom.window.log).toEqual(["first:Trip", "third", "deferred:interactive", "bundle"]);
      const scripts = [...dom.window.document.querySelectorAll("script")];
      // The markup replaces the body, loader included; each created script remains.
      expect(scripts.map(node => node.textContent)).toEqual([...page().scripts, "log.push('deferred:' + document.readyState);", "log.push('bundle');"]);
      for (const node of scripts) expect(output.scriptSources).toContain(`'sha256-${createHash("sha256").update(node.textContent!).digest("base64")}'`);
      dom.window.close();
    });

    it("keeps page text out of the HTML parser", () => {
      const attack = "</script><script src=\"https://evil.test/a.js\"></script>";
      const dom = new JSDOM(build(page({ scripts: [`window.value = ${JSON.stringify(attack)};`], title: attack })).html, { runScripts: "dangerously" });
      expect(dom.window.value).toBe(attack);
      expect(dom.window.document.querySelectorAll("script[src]")).toHaveLength(0);
      dom.window.close();
    });

    it.each([
      ["an unknown field", { ...page(), extra: true }],
      ["no bundle position", page({ deferred: [] })],
      ["two bundle positions", page({ deferred: [null, null] })],
      ["an invalid attribute name", page({ body: [["on click", "x"]] })],
      ["a script that is not text", page({ scripts: [1 as unknown as string] })],
    ])("refuses a page record with %s", (_name, value) => {
      expect(() => build(value)).toThrow("Invalid app page.");
    });
  });

  it("produces one document identity regardless of input inventory order", () => {
    const inputs = [file("bundle.css", "body { color: red; }"), file("bundle.js", "window.ready=true;")];
    expect(createAppDocument(inputs, limits)).toEqual(createAppDocument([...inputs].reverse(), limits));
  });
});
