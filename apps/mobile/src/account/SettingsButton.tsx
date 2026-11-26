import { accountWords } from "@dohc/interface-words/account";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { useSignIn } from "./AccountProvider";

export function SettingsButton() {
  const theme = useTheme();
  const router = useRouter();
  const { email } = useSignIn();
  return (
    <Pressable
      style={styles.action}
      android_ripple={ripple(theme, true)}
      onPress={() => router.push("/settings")}
      accessibilityRole="button"
      accessibilityLabel={accountWords.settings}
    >
      <Mark color={theme.accent} ink={theme.bg} initial={[...email][0]?.toUpperCase() ?? ""} />
    </Pressable>
  );
}

export function Mark({ color, ink, initial }: { color: string; ink: string; initial: string }) {
  return (
    <View style={[styles.me, { backgroundColor: color }]}>
      <Text style={[styles.initial, { color: ink }]} allowFontScaling={false}>
        {initial}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  action: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" },
  me: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  initial: { fontSize: 12, fontWeight: "700" },
});
