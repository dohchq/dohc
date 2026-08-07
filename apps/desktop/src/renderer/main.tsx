import { createRoot } from "react-dom/client";
import { DesktopRoot } from "./DesktopRoot";
import { AppErrorBoundary, installGlobalErrorReporters } from "./ErrorBoundary";
import { RecoveryCloseGuard } from "./RecoveryCloseGuard";
import { restoreOrphanedDrafts } from "./orphanedDrafts";
import { initTheme } from "./theme";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "katex/dist/katex.min.css";
import "./styles.css";

initTheme();
installGlobalErrorReporters();
// Before the root renders (#600): the set-aside recoveries the last app run
// left behind go back into the store, so the first paint already carries their
// notices and nothing has to re-render to find them.
restoreOrphanedDrafts();

const container = document.getElementById("root");
if (container) {
  // AppErrorBoundary: an uncaught render error must show the branded
  // recovery screen (reload button), never unmount to a blank window.
  // RecoveryCloseGuard sits ABOVE it (#579 review, r5): the crash screen's
  // reload must not destroy the set-aside drafts storage could not keep
  // (#600) unannounced, and a guard inside the crashed tree would unmount
  // with it.
  createRoot(container).render(
    <RecoveryCloseGuard>
      <AppErrorBoundary>
        <DesktopRoot />
      </AppErrorBoundary>
    </RecoveryCloseGuard>,
  );
}
// firstPaint is signalled from DesktopRoot when real content (first-run or the
// workspace shell) actually mounts — not here, where the root is still null
// until the registry IPC resolves (that would mark a blank background frame).
