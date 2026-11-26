// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { OwnerAppPublicationRequest } from "../ipc/ownerAppPublicationContract";
import { PersonalAppsDialog } from "./PersonalAppsDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const hash = (c: string) => c.repeat(64);
const capability = {
  kind: "dataset",
  datasetId: "00000000-0000-4000-8000-000000000001",
  name: "Trips",
  revision: 1,
  revisionSha256: hash("b"),
  operationIds: ["00000000-0000-4000-8000-000000000005"],
  operations: [
    {
      operationId: "00000000-0000-4000-8000-000000000005",
      name: "read",
      access: "helper",
      readOnly: true,
    },
  ],
};

it("opens the folder, reviews an app's access, approves it, and opens it in the browser", async () => {
  let approved = false;
  const requests: OwnerAppPublicationRequest[] = [];
  const publishOwnerApp = vi.fn(async (request: OwnerAppPublicationRequest) => {
    requests.push(request);
    switch (request.action) {
      case "personalFolder":
        return {
          kind: "personalFolder",
          path: "/state/personal-apps/w",
          apps: [{ appRoot: "trip" }],
        };
      case "listLocal":
        return {
          kind: "localListed",
          publications: approved
            ? [
                {
                  publicationId: hash("c"),
                  authorityRevision: 1,
                  appRoot: "trip",
                  sourceRevision: hash("d"),
                  approved: true,
                  active: true,
                  datasetCapability: capability,
                },
              ]
            : [],
        };
      case "prepareLocal":
        return {
          kind: "prepared",
          approvalId: "00000000-0000-4000-8000-000000000009",
          candidateDigest: hash("e"),
          appRoot: "trip",
          versionId: "main",
          sourceRevision: hash("d"),
          sourcePaths: ["trip/main.ts"],
          capabilities: [capability],
          externalNetwork: true,
          local: true,
        };
      case "approve":
        approved = true;
        return { kind: "published", publicationId: hash("c") };
      case "launchLocal":
        return {
          kind: "localLaunched",
          publicationId: hash("c"),
          url: "http://127.0.0.1:4000/#handoff",
        };
      default:
        throw new Error(`Unexpected ${request.action}`);
    }
  });
  const openExternalUrl = vi.fn(async () => undefined);
  vi.stubGlobal("dohcDesktop", { publishOwnerApp, openExternalUrl });
  const user = userEvent.setup();
  render(<PersonalAppsDialog workspaceId="w" onClose={vi.fn()} reportError={vi.fn()} />);

  expect(await screen.findByText("trip")).toBeTruthy();
  expect(screen.getByTestId("personal-apps-path").textContent).toBe("/state/personal-apps/w");
  await user.click(screen.getByRole("button", { name: "Open folder" }));
  await waitFor(() =>
    expect(requests).toContainEqual({ action: "personalFolder", workspaceId: "w", open: true }),
  );

  await user.click(screen.getByRole("button", { name: "Review" }));
  expect(await screen.findByRole("heading", { name: "Approve trip" })).toBeTruthy();
  expect(screen.getByTestId("app-access").textContent).toContain("Trips");
  await user.click(screen.getByRole("button", { name: "Approve" }));
  await user.click(await screen.findByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(openExternalUrl).toHaveBeenCalledWith({ url: "http://127.0.0.1:4000/#handoff" }),
  );
  expect(requests.map((request) => request.action)).not.toContain("cancel");
});
