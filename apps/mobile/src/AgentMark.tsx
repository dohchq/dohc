import { Plug, Sparkles } from "lucide-react-native";
import { View } from "react-native";
import { useTheme, type IdentityHue } from "./theme";

// An agent's mark, as on the desktop (ChatAvatar): a rounded square outlined in the agent's identity colour, on the
// background, with the sparkle, or the plug for a connected agent, one dohc does not start. Without a chosen colour it
// takes the agent olive. Visual only: the row or the byline names the agent for VoiceOver.
export function AgentMark({ hue, connected = false, size }: { hue?: IdentityHue; connected?: boolean; size: number }) {
  const theme = useTheme();
  const ink = hue ? theme.hues[hue] : theme.agent;
  const Mark = connected ? Plug : Sparkles;
  // The desktop's icon for each size: 16 at 36, 14 at 32, 12 at 28, 10 at 18.
  const icon = size >= 34 ? 16 : size >= 30 ? 14 : size >= 26 ? 12 : 10;
  return (
    <View style={{ width: size, height: size, borderRadius: size < 24 ? 4 : 8, borderWidth: 1, borderColor: ink,
      backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
      <Mark size={icon} color={ink} strokeWidth={1.9} />
    </View>
  );
}
