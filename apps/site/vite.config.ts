/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { githubStars } from "./github-stars.ts";

// The demo renders the desktop's styles inside a shadow root, where `:root`
// matches nothing. Its tokens also apply to the shadow host.
const shadowHostTokens = {
  postcssPlugin: "shadow-host-tokens",
  Rule(rule: { selector: string }) {
    if (rule.selector === ":root") rule.selector = ":root, :host";
  },
};

// Fills each page's star count from one request per build.
const githubStarCount = (): Plugin => {
  let stars: Promise<string | null> | undefined;
  return {
    name: "github-star-count",
    async transformIndexHtml(html) {
      const count = await (stars ??= githubStars());
      return count ? html.replaceAll('<span class="nav-github-stars"></span>', `<span class="nav-github-stars">${count}</span>`) : html;
    },
  };
};

export default defineConfig({
  plugins: [react(), tailwindcss(), githubStarCount()],
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
