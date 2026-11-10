import { confirmWords } from "@dohc/interface-words/confirmations";
import { sharingWords } from "@dohc/interface-words/sharing";
import { useRouter } from "expo-router";
import { useCallback } from "react";
import { choose, confirm } from "../confirm";
import { useShowToast } from "../notices/Toast";
import type { PhoneWorkspace } from "./sample";
import { useWorkspaces } from "./Workspaces";

// Forget drops the workspace from this phone's list at once and opens the next one; it stays on the server,
// so Undo puts it back and opens it again. Messages still waiting to send would be lost, so only then does it
// ask first.
export function useForgetWorkspace(workspace: PhoneWorkspace | null, waitingToSend: number) {
  const showToast = useShowToast();
  const { forget } = useWorkspaces();
  return useCallback(async () => {
    if (!workspace || !forget) return;
    if (waitingToSend > 0) {
      const sure = await confirm({
        title: confirmWords.forgetTitle(workspace.name), message: confirmWords.forgetWaiting(waitingToSend),
        confirm: confirmWords.forget, destructive: true,
      });
      if (!sure) return;
    }
    const undo = forget(workspace);
    showToast({ tone: "success", title: confirmWords.forgot(workspace.name), action: { label: confirmWords.undo, onPress: undo } });
  }, [forget, showToast, waitingToSend, workspace]);
}

// The workspace's own menu, from its name in the Chats header. The switcher joins it with sign-in.
export function useWorkspaceMenu(workspace: PhoneWorkspace | null, waitingToSend: number) {
  const forget = useForgetWorkspace(workspace, waitingToSend);
  const router = useRouter();
  return useCallback(async () => {
    if (!workspace) return;
    const chosen = await choose({ title: workspace.name, options: [{ label: sharingWords.heading }, { label: confirmWords.forget, destructive: true }] });
    if (chosen === 0) router.push("/sharing");
    if (chosen === 1) await forget();
  }, [forget, router, workspace]);
}
