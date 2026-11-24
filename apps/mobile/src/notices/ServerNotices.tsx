import { noticesWords } from "@dohc/interface-words/notices";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef, OnViewableItemsChangedInfo } from "@legendapp/list/react-native";
import { Stack, useIsFocused, useScrollToTop } from "expo-router";
import { Check } from "lucide-react-native";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { HeaderButton } from "../AndroidHeader";
import { useTheme } from "../theme";
import { HoldRow } from "../workspace/ListStates";
import { NoticeRow } from "./NoticeRow";
import { useNotices } from "./NoticesState";
import type { PhoneNotice } from "./phoneNotice";
import { freeAnswer, useAnswerReveal } from "./useAnswerReveal";

// The account's Notices, and failures held on this phone. The header shows at once. Until the whole list is known,
// from the server or from the copy saved at the last launch, an empty list holds its place, so it never says All
// clear too soon. A read that failed is a row here with its cause and Try again. Pulling down reads the list again.
// The rows on screen, only while Notices is, go to `see`, so a mention or an agent's question among them can read its
// message for Reply or Answer. Leaving Notices, or its unmounting, closes a row's answer and stops its reads.
export function ServerNotices() {
  const theme = useTheme();
  const { notices, unread, known, dismiss, setRead, markAllRead, refresh, see } = useNotices();
  const focused = useIsFocused();
  const onScreen = useRef<readonly string[]>([]);
  const isFocused = useRef(focused);
  isFocused.current = focused;
  // Unmounted, as when it loses focus, the screen wants nothing more, so its reads stop.
  useEffect(() => {
    see(focused ? onScreen.current : null);
    return () => see(null);
  }, [focused, see]);
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: OnViewableItemsChangedInfo<PhoneNotice>) => {
      onScreen.current = viewableItems.map(({ item }) => item.id);
      if (isFocused.current) see(onScreen.current);
    },
    [see],
  );
  // The list's keyboard view keeps the keyboard's room under the rows; this brings the open free answer's row above it.
  const list = useRef<LegendListRef>(null);
  // Tapping Notices again scrolls back to the top, on Android as on iOS.
  useScrollToTop(list as RefObject<LegendListRef>);
  const answering = freeAnswer(notices);
  const { onItemSizeChanged } = useAnswerReveal({
    list,
    visit: answering?.visit ?? null,
    index: answering ? notices.findIndex((notice) => notice.id === answering.noticeId) : -1,
    focused,
  });
  return (
    <>
      <Stack.Screen
        options={{
          title: noticesWords.heading,
          headerRight:
            Platform.OS === "android" && unread > 0
              ? () => <HeaderButton label={noticesWords.markAllRead} onPress={markAllRead} />
              : undefined,
        }}
      />
      {Platform.OS === "ios" && unread > 0 ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button onPress={markAllRead}>
            {noticesWords.markAllRead}
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      ) : null}
      {/* A tap on Send or a choice reaches a row's answer with the keyboard up. */}
      <KeyboardAwareLegendList
        ref={list}
        data={notices}
        onItemSizeChanged={onItemSizeChanged}
        keyExtractor={(notice) => notice.id}
        estimatedItemSize={128}
        style={{ backgroundColor: theme.bg }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
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
