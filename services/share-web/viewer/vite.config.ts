import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VIEWER_PAGES, viewerPage } from "./src/pages.ts";

const viewerRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: viewerRoot,
  base: "/s/",
  plugins: [
    react(),
    {
      name: "viewer-pages",
      // The development server serves each path the page share-web serves for it.
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const page = viewerPage(new URL(request.url ?? "/", "http://viewer").pathname);
          if (page !== "index.html") request.url = `/s/${page}`;
          next();
        });
      },
    },
  ],
  build: {
    outDir: resolve(viewerRoot, "dist"),
    emptyOutDir: true,
    rolldownOptions: { input: VIEWER_PAGES.map(page => resolve(viewerRoot, page)) },
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
  },
});
