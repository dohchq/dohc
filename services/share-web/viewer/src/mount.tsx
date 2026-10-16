// Every page cascades in one order: the named recipient styles, the shared styles, then the route's own.
import "./namedRecipient.css";
import "./styles.css";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

export function mount(page: ReactNode): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("Viewer root is missing.");
  createRoot(root).render(<StrictMode>{page}</StrictMode>);
}
