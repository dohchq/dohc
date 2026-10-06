// @vitest-environment node
import { expect, it } from "vitest";
import { editorTabTestId } from "./testPins";

it.each([
  ["fixture/旅 [one].md", "tab-fixture/旅 [one].md"],
  ["tab://graph", "tab-dohc://graph"],
  ["tab://chats/channel/team%2Fone", "tab-dohc://chats/channel/team%2Fone"],
  ["tab://data-collection/data%2Fdataset.json/00000000-0000-4000-8000-000000000002", "tab-dohc://data-collection/data%2Fdataset.json/00000000-0000-4000-8000-000000000002"],
  ["tab://retired/report", "tab-tab://retired/report"],
  ["tab://chats/channel/", "tab-tab://chats/channel/"],
  ["tab://chats/channel/%E0", "tab-tab://chats/channel/%E0"],
  ["tab://data-collection/data%2Fdataset.json/not-a-uuid", "tab-tab://data-collection/data%2Fdataset.json/not-a-uuid"],
])("builds the renderer's pinned selector in Node for %s", (path, selector) => {
  expect(editorTabTestId(path)).toBe(selector);
});
