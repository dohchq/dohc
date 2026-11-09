import { confirmWords } from "@dohc/interface-words/confirmations";
import { useEffect, useRef } from "react";
import { confirm } from "../confirm";
import { demoMode, waitingToSend } from "../demo";
import { useForgetWorkspace, useWorkspaceMenu } from "./workspaceMenu";
import { useWorkspaces } from "./Workspaces";

// Design review only: opens one confirmation over Chats once, so its screenshot can be taken without a tap.
// Deleting files and leaving a conversation have no phone surface yet; their sheets are shown here first.
export function useDemoSheet() {
  const { current } = useWorkspaces();
  const opened = useRef(false);
  const forget = useForgetWorkspace(current, waitingToSend);
  const lisbon = current?.id === "lisbon" ? current : null;
  const menu = useWorkspaceMenu(lisbon, waitingToSend);
  useEffect(() => {
    if (opened.current || !lisbon) return;
    const paths = ["trip/packing-list.md", "trip/budget.md", "itinerary/days.md"];
    const timer = setTimeout(() => {
      opened.current = true;
      if (demoMode === "sheet-forget") void menu();
      if (demoMode === "sheet-forget-waiting" || demoMode === "toast-forgot") void forget();
      if (demoMode === "sheet-delete-file" || demoMode === "sheet-delete-files") {
        const chosen = demoMode === "sheet-delete-file" ? paths.slice(0, 1) : paths;
        const body = confirmWords.deleteFilesBody(chosen.length, lisbon.name);
        void confirm({
          title: confirmWords.deleteFilesTitle(chosen), confirm: confirmWords.delete, destructive: true,
          message: chosen.length === 1 ? body : `${body}\n\n${chosen.join("\n")}`,
        });
      }
      if (demoMode === "sheet-leave") {
        void confirm({
          title: confirmWords.leaveConversationTitle("Sam Ortiz"), message: confirmWords.leaveConversationBody(lisbon.name),
          confirm: confirmWords.leaveConversation, destructive: true,
        });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [forget, lisbon, menu]);
}
