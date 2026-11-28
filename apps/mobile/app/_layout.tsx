import { accountWords } from "@dohc/interface-words/account";
import { appWords } from "@dohc/interface-words/apps";
import { chatWords } from "@dohc/interface-words/notices";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo } from "react";
import { Platform, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AccountGate, AccountProvider } from "../src/account/AccountProvider";
import { demoMode } from "../src/demo";
import { AlertTaps } from "../src/push/AlertTaps";
import { ChoiceSheetHost } from "../src/ChoiceSheet";
import { sampleBuild } from "../src/sampleBuild";
import { WarmEditor } from "../src/pages/WarmEditor";
import { useTheme } from "../src/theme";

// Agent testing on the iOS Simulator opens a sample screen at launch (src/testRoute/sample.ts). The sample test is
// written out, so a build without sample data leaves that module out (src/sampleBuild.ts).
// src/routes.test.ts reads the next statement as text, on one line.
// oxfmt-ignore
const openTestRoute = __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("../src/testRoute/sample") as typeof import("../src/testRoute/sample")).openTestRoute : null;

export default function RootLayout() {
  const router = useRouter();
  const dark = useColorScheme() === "dark";
  const theme = useTheme();
  // The navigation theme sets the native header's appearance: without `dark`, iOS draws the bar's glass and
  // fallback text in light mode, even in dark.
  const navigationTheme = useMemo(() => {
    const base = dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: theme.ink,
        background: theme.bg,
        card: theme.bg,
        text: theme.ink,
        border: theme.line,
        notification: theme.danger,
      },
    };
  }, [dark, theme]);
  // iOS fills a sheet with its own material and rounds it; Android's sheet paints nothing, so it takes the raised
  // surface and Material's 28 dp corners.
  const sheetContent = {
    backgroundColor: Platform.OS === "android" ? theme.raised : "transparent",
  };
  const sheetCorner = Platform.OS === "android" ? 28 : undefined;
  useEffect(() => {
    openTestRoute?.(router);
  }, [router]);

  const app = (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={navigationTheme}>
        <KeyboardProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="checks" options={{ title: "dohc checks" }} />
            <Stack.Screen name="chat/[id]" />
            {/* An agent's card: a sheet that fits its lines and closes by swiping down or tapping outside it. */}
            <Stack.Screen
              name="agent-card"
              options={{
                presentation: "formSheet",
                sheetAllowedDetents: "fitToContents",
                sheetGrabberVisible: true,
                sheetCornerRadius: sheetCorner,
                headerShown: false,
                contentStyle: sheetContent,
              }}
            />
            <Stack.Screen name="settings" options={{ title: accountWords.settings }} />
            <Stack.Screen name="outbox" options={{ title: chatWords.messagesOnPhone }} />
            <Stack.Screen name="app-review" options={{ title: appWords.review }} />
            {/* A record's field, changed in a sheet with Cancel and Save in its header. */}
            <Stack.Screen name="collection-field" options={{ presentation: "modal" }} />
            {/* The app runs under its own name, without the swipe back that the app's own swipes would meet. */}
            <Stack.Screen name="app-run" options={{ gestureEnabled: false }} />
            <Stack.Screen name="sketch" options={{ gestureEnabled: false }} />
            <Stack.Screen
              name="workspaces"
              options={{
                presentation: "formSheet",
                sheetAllowedDetents: "fitToContents",
                sheetGrabberVisible: true,
                sheetCornerRadius: sheetCorner,
                headerShown: false,
                contentStyle: sheetContent,
              }}
            />
          </Stack>
          {/* Design review only: page-fonts-missing opens a page whose font files are gone, so no warm web view may have
              loaded them first. launch-plain-cold times a launch without the warm web view. */}
          {demoMode === "page-fonts-missing" || demoMode === "launch-plain-cold" ? null : (
            <WarmEditor />
          )}
        </KeyboardProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
  // Any build without sample data signs in to a server first. Android's menu sheet sits outside the gate, so Connect's
  // menus have it too.
  return (
    <>
      {sampleBuild ? (
        app
      ) : (
        <AccountProvider>
          <AccountGate>
            {app}
            <AlertTaps />
          </AccountGate>
        </AccountProvider>
      )}
      {Platform.OS === "android" ? <ChoiceSheetHost /> : null}
    </>
  );
}
