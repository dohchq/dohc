import { createRoot } from "react-dom/client";

const host = document.getElementById("desktop-demo");

if (host) {
  let mounted = false;
  const mount = async (): Promise<boolean> => {
    if (mounted) return false;
    mounted = true;
    try {
      const [
        ,
        ,
        ,
        { ProductDemo },
        { default: demoCss },
        { hydrateDemoWorkspaceAssets },
      ] = await Promise.all([
        import("@fontsource-variable/inter/index.css"),
        import("@fontsource/ibm-plex-mono/400.css"),
        import("@fontsource/ibm-plex-mono/500.css"),
        import("./ProductDemo"),
        import("./demo.css?inline"),
        import("./demoDesktopBridge"),
      ]);
      await hydrateDemoWorkspaceAssets();
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = demoCss;
      const root = document.createElement("div");
      root.id = "root";
      root.style.height = "100%";
      shadow.replaceChildren(style, root);
      createRoot(root).render(<ProductDemo />);
      return true;
    } catch (error) {
      mounted = false;
      console.error("Unable to load the interactive dohc demo", error);
      return false;
    }
  };

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void mount().then((didMount) => {
          if (didMount) observer.disconnect();
        });
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(host);
  } else {
    void mount();
  }
}
