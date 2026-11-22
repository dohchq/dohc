import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const inter = createRequire(import.meta.url);
const font = readFileSync(
  inter.resolve("@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2"),
);
copyFileSync(
  inter.resolve("@fontsource-variable/inter/LICENSE"),
  fileURLToPath(new URL("../src/accountFont-LICENSE.txt", import.meta.url)),
);
writeFileSync(
  fileURLToPath(new URL("../src/accountFont.ts", import.meta.url)),
  `// Inter, Latin subset. Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter).
// Licensed under the SIL Open Font License 1.1. accountFont-LICENSE.txt holds its text.
// Written by scripts/write-account-font.mjs from @fontsource-variable/inter. Do not edit.
export const ACCOUNT_FONT_BASE64 =
  "${font.toString("base64")}";
`,
);
