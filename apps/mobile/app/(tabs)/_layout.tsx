import { NativeTabs } from "expo-router/native-tabs";
import { File, Paths } from "expo-file-system";
import { useEffect } from "react";
import { Platform, View } from "react-native";
import { useWorkspaces, WorkspacesProvider } from "../../src/chats/Workspaces";
import { demoMode } from "../../src/demo";
import { useNotices } from "../../src/notices/NoticesState";
import { sampleBuild } from "../../src/sampleBuild";
import { views } from "../../src/server/workspaceData";
import { FeedNotice } from "../../src/workspace/FeedNotice";
import { useView } from "../../src/workspace/useView";
import { useTheme } from "../../src/theme";

// The platform's own tab bar: Liquid Glass on iOS 26, Material on Android.
export default function TabsLayout() {
  return (
    <WorkspacesProvider>
      <Tabs />
    </WorkspacesProvider>
  );
}

const useServerChatsUnread = () =>
  (useView(views.chats).state.value ?? []).reduce((sum, group) => sum + group.unreadCount, 0);
const useChatsUnread = sampleBuild ? () => 0 : useServerChatsUnread;

function Tabs() {
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
  const unreadCount =
    (current?.sections ?? [])
      .flatMap((section) => section.rows)
      .reduce((sum, row) => sum + (row.count ?? 0), 0) + useChatsUnread();
  return (
    <View style={{ flex: 1 }}>
      {/* Android's Material bar takes dohc's paper and ink, not the system's own palette; iOS draws Liquid Glass. */}
      <NativeTabs
        tintColor={theme.accent}
        backgroundColor={Platform.OS === "android" ? theme.panel : undefined}
        indicatorColor={theme.panel2}
        iconColor={Platform.OS === "android" ? theme.muted : undefined}
        labelStyle={Platform.OS === "android" ? { color: theme.muted } : undefined}
        rippleColor={`${theme.ink}1f`}
        badgeBackgroundColor={Platform.OS === "android" ? theme.danger : undefined}
        badgeTextColor={theme.bg}
      >
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
      </NativeTabs>
      {sampleBuild ? null : <FeedNotice />}
    </View>
  );
}
