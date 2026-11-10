import { Stack } from "expo-router";
import { ScrollView } from "react-native";
import { syncProblem } from "../../../src/demo";
import { ServerHome } from "../../../src/home/ServerHome";
import { NotYet } from "../../../src/NotYet";
import { SyncBand } from "../../../src/notices/SyncBand";
import { sampleBuild } from "../../../src/sampleBuild";
import { useTheme } from "../../../src/theme";
import { WorkspaceButton } from "../../../src/WorkspaceButton";

export default function Home() {
  return sampleBuild ? <SampleHome /> : <ServerHome />;
}

// The sample has no Home yet.
function SampleHome() {
  const theme = useTheme();
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" alwaysBounceVertical={false} style={{ backgroundColor: theme.bg }} contentContainerStyle={{ flexGrow: 1 }}>
      <Stack.Screen options={{ title: "Home", headerLeft: () => <WorkspaceButton /> }} />
      {syncProblem ? <SyncBand problem={syncProblem} /> : null}
      <NotYet symbol="house" title="Home" />
    </ScrollView>
  );
}
