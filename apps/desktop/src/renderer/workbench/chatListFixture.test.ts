import { expect, it } from "vitest";
import { ChatMessageRecord } from "../../ipc/bridgeContract";
import { chatListMessage } from "../../../e2e/fixtures/chat-list/messages";

it.each([false, true])("gives every scrolling fixture row its author's presentation (sparse=%s)", (sparse) => {
  for (let index = -20; index <= 500; index++) {
    expect(() => ChatMessageRecord.parse(chatListMessage(index, sparse))).not.toThrow();
  }
  expect(chatListMessage(0).presentation.group).toBe(chatListMessage(2).presentation.group);
  expect(chatListMessage(0).presentation.group).not.toBe(chatListMessage(3).presentation.group);
});
