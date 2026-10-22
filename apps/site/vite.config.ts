/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The demo renders the desktop's styles inside a shadow root, where `:root`
// matches nothing. Its tokens also apply to the shadow host.
const shadowHostTokens = {
  postcssPlugin: "shadow-host-tokens",
  Rule(rule: { selector: string }) {
    if (rule.selector === ":root") rule.selector = ":root, :host";
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: { postcss: { plugins: [shadowHostTokens] } },
  build: {
    rolldownOptions: {
      input: ["index.html", "privacy.html"],
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
  // The demo loader test waits on a lazy import and a React render, which a
  // loaded gate host can hold for seconds. 30 s matches sync-relay.
  test: { testTimeout: 30_000 },
});
