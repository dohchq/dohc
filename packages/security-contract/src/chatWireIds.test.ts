import { expect, it } from "vitest";
import { channelSlugForName, groupFolderForName } from "./chatWireIds";

it("uses Unicode whitespace like the engine when deriving channel folders", () => {
  expect(channelSlugForName("a\u0085b")).toBe("a-b");
  expect(channelSlugForName(" a\u0085 \t_b ")).toBe("a-b");
});

it("a group's default folder keeps letters and digits of any script", () => {
  expect(groupFolderForName("会议 Notes")).toBe("会议-notes");
  expect(groupFolderForName("Équipe_Été")).toBe("équipe-été");
  expect(groupFolderForName("💥")).toBe("");
  expect(groupFolderForName("  Launch  team ")).toBe("launch-team");
});
