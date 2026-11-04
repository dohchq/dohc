// Page analytics, described on privacy.html. PostHog loads only after the
// page has loaded and the browser is idle, so it never delays the page.
// Requests go through this site's /ingest path, which src/worker.ts forwards.

import type { PostHog } from "posthog-js";

// A project's client token is public. Browsers send it with every event.
const POSTHOG_TOKEN = "phc_4EUB88JK9BzR2LEtJ24xVwMV8pczEBs95yTMpwJuvu4";
const DOWNLOAD_LINK = "[data-download-primary], [data-download-card], [data-download-asset]";

let loading: Promise<PostHog> | undefined;

function loadAnalytics(): Promise<PostHog> {
  return loading ??= import("posthog-js").then(({ default: posthog }) => {
    posthog.init(POSTHOG_TOKEN, {
      api_host: "/ingest",
      ui_host: "https://us.posthog.com",
      // No cookies, no storage, and no identifier kept in the browser.
      cookieless_mode: "always",
      // Only the site's own pages, so file names a visitor types in the demo
      // stay in the browser. PostHog drops a click when any element from the
      // target up, through shadow roots, matches the ignore list. The allow
      // list leaves out demo menus that open directly on <body>.
      autocapture: {
        css_selector_allowlist: ["body > header *", "body > main *", "body > footer *"],
        css_selector_ignorelist: ["#desktop-demo"],
      },
      capture_pageview: true,
      capture_pageleave: true,
      // The project records sessions for the desktop app. Not here.
      disable_session_recording: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      capture_performance: false,
      advanced_disable_flags: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
    });
    return posthog;
  });
}

document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest<HTMLElement>(DOWNLOAD_LINK) : null;
  // The build the link points at, such as "windows-x64". The primary button
  // has none while it only scrolls to the platform list.
  const asset = link?.dataset.downloadCard || link?.dataset.downloadBuild || link?.dataset.downloadAsset;
  if (!asset) return;
  const platform = asset.split("-")[0];
  // The click may navigate away, so the event skips the send queue.
  loadAnalytics().then((posthog) => {
    posthog.capture("download_clicked", { asset, platform }, { send_instantly: true });
  }, ignore);
}, { capture: true });

// A blocker may stop PostHog from loading. The page works the same without it.
function ignore() {}

function whenIdle() {
  const load = () => loadAnalytics().catch(ignore);
  if ("requestIdleCallback" in window) requestIdleCallback(load, { timeout: 5000 });
  else setTimeout(load, 1000);
}

if (document.readyState === "complete") whenIdle();
else addEventListener("load", whenIdle, { once: true });
