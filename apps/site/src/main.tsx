import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { createRoot } from "react-dom/client";

const host = document.getElementById("desktop-demo");

if (host) {
  let mounted = false;
  const mount = async () => {
    if (mounted) return;
    mounted = true;
    const [{ ProductDemo }, { default: demoCss }] = await Promise.all([
      import("./ProductDemo"),
      import("./demo.css?inline"),
    ]);
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
