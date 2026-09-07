import type { Root } from "react-dom/client";

const host = document.getElementById("desktop-demo");

if (host) {
  let mounted = false;
  const status = host.querySelector<HTMLElement>("[data-demo-status]");
  const retry = host.querySelector<HTMLButtonElement>("[data-demo-retry]");
  let reactRoot: Root | undefined;
  const failed = (error: unknown) => {
    console.error("Unable to load the interactive dohc demo", error);
    queueMicrotask(() => {
      reactRoot?.unmount();
      reactRoot = undefined;
      host.shadowRoot?.replaceChildren(document.createElement("slot"));
      mounted = false;
      if (status) status.textContent = "The demo could not load. Try again.";
      if (retry) retry.hidden = false;
    });
  };
  const mount = async (): Promise<boolean> => {
    if (mounted) return false;
    mounted = true;
    if (status) status.textContent = "Loading your workspace…";
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
      ] = await Promise.all([
        import("@fontsource-variable/inter/index.css"),
        import("@fontsource/ibm-plex-mono/400.css"),
        import("@fontsource/ibm-plex-mono/500.css"),
        import("./ProductDemo"),
        import("./demo.css?inline"),
        import("./demoDesktopBridge"),
        import("react-dom/client"),
        import("react"),
      ]);
      await hydrateDemoWorkspaceAssets();
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = demoCss;
      const root = document.createElement("div");
      root.id = "root";
      root.style.height = "100%";
      shadow.replaceChildren(style, root);
      reactRoot = createRoot(root, { onUncaughtError: failed });
      reactRoot.render(createElement(ProductDemo));
      return true;
    } catch (error) {
      failed(error);
      return false;
    }
  };
  retry?.addEventListener("click", () => { void mount(); });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void mount().then((didMount) => {
          if (didMount) observer.disconnect();
        });
      },
      { rootMargin: "0px" },
    );
    observer.observe(host);
  } else {
    void mount();
  }
}
