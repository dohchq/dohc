import { escapeHtml } from "./html";

export interface AppSourceOptions {
  title: string;
  appRoot: string;
  withDohcJson: boolean;
}

export interface AppSourceFile {
  path: string;
  content: string;
}

function packageNameFromPath(root: string): string {
  const name = root.split("/").at(-1) || "app";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

export function generateAppSource({
  title,
  appRoot,
  withDohcJson,
}: AppSourceOptions): AppSourceFile[] {
  const packageName = packageNameFromPath(appRoot);
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
      <h1>${escapeHtml(title)}</h1>
    </main>
    <script type="module" src="./script.js"></script>
  </body>
</html>
`,
    },
    {
      path: "styles.css",
      content: "",
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
