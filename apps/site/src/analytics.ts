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
      // Memory persistence stops the SDK probing for cookie support when
      // the browser refuses storage.
      cookieless_mode: "always",
      persistence: "memory",
      // Only the site's own pages, so file names a visitor types in the demo
      // stay in the browser. PostHog drops a click when any element from the
      // target up, through shadow roots, matches the ignore list. The allow
      // list leaves out demo menus that open directly on <body>.
      autocapture: {
        css_selector_allowlist: ["body > header *", "body > main *", "body > footer *"],
        // .sync-stage holds the sync demo and its online switch.
        css_selector_ignorelist: ["#desktop-demo", ".sync-stage"],
      },
      capture_pageview: true,
      capture_pageleave: true,
      // privacy.html lists what a report holds. Scroll depth and the device
      // model, which Chrome reveals only when asked, are not on it.
      disable_scroll_properties: true,
      disableDeviceModel: true,
      // A link can carry anything after its ? or #, such as campaign tags or
      // an email address, so reports hold only the page's own address.
      save_campaign_params: false,
      before_send: (event) => {
        if (!event) return event;
        // PostHog's GeoIP step skips an event that carries this, so no report
        // gains a location, whatever the order of PostHog's pipeline.
        const properties: Record<string, unknown> = { ...event.properties, $geoip_disable: true };
        // The referrer too: from another page of this site, the browser sends
        // that page's whole address.
        for (const key of ["$current_url", "$referrer"]) {
          const value = properties[key];
          if (typeof value === "string") properties[key] = value.split(/[?#]/)[0];
        }
        // The SDK reads both from the referrer's whole address, query
        // included, and takes this site's own address for a search engine's
        // when its query mentions one.
        delete properties.ph_keyword;
        delete properties.$search_engine;
        return { ...event, properties };
      },
      // Anyone can send a link that turns these on, and each keeps a setting
      // in the browser's storage: ?__posthog_debug=true, and the toolbar's
      // #__posthog= login, which also loads the toolbar's script.
      debug: false,
      __extensionClasses: { toolbar: undefined },
      // The project records sessions for the desktop app. Not here.
      disable_session_recording: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      capture_performance: false,
      // Also skips remote config, so PostHog's servers can't switch on
      // anything this list turns off, such as console log capture.
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
