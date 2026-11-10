import type { useRouter } from "expo-router";
import { Platform, Settings } from "react-native";

// Agent testing on the iOS Simulator, where a link asks before opening the app. Opens a sample screen at launch:
// `simctl spawn <device> defaults write app.dohc.mobile dohcTestRoute <checks | chat | notices | home | sharing | page | page-budget | page-days | page-journal | page-missing | chat-file | chat-agent>`.
// UI tests pass the same as a launch argument: `-dohcTestRoute <route>`. Sample builds only: app/_layout.tsx requires
// this behind the sample test, so a build without sample data leaves it and its paths out.
export function openTestRoute(router: ReturnType<typeof useRouter>) {
  if (Platform.OS !== "ios") return;
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
}
