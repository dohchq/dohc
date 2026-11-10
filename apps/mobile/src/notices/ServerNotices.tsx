import { noticesWords } from "@dohc/interface-words/notices";
import { LegendList } from "@legendapp/list/react-native";
import { Stack } from "expo-router";
import { Check } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";
import { NoticeRow } from "./NoticeRow";
import { useNotices } from "./NoticesState";

// Notices in a signed-in build. The phone reads no notices from the server yet, so it lists what failed on this phone,
// such as a read of Home or Chats, each with Try again, until it's retried, dismissed or succeeds.
export function ServerNotices() {
  const theme = useTheme();
  const { notices, unread, dismiss, markAllRead } = useNotices();
  return (
    <>
      <Stack.Screen options={{ title: noticesWords.heading }} />
      {unread > 0 ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button onPress={markAllRead}>{noticesWords.markAllRead}</Stack.Toolbar.Button>
        </Stack.Toolbar>
      ) : null}
      <LegendList
        data={notices}
        keyExtractor={notice => notice.id}
        estimatedItemSize={128}
        style={{ backgroundColor: theme.bg }}
        contentInsetAdjustmentBehavior="automatic"
        ListFooterComponent={notices.length === 0 ? (
          <View style={styles.empty}>
            <Check size={40} color={theme.subtle} strokeWidth={1.75} />
            <Text style={[styles.emptyText, { color: theme.ink }]}>{noticesWords.allClear}</Text>
          </View>
        ) : undefined}
        renderItem={({ item }) => <NoticeRow notice={item} onDismiss={dismiss} />}
      />
    </>
  );
}

// As the sample's empty Notices: iOS's empty-content proportions, a little under the middle of the screen.
const styles = StyleSheet.create({
  empty: { alignItems: "center", gap: 12, paddingTop: 200 },
  emptyText: { fontSize: 20, fontWeight: "600" },
});
