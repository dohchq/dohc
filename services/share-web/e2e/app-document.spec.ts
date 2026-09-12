import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test, expect } from "@playwright/test";
import { compileClosedApp } from "../../../apps/desktop/src/workspaces/closedAppCompiler";
import { createAppDocument } from "../src/appDocument";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const input = (path: string, text: string) => {
  const bytes = Buffer.from(text);return { path, bytes, sha256: hash(bytes) };
};

test("approved React bundle runs under inherited CSP in an opaque child", async ({ page }) => {
  let parentHtml = "", parentCsp = "";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": parentCsp });response.end(parentHtml);
    } else if (request.url === "/external") {
      response.writeHead(200, { "Access-Control-Allow-Origin": "*" });response.end("received");
    } else {
      response.writeHead(200, { "Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*" });response.end("window.unapproved=true");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();if (!address || typeof address === "string") throw new Error("Missing test address");
    const origin = `http://127.0.0.1:${address.port}`;
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
      const bytes = await readFile(join(root!, path!));return { path: `deps/${name}/${path}`, bytes, sha256: hash(bytes) };
    }));
    const build = await compileClosedApp({ entryPath: "main.tsx", bounds: { maxInputFiles: 32, maxInputBytes: 5_000_000, maxOutputBytes: 5_000_000 },
      packageMap: { react: "deps/react/index.js", "react/jsx-runtime": "deps/react/jsx-runtime.js", "react-dom": "deps/react-dom/index.js",
        "react-dom/client": "deps/react-dom/client.js", scheduler: "deps/scheduler/index.js" },
      inputs: [...captured, input("main.tsx", `import {useState} from 'react';import {createRoot} from 'react-dom/client';import './style.css';
        function Poll(){const [count,setCount]=useState(0);return <button style={{backgroundColor:'rgb(1, 2, 3)'}} onClick={()=>setCount(count+1)}>Votes: {count}</button>}
        createRoot(document.getElementById('root')!).render(<Poll/>);
        fetch('${origin}/external',{method:'POST',body:'allowed'}).then(r=>r.text()).then(value=>{document.body.dataset.network=value});`),
        input("style.css", "button { color: rgb(4, 5, 6) }")],
    });
    const doc = createAppDocument(build.files, { maxBundleBytes: 5_000_000, maxDocumentBytes: 10_000_000 });
    const parentScript = `const f=document.createElement('iframe');f.id='app';f.sandbox='allow-scripts';f.srcdoc=${JSON.stringify(doc.html).replaceAll("<", "\\u003c")};document.body.append(f);`;
    const parentHash = `'sha256-${createHash("sha256").update(parentScript).digest("base64")}'`;
    parentCsp = `default-src 'none'; script-src ${parentHash} ${doc.scriptSources.join(" ")}; style-src 'unsafe-inline'; connect-src http:; frame-src 'self'; base-uri 'none'; form-action 'none'`;
    parentHtml = `<!doctype html><body><script>${parentScript}</script></body>`;
    await page.goto(origin);
    const app = page.frameLocator("#app");
    await expect(app.getByRole("button", { name: "Votes: 0" })).toBeVisible();
    await app.getByRole("button").click();
    await expect(app.getByRole("button")).toHaveText("Votes: 1");
    await expect(app.getByRole("button")).toHaveCSS("color", "rgb(4, 5, 6)");
    await expect(app.getByRole("button")).toHaveCSS("background-color", "rgb(1, 2, 3)");
    await expect(app.locator("body")).toHaveAttribute("data-network", "received");
    const child = page.frames().find(frame => frame.url() === "about:srcdoc")!;
    const blocked = await child.evaluate(async external => {
      const checks: Record<string, boolean> = {};
      for (const [name, read] of Object.entries({ parent: () => parent.document, storage: () => localStorage.length, cookie: () => document.cookie })) {
        try { read();checks[name] = false; } catch { checks[name] = true; }
      }
      const violations = new Set<string>();
      const violation = new Promise<void>(resolve => document.addEventListener("securitypolicyviolation", event => {
        violations.add(event.blockedURI);
        if (violations.has("inline") && violations.has(external)) resolve();
      }));
      const inline = document.createElement("script");inline.textContent = "window.unapproved=true";document.body.append(inline);
      const remote = document.createElement("script");remote.src = external;document.body.append(remote);
      await violation;
      return { checks, executed: "unapproved" in window };
    }, `${origin}/unapproved.js`);
    expect(blocked).toEqual({ checks: { parent: true, storage: true, cookie: true }, executed: false });
    expect(requests).toContain("/external");expect(requests).not.toContain("/unapproved.js");
  } finally {
    server.closeAllConnections();await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
