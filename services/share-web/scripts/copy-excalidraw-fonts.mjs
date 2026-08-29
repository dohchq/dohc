import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../node_modules/@excalidraw/excalidraw/dist/prod/fonts", import.meta.url),
);
const destination = fileURLToPath(
  new URL("../viewer/dist/assets/fonts", import.meta.url),
);

await cp(source, destination, { recursive: true });
