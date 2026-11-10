import { noticesWords } from "@dohc/interface-words/notices";
import { usePathname } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useWorkspaces, WorkspacesProvider } from "../../src/chats/Workspaces";
import { demoMode } from "../../src/demo";
import { NoticesProvider, useNotices } from "../../src/notices/NoticesState";
import { HideToast, ShowToast, Toast, type ToastMessage } from "../../src/notices/Toast";
import { useTheme } from "../../src/theme";

const sampleToast: ToastMessage = {
  tone: "failure", sender: "automation", title: "Automation “Budget sync” failed", body: "The exchange-rate source didn’t answer.",
  action: { label: noticesWords.tryAgain },
};

// The platform's own tab bar: Liquid Glass on iOS 26, Material on Android.
// Toasts sit above every tab except Notices, where each one already has its row.
export default function TabsLayout() {
  return <WorkspacesProvider><NoticesProvider><Tabs /></NoticesProvider></WorkspacesProvider>;
}

function Tabs() {
  // Design review only: the time the first usable screen is drawn, for launch timings.
  useEffect(() => {
    if (demoMode !== "launch-plain") return;
    requestAnimationFrame(() => void new File(Paths.document, "launch.json").write(JSON.stringify({ at: Date.now() })));
  }, []);
  const theme = useTheme();
  const { unread } = useNotices();
  const { current } = useWorkspaces();
  const unreadCount = (current?.sections ?? []).flatMap(section => section.rows).reduce((sum, row) => sum + (row.count ?? 0), 0);
  const pathname = usePathname();
  const [toast, setToast] = useState<ToastMessage | null>(demoMode === "toast" || demoMode === "toast-copied" ? sampleToast : null);
  const hideToast = useCallback((id: string) => setToast(shown => shown?.id === id ? null : shown), []);
  return (
    <ShowToast value={setToast}><HideToast value={hideToast}>
      <View style={{ flex: 1 }}>
        <NativeTabs tintColor={theme.accent}>
          <NativeTabs.Trigger name="(chats)">
            <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="forum" />
            <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
            {unreadCount > 0 ? <NativeTabs.Trigger.Badge>{String(unreadCount)}</NativeTabs.Trigger.Badge> : null}
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="home">
            <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
            <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="notices">
            <NativeTabs.Trigger.Icon sf={{ default: "bell", selected: "bell.fill" }} md="notifications" />
            <NativeTabs.Trigger.Label>Notices</NativeTabs.Trigger.Label>
            {unread > 0 ? <NativeTabs.Trigger.Badge>{String(unread)}</NativeTabs.Trigger.Badge> : null}
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="search" role="search">
            <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
            <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
        </NativeTabs>
        {toast && pathname !== "/notices" ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
      </View>
    </HideToast></ShowToast>
  );
}
