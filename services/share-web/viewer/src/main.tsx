import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import {namedInvitationGrant} from "./namedInvitation";
import {namedAppTarget} from "./namedAppRoute";

const NamedRecipientApp = lazy(() => import("./NamedRecipientApp"));
const NamedApp = lazy(() => import("./NamedApp"));

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = "/s/assets/";

const root = document.getElementById("root");
if (!root) throw new Error("Viewer root is missing.");

function page(pathname: string) {
  if (pathname.startsWith("/s/edit/")) return <Suspense fallback={<main className="state">Opening shared files…</main>}>
    <NamedRecipientApp grantId={namedInvitationGrant(pathname)}/>
  </Suspense>;
  if (pathname.startsWith("/s/apps/")) return <Suspense fallback={<main className="state">Opening shared app…</main>}>
    <NamedApp target={namedAppTarget(pathname)}/>
  </Suspense>;
  return <App />;
}

createRoot(root).render(<StrictMode>{page(location.pathname)}</StrictMode>);
