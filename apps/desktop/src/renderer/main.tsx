import { createRoot } from "react-dom/client";
import { DesktopRoot } from "./DesktopRoot";
import { initTheme } from "./theme";
import "./styles.css";

initTheme();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<DesktopRoot />);
}

requestAnimationFrame(() => {
  window.dohcDesktopInternal?.firstPaint();
});
