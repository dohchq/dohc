import type { LegendListRef } from "@legendapp/list/react-native";
import { useRef } from "react";
import { ChatsScreen, ServerChats } from "../../../src/chats/Chats";
import { useWorkspaces } from "../../../src/chats/Workspaces";
import { syncProblem } from "../../../src/demo";
import { NotYet } from "../../../src/NotYet";
import { SyncBand } from "../../../src/notices/SyncBand";

// The sample's sheets and launch probe, which name its files and people, in a sample build only (src/sampleBuild.ts).
// src/routes.test.ts reads the next statement as text, on one line.
// oxfmt-ignore
const demo = __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? { ...(require("../../../src/chats/demoSheets") as typeof import("../../../src/chats/demoSheets")), ...(require("../../../src/firstScreenProbe") as typeof import("../../../src/firstScreenProbe")) } : null;

// The sample's workspaces, on the screen a signed-in build shows.
function ChatsFromSample() {
  const { current } = useWorkspaces();
  const list = useRef<LegendListRef>(null);
  demo?.useDemoSheet();
  return (
    <ChatsScreen
      key={current?.id}
      current={current}
      sections={current?.sections ?? null}
      list={list}
      notice={
        <>
          {demo?.firstScreenProbeOn ? <demo.FirstScreenProbe list={list} /> : null}
          {current ? null : <NotYet symbol="person.crop.circle.badge.plus" title="First run" />}
          {syncProblem ? <SyncBand problem={syncProblem} /> : null}
        </>
      }
    />
  );
}

export default demo ? ChatsFromSample : ServerChats;
