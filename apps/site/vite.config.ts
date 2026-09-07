import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { releaseAssets } from "./release-assets.ts";

export default defineConfig(async () => ({
  define: { __DOHC_RELEASE_ASSETS__: JSON.stringify(await releaseAssets()) },
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      input: ["index.html"],
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
}));
