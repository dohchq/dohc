import { noticesWords } from "@dohc/interface-words/notices";
import { LegendList, type OnViewableItemsChangedInfo } from "@legendapp/list/react-native";
import { Stack, useIsFocused } from "expo-router";
import { Check } from "lucide-react-native";
import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";
import { HoldRow } from "../workspace/ListStates";
import { NoticeRow } from "./NoticeRow";
import { useNotices } from "./NoticesState";
import type { PhoneNotice } from "./phoneNotice";

// The account's Notices, and failures held on this phone. The header shows at once. Until the whole list is known,
// from the server or from the copy saved at the last launch, an empty list holds its place, so it never says All
// clear too soon. A read that failed is a row here with its cause and Try again. Pulling down reads the list again.
// The rows on screen, only while Notices is, go to `see`, so a mention among them can read its message for Reply.
export function ServerNotices() {
  const theme = useTheme();
  const { notices, unread, known, dismiss, setRead, markAllRead, refresh, see } = useNotices();
  const focused = useIsFocused();
  const onScreen = useRef<readonly string[]>([]);
  const isFocused = useRef(focused);
  isFocused.current = focused;
  useEffect(() => see(focused ? onScreen.current : []), [focused, see]);
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: OnViewableItemsChangedInfo<PhoneNotice>) => {
      onScreen.current = viewableItems.map(({ item }) => item.id);
      if (isFocused.current) see(onScreen.current);
    },
    [see],
  );
  return (
    <>
      <Stack.Screen options={{ title: noticesWords.heading }} />
      {unread > 0 ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button onPress={markAllRead}>
            {noticesWords.markAllRead}
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      ) : null}
      <LegendList
        data={notices}
        keyExtractor={(notice) => notice.id}
        estimatedItemSize={128}
        style={{ backgroundColor: theme.bg }}
        contentInsetAdjustmentBehavior="automatic"
        refreshing={false}
        onRefresh={refresh}
        onViewableItemsChanged={onViewableItemsChanged}
        ListFooterComponent={
          notices.length > 0 ? undefined : known ? (
            <View style={styles.empty}>
              <Check size={40} color={theme.subtle} strokeWidth={1.75} />
              <Text style={[styles.emptyText, { color: theme.ink }]}>{noticesWords.allClear}</Text>
            </View>
          ) : (
            <HoldRow />
          )
        }
        renderItem={({ item }) => (
          <NoticeRow notice={item} onDismiss={dismiss} onSetRead={setRead} />
        )}
      />
    </>
  );
}

// As the sample's empty Notices: iOS's empty-content proportions, a little under the middle of the screen.
const styles = StyleSheet.create({
  empty: { alignItems: "center", gap: 12, paddingTop: 200 },
  emptyText: { fontSize: 20, fontWeight: "600" },
});
