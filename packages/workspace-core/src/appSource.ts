import { escapeHtml } from "./html";

export interface AppSourceOptions {
  title: string;
  packageName: string;
  withDohcJson: boolean;
}

export interface AppSourceFile {
  path: string;
  content: string;
}

export function generateAppSource({
  title,
  packageName,
  withDohcJson,
}: AppSourceOptions): AppSourceFile[] {
  return [
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <main>
      <p class="eyebrow">New app</p>
      <h1>${escapeHtml(title)}</h1>
      <p>A clean local page, ready for the shape of the work.</p>
    </main>
    <script type="module" src="./script.js"></script>
  </body>
</html>
`,
    },
    {
      path: "styles.css",
      content: `:root {
  color: #151515;
  background: #f7f6f1;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
}

main {
  width: min(720px, calc(100vw - 48px));
}

.eyebrow {
  margin: 0 0 12px;
  color: #66635d;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 16px;
  font-size: 4rem;
  line-height: 0.96;
}

p {
  max-width: 56ch;
  font-size: 1.08rem;
  line-height: 1.6;
}

@media (max-width: 640px) {
  h1 {
    font-size: 2.25rem;
  }
}
`,
    },
    {
      path: "script.js",
      content: `document.documentElement.dataset.siteReady = "true";
`,
    },
    {
      path: "scripts/build-static.mjs",
      content: `import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

for (const file of ["index.html", "styles.css", "script.js"]) {
  if (existsSync(file)) await copyFile(file, \`dist/\${file}\`);
}
`,
    },
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: packageName,
          private: true,
          type: "module",
          engines: {
            node: ">=14.8.0",
          },
          scripts: {
            dev: "serve . --listen 127.0.0.1:4173",
            build: "node scripts/build-static.mjs",
            preview: "serve dist --listen 127.0.0.1:4173",
          },
          devDependencies: {
            serve: "14.2.6",
          },
        },
        null,
        2,
      )}\n`,
    },
    ...(!withDohcJson
      ? []
      : [
          {
            path: "dohc.json",
            content: `${JSON.stringify(
              {
                version: 1,
                type: "app",
                title,
                preview: { mode: "static", entry: "index.html" },
                build: { command: "npm run build", output: "dist" },
              },
              null,
              2,
            )}\n`,
          },
        ]),
  ];
}
