import { createRoot } from "react-dom/client";
import { DesktopRoot } from "./DesktopRoot";
import { initTheme } from "./theme";
import "./styles.css";

initTheme();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<DesktopRoot />);
}
// firstPaint is signalled from DesktopRoot when real content (first-run or the
// workspace shell) actually mounts — not here, where the root is still null
// until the registry IPC resolves (that would mark a blank background frame).
