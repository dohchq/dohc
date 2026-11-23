import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { Platform } from "react-native";
import { TabHeader } from "./AndroidHeader";
import { demoMode } from "./demo";
import { useTheme } from "./theme";

// Each tab's stack: on iOS the large title and translucent bar, over dohc's paper. On Android, dohc's own header
// (src/AndroidHeader.tsx).
export function TabStack(props: ComponentProps<typeof Stack>) {
  const theme = useTheme();
  return (
    <Stack
      {...props}
      screenOptions={{
        ...(Platform.OS === "ios"
          ? { headerLargeTitle: true, headerTransparent: true }
          : { header: (header) => <TabHeader {...header} /> }),
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
        // Design review only: "no-tint" leaves the system tint, to compare the header glass with system apps.
        ...(demoMode === "no-tint" ? {} : { headerTintColor: theme.ink }),
        contentStyle: { backgroundColor: theme.bg },
        ...props.screenOptions,
      }}
    />
  );
}
