import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = "/s/assets/";

const root = document.getElementById("root");
if (!root) throw new Error("Viewer root is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
