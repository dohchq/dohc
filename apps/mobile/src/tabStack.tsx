import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { demoMode } from "./demo";
import { useTheme } from "./theme";

// Each tab's stack: the platform's large title and translucent bar, over dohc's paper.
export function TabStack(props: ComponentProps<typeof Stack>) {
  const theme = useTheme();
  return (
    <Stack
      {...props}
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
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
