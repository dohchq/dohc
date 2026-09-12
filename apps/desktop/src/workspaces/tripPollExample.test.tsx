// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Poll } from "../../../../examples/trip-poll/Poll";
import { CollectionError, type CollectionClient, type Page } from "../../../../examples/trip-poll/broker";

afterEach(cleanup);
const empty: Page = { records: [], nextPath: null };
const receipt = { kind: "accepted" as const, acceptanceId: "accepted", path: "responses/1.md", objectId: "object", momentId: "moment", acceptedAtMs: 1 };
it("loads shared responses, pages, refreshes and submits a named destination", async () => {
  const list = vi.fn<CollectionClient["list"]>().mockResolvedValueOnce({ records: [{path: "a", recordId: null, fields: {name: "Sam", destination: "Manila"}}], nextPath: "a" })
    .mockResolvedValueOnce({records: [{path: "b", recordId: null, fields: {destination: "Tokyo"}}], nextPath: null}).mockResolvedValue(empty);
  const create = vi.fn<CollectionClient["create"]>().mockResolvedValue(receipt);
  render(<Poll client={{list, create}} />);
  await screen.findByText("Sam"); fireEvent.click(screen.getByRole("button", {name: "Show more responses"}));
  await screen.findByText("Someone"); expect(list).toHaveBeenLastCalledWith({limit: 50, afterPath: "a"});
  fireEvent.change(screen.getByLabelText("Name (optional)"), {target: {value: " Ice "}});
  fireEvent.change(screen.getByLabelText("Destination"), {target: {value: "Manila"}});
  fireEvent.click(screen.getByRole("button", {name: "Send response"}));
  await screen.findByText("Response saved.");
  expect(create).toHaveBeenCalledWith({idempotencyKey: expect.any(String), fields: {name: "Ice", destination: "Manila"}});
});
it("retries uncertain acceptance with the same key and unchanged payload", async () => {
  const create = vi.fn<CollectionClient["create"]>().mockRejectedValueOnce(new CollectionError(503)).mockResolvedValueOnce(receipt);
  render(<Poll client={{list: async () => empty, create}} />);
  await screen.findByText("No responses yet. Send yours above.");
  fireEvent.click(screen.getByRole("button", {name: "Send response"}));
  const retry = await screen.findByRole("button", {name: "Retry response"});
  expect((screen.getByLabelText("Destination") as HTMLSelectElement).closest("fieldset")?.disabled).toBe(true);
  fireEvent.click(retry); await screen.findByText("Response saved.");
  expect(create).toHaveBeenCalledTimes(2); expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
});
it("reports unavailable access and recovers on refresh without inventing saved state", async () => {
  const list = vi.fn<CollectionClient["list"]>().mockRejectedValueOnce(new CollectionError(404)).mockResolvedValue(empty);
  render(<Poll client={{list, create: async () => receipt}} />);
  await screen.findByRole("alert"); expect(screen.getByRole("alert").textContent).toContain("Ask its owner");
  fireEvent.click(screen.getByRole("button", {name: "Refresh"}));
  await screen.findByText("No responses yet. Send yours above.");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
