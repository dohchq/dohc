import type { Root } from "react-dom/client";
import { engineLoadFinished } from "./hero-engine";

const host = document.getElementById("desktop-demo");

if (host) {
  let mounted = false;
  const status = host.querySelector<HTMLElement>("[data-demo-status]");
  const retry = host.querySelector<HTMLButtonElement>("[data-demo-retry]");
  let reactRoot: Root | undefined;
  let stopKeyboardNavigation: (() => void) | undefined;
  const failed = (error: unknown) => {
    console.error("Unable to load the interactive dohc demo", error);
    queueMicrotask(() => {
      reactRoot?.unmount();
      reactRoot = undefined;
      stopKeyboardNavigation?.();
      stopKeyboardNavigation = undefined;
      host.shadowRoot?.replaceChildren(document.createElement("slot"));
      mounted = false;
      if (status) status.textContent = "The demo could not load. Try again.";
      if (retry) retry.hidden = false;
    });
  };
  const mount = async () => {
    if (mounted) return;
    mounted = true;
    if (status) status.textContent = "Loading workspace…";
    if (retry) retry.hidden = true;
    try {
      const [
        ,
        ,
        ,
        { ProductDemo },
        { default: demoCss },
        { hydrateDemoWorkspaceAssets },
        { createRoot },
        { createElement },
        { initKeyboardNavigation },
      ] = await Promise.all([
        import("@fontsource-variable/inter/index.css"),
        import("@fontsource/ibm-plex-mono/400.css"),
        import("@fontsource/ibm-plex-mono/500.css"),
        import("./ProductDemo"),
        import("./demo.css?inline"),
        import("./demoDesktopBridge"),
        import("react-dom/client"),
        import("react"),
        import("../../desktop/src/renderer/keyboardNavigation"),
      ]);
      await hydrateDemoWorkspaceAssets();
      // Browsers ignore @property inside a shadow root, which leaves
      // Tailwind's borders and shadows without their initial values.
      // Registered on the page, they reach the shadow root too.
      if (!document.querySelector("style[data-demo-properties]")) {
        const properties = document.createElement("style");
        properties.dataset.demoProperties = "";
        properties.textContent = (demoCss.match(/@property\s[^{]+\{[^}]*\}/g) ?? []).join("\n");
        document.head.append(properties);
      }
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      // The calendar finds what a drag is over with document.elementFromPoint,
      // which stops at the shadow host. Look inside the demo for it.
      if (document.elementFromPoint && !("demoPoint" in host.dataset)) {
        host.dataset.demoPoint = "";
        const elementFromPoint = document.elementFromPoint.bind(document);
        document.elementFromPoint = (x, y) => {
          const hit = elementFromPoint(x, y);
          return hit === host ? (shadow.elementFromPoint(x, y) ?? hit) : hit;
        };
      }
      const style = document.createElement("style");
      style.textContent = demoCss;
      const root = document.createElement("div");
      root.id = "root";
      root.style.height = "100%";
      shadow.replaceChildren(style, root);
      // The demo's focus shows only while the keyboard moves, as in the app.
      stopKeyboardNavigation = initKeyboardNavigation(root);
      reactRoot = createRoot(root, { onUncaughtError: failed });
      reactRoot.render(createElement(ProductDemo));
    } catch (error) {
      failed(error);
    }
  };
  retry?.addEventListener("click", () => {
    void mount();
  });

  if ("IntersectionObserver" in window) {
    let latest: IntersectionObserverEntry;
    const observer = new IntersectionObserver(
      async (entries) => {
        const entry = entries[entries.length - 1];
        latest = entry;
        if (!entry.isIntersecting) return;
        if (
          entry.intersectionRatio < 1 / 3 &&
          entry.boundingClientRect.top > 0 &&
          window.scrollY === 0
        ) {
          await Promise.race([
            engineLoadFinished,
            new Promise<void>((resolve) => setTimeout(resolve, 2500)),
          ]);
          if (latest !== entry) return;
        }
        observer.disconnect();
        void mount();
      },
      { threshold: [0, 1 / 3] },
    );
    observer.observe(host);
  } else {
    void mount();
  }
}
