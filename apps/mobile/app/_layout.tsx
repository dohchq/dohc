import { accountWords } from "@dohc/interface-words/account";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo } from "react";
import { Platform, Settings, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AccountGate, AccountProvider } from "../src/account/AccountProvider";
import { demoMode } from "../src/demo";
import { sampleBuild } from "../src/sampleBuild";
import { WarmEditor } from "../src/pages/WarmEditor";
import { useTheme } from "../src/theme";

export default function RootLayout() {
  const router = useRouter();
  const dark = useColorScheme() === "dark";
  const theme = useTheme();
  // The navigation theme sets the native header's appearance: without `dark`, iOS draws the bar's glass and
  // fallback text in light mode, even in dark.
  const navigationTheme = useMemo(() => {
    const base = dark ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, primary: theme.ink, background: theme.bg, card: theme.bg, text: theme.ink, border: theme.line, notification: theme.danger } };
  }, [dark, theme]);
  // Agent testing on the iOS Simulator, where a link asks before opening the app:
  // `simctl spawn <device> defaults write app.dohc.mobile dohcTestRoute <checks | chat | notices | home | sharing | page | page-budget | page-days | page-journal | page-missing | chat-file | chat-agent>`.
  useEffect(() => {
    // The sample test written out, so a build without sample data folds this away (src/sampleBuild.ts).
    if (!(__DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1") || Platform.OS !== "ios") return;
    const route: unknown = Settings.get("dohcTestRoute");
    if (route === "checks") router.push("/checks");
    if (route === "chat") router.push({ pathname: "/chat/[id]", params: { id: "g-planning", name: "planning" } });
    if (route === "chat-file") router.push({ pathname: "/chat/[id]", params: { id: "c-packing", name: "packing-list.md" } });
    if (route === "chat-agent") router.push({ pathname: "/chat/[id]", params: { id: "a-scout", name: "Scout" } });
    if (route === "notices") router.navigate("/notices");
    if (route === "home") router.navigate("/home");
    if (route === "sharing") router.push("/sharing");
    const page = { page: "trip/packing-list.md", "page-budget": "trip/budget.md", "page-days": "itinerary/days.md", "page-journal": "trip/journal.md", "page-missing": "trip/gone.md" }[String(route)];
    if (page) router.push({ pathname: "/page", params: { path: page, t0: String(Date.now()) } });
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
            <Stack.Screen name="agent-card" options={{ presentation: "formSheet", sheetAllowedDetents: "fitToContents",
              sheetGrabberVisible: true, headerShown: false, contentStyle: { backgroundColor: "transparent" } }} />
            {/* A signed-in build's Settings, from your mark in the Chats header, and its workspace switcher. */}
            <Stack.Screen name="settings" options={{ title: accountWords.settings }} />
            <Stack.Screen name="workspaces" options={{ presentation: "formSheet", sheetAllowedDetents: "fitToContents",
              sheetGrabberVisible: true, headerShown: false, contentStyle: { backgroundColor: "transparent" } }} />
          </Stack>
          {/* Design review only: page-fonts-missing opens a page whose font files are gone, so no warm web view may have
              loaded them first. */}
          {demoMode === "page-fonts-missing" ? null : <WarmEditor />}
        </KeyboardProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
  // Any build without sample data signs in to a server first.
  return sampleBuild ? app : <AccountProvider><AccountGate>{app}</AccountGate></AccountProvider>;
}
