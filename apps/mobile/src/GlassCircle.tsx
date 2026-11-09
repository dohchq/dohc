import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { StyleSheet, useColorScheme, View } from "react-native";
import { useTheme } from "./theme";

const liquidGlass = isLiquidGlassAvailable();

// A round control in iOS 26's Liquid Glass, as the system's own toolbar buttons are; a solid fill where glass isn't available.
export function GlassCircle({ size, children }: { size: number; children: ReactNode }) {
  const theme = useTheme();
  const shape = { width: size, height: size, borderRadius: size / 2 };
  const light = useColorScheme() !== "dark";
  if (liquidGlass) {
    // Over flat paper, glass has nothing to refract; a faint ink tint keeps the control visible in light mode.
    return <GlassView isInteractive glassEffectStyle="regular" tintColor={light ? "rgba(28, 27, 24, 0.06)" : undefined} style={[styles.center, shape]}>{children}</GlassView>;
  }
  return <View style={[styles.center, shape, { backgroundColor: theme.line }]}>{children}</View>;
}

const styles = StyleSheet.create({ center: { alignItems: "center", justifyContent: "center", overflow: "hidden" } });
