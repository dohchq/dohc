import { describe, expect, it } from "vitest";
import {
  AGENT_CHANNEL_WIRE_ID,
  GENERAL_CHANNEL_WIRE_ID,
  classifyEngineFilePath,
  classifyEngineFilePathForRead,
} from "./index";

describe("security contract", () => {
  it("keeps wire ids and share-read secret classification stable", () => {
    expect(AGENT_CHANNEL_WIRE_ID).toBe("channel_wire_agent_v1");
    expect(GENERAL_CHANNEL_WIRE_ID).toBe("channel_wire_general_v1");
    expect(classifyEngineFilePath("notes/brief.md")).toEqual({ kind: "tracked" });
    expect(classifyEngineFilePathForRead("shared-with-me/alex/.env")).toEqual({
      kind: "secret",
    });
  });
});
