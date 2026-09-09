import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import {namedInvitationGrant} from "./namedInvitation";

const NamedRecipientApp = lazy(() => import("./NamedRecipientApp"));

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
    {location.pathname.startsWith("/s/edit/") ? <Suspense fallback={<main className="state">Opening shared files…</main>}>
      <NamedRecipientApp grantId={namedInvitationGrant(location.pathname)}/>
    </Suspense> : <App />}
  </StrictMode>,
);
