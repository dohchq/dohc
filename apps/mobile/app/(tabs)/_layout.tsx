import { noticesWords } from "@dohc/interface-words/notices";
import { usePathname } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useWorkspaces, WorkspacesProvider } from "../../src/chats/Workspaces";
import { demoMode } from "../../src/demo";
import { NoticesProvider, useNotices } from "../../src/notices/NoticesState";
import { sampleBuild } from "../../src/sampleBuild";
import { FeedNotice } from "../../src/workspace/FeedNotice";
import { HideToast, ShowToast, Toast, type ToastMessage } from "../../src/notices/Toast";
import {
  closeToast,
  hideToast,
  NO_TOASTS,
  showToast,
  type ToastSlots,
} from "../../src/notices/toastSlots";
import { useTheme } from "../../src/theme";

// Design review's toast. The sample test is written out, so a build without sample data drops it (src/sampleBuild.ts).
const sampleToast: ToastMessage | null =
  __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1"
    ? {
        tone: "failure",
        sender: "automation",
        title: "Automation “Budget sync” failed",
        body: "The exchange-rate source didn’t answer.",
        action: { label: noticesWords.tryAgain },
      }
    : null;

// The platform's own tab bar: Liquid Glass on iOS 26, Material on Android.
// Toasts sit above every tab except Notices, where each one already has its row. A toast holding the only Undo for a
// change shows there too, and another toast waits behind it (src/notices/toastSlots.ts). The Notices list reports
// through toasts as well, so their host sits above it.
export default function TabsLayout() {
  const [slots, setSlots] = useState<ToastSlots>(
    demoMode === "toast" || demoMode === "toast-copied"
      ? { shown: sampleToast, waiting: null }
      : NO_TOASTS,
  );
  const show = useCallback(
    (message: ToastMessage) => setSlots((current) => showToast(current, message)),
    [],
  );
  const hide = useCallback((id: string) => setSlots((current) => hideToast(current, id)), []);
  const close = useCallback(() => setSlots(closeToast), []);
  return (
    <ShowToast value={show}>
      <HideToast value={hide}>
        <WorkspacesProvider>
          <NoticesProvider>
            <Tabs toast={slots.shown} onCloseToast={close} />
          </NoticesProvider>
        </WorkspacesProvider>
      </HideToast>
    </ShowToast>
  );
}

function Tabs({ toast, onCloseToast }: { toast: ToastMessage | null; onCloseToast(): void }) {
  // Design review only: the time the first usable screen is drawn, for launch timings.
  useEffect(() => {
    if (demoMode !== "launch-plain" && demoMode !== "launch-plain-cold") return;
    requestAnimationFrame(
      () => void new File(Paths.document, "launch.json").write(JSON.stringify({ at: Date.now() })),
    );
  }, []);
  const theme = useTheme();
  const { unread } = useNotices();
  const { current } = useWorkspaces();
  const unreadCount = (current?.sections ?? [])
    .flatMap((section) => section.rows)
    .reduce((sum, row) => sum + (row.count ?? 0), 0);
  const pathname = usePathname();
  return (
    <View style={{ flex: 1 }}>
      <NativeTabs tintColor={theme.accent}>
        <NativeTabs.Trigger name="(chats)">
          <NativeTabs.Trigger.Icon
            sf={{
              default: "bubble.left.and.bubble.right",
              selected: "bubble.left.and.bubble.right.fill",
            }}
            md="forum"
          />
          <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
          {unreadCount > 0 ? (
            <NativeTabs.Trigger.Badge>{String(unreadCount)}</NativeTabs.Trigger.Badge>
          ) : null}
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="home">
          <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
          <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="notices">
          <NativeTabs.Trigger.Icon
            sf={{ default: "bell", selected: "bell.fill" }}
            md="notifications"
          />
          <NativeTabs.Trigger.Label>Notices</NativeTabs.Trigger.Label>
          {unread > 0 ? (
            <NativeTabs.Trigger.Badge>{String(unread)}</NativeTabs.Trigger.Badge>
          ) : null}
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="search" role="search">
          <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
          <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
      {toast && (pathname !== "/notices" || toast.holdsUndo) ? (
        <Toast key={toast.id ?? toast.title} message={toast} onClose={onCloseToast} />
      ) : null}
      {sampleBuild ? null : <FeedNotice />}
    </View>
  );
}
