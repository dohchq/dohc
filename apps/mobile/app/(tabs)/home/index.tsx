import { Stack } from "expo-router";
import { ScrollView } from "react-native";
import { syncProblem } from "../../../src/demo";
import { NotYet } from "../../../src/NotYet";
import { SyncBand } from "../../../src/notices/SyncBand";
import { useTheme } from "../../../src/theme";
import { WorkspaceButton } from "../../../src/WorkspaceButton";

export default function Home() {
  const theme = useTheme();
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" alwaysBounceVertical={false} style={{ backgroundColor: theme.bg }} contentContainerStyle={{ flexGrow: 1 }}>
      <Stack.Screen options={{ title: "Home", headerLeft: () => <WorkspaceButton /> }} />
      {syncProblem ? <SyncBand problem={syncProblem} /> : null}
      <NotYet symbol="house" title="Home" />
    </ScrollView>
  );
}
