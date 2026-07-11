import { createRoot } from "react-dom/client";
import { DesktopRoot } from "./DesktopRoot";
import { initTheme } from "./theme";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "katex/dist/katex.min.css";
import "./styles.css";

initTheme();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<DesktopRoot />);
}
// firstPaint is signalled from DesktopRoot when real content (first-run or the
// workspace shell) actually mounts — not here, where the root is still null
// until the registry IPC resolves (that would mark a blank background frame).
