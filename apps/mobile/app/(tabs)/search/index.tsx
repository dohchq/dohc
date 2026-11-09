import { Stack } from "expo-router";
import { ScrollView } from "react-native";
import { useWorkspaces } from "../../../src/chats/Workspaces";
import { syncProblem } from "../../../src/demo";
import { NotYet } from "../../../src/NotYet";
import { SyncBand } from "../../../src/notices/SyncBand";
import { useTheme } from "../../../src/theme";

export default function Search() {
  const theme = useTheme();
  const { current } = useWorkspaces();
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" alwaysBounceVertical={false} style={{ backgroundColor: theme.bg }} contentContainerStyle={{ flexGrow: 1 }}>
      <Stack.Screen options={{ title: "Search", headerSearchBarOptions: { placeholder: current ? `Search ${current.name}` : "Search" } }} />
      {syncProblem ? <SyncBand problem={syncProblem} /> : null}
      <NotYet symbol="magnifyingglass" title="Search" />
    </ScrollView>
  );
}
