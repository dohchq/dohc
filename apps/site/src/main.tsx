import { createRoot } from "react-dom/client";

const host = document.getElementById("desktop-demo");

if (host) {
  let mounted = false;
  const mount = async () => {
    if (mounted) return;
    mounted = true;
    const modules = await Promise.all([
      import("@fontsource-variable/inter/index.css"),
      import("@fontsource/ibm-plex-mono/400.css"),
      import("@fontsource/ibm-plex-mono/500.css"),
      import("./ProductDemo"),
      import("./demo.css?inline"),
      import("./demoDesktopBridge"),
    ]);
    const { ProductDemo } = modules[3];
    const { default: demoCss } = modules[4];
    const { hydrateDemoWorkspaceAssets } = modules[5];
    await hydrateDemoWorkspaceAssets();
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = demoCss;
    const root = document.createElement("div");
    root.id = "root";
    root.style.height = "100%";
    shadow.replaceChildren(style, root);
    createRoot(root).render(<ProductDemo />);
  };

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void mount();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(host);
  } else {
    void mount();
  }
}
