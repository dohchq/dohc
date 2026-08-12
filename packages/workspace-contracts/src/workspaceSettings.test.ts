import { describe, expect, it } from "vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
  DEFAULT_WORKSPACE_SETTINGS,
  WorkspaceSettings,
  workspaceEngineSetting,
} from "./workspaceSettings";

const decodeWorkspaceSettings = Schema.decodeUnknownResult(WorkspaceSettings);

function expectFailureMessage(input: unknown, message: string): void {
  const result = decodeWorkspaceSettings(input);
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure.message).toContain(message);
  }
}

describe("WorkspaceSettings", () => {
  it("decodes the current settings and defaults old optional groups", () => {
    const oldShape = {
      version: 1,
      agents: { mcpAutoStart: false, defaultDriverId: null, defaultModel: null },
      sites: { defaultPreviewMode: "auto" },
      privacy: { confirmExternalLinks: true },
    };
    const result = decodeWorkspaceSettings(oldShape);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    }
  });

  it("rejects excess properties at every strict object level", () => {
    expectFailureMessage(
      { ...DEFAULT_WORKSPACE_SETTINGS, token: "secret" },
      "Expected no excess property",
    );
    for (const section of ["agents", "sites", "privacy", "experimental", "files"] as const) {
      expectFailureMessage(
        {
          ...DEFAULT_WORKSPACE_SETTINGS,
          [section]: { ...DEFAULT_WORKSPACE_SETTINGS[section], token: "secret" },
        },
        "Expected no excess property",
      );
    }
  });

  it("keeps decoded settings mutable", () => {
    const decoded = Schema.decodeUnknownSync(WorkspaceSettings)(DEFAULT_WORKSPACE_SETTINGS);
    decoded.agents.mcpAutoStart = true;
    decoded.files.attachmentFolderName = "attachments";
    expect(decoded.agents.mcpAutoStart).toBe(true);
    expect(decoded.files.attachmentFolderName).toBe("attachments");
  });

  it("reports string bounds with their limits and units", () => {
    expectFailureMessage(
      {
        ...DEFAULT_WORKSPACE_SETTINGS,
        agents: { ...DEFAULT_WORKSPACE_SETTINGS.agents, defaultDriverId: "" },
      },
      "String must contain at least 1 character.",
    );
    expectFailureMessage(
      {
        ...DEFAULT_WORKSPACE_SETTINGS,
        agents: { ...DEFAULT_WORKSPACE_SETTINGS.agents, defaultModel: "" },
      },
      "String must contain at least 1 character.",
    );
    expectFailureMessage(
      {
        ...DEFAULT_WORKSPACE_SETTINGS,
        agents: { ...DEFAULT_WORKSPACE_SETTINGS.agents, defaultDriverId: "x".repeat(121) },
      },
      "Default driver IDs must contain 120 characters or fewer.",
    );
    expectFailureMessage(
      {
        ...DEFAULT_WORKSPACE_SETTINGS,
        agents: { ...DEFAULT_WORKSPACE_SETTINGS.agents, defaultModel: "x".repeat(201) },
      },
      "Default models must contain 200 characters or fewer.",
    );
    expectFailureMessage(
      {
        ...DEFAULT_WORKSPACE_SETTINGS,
        files: {
          ...DEFAULT_WORKSPACE_SETTINGS.files,
          attachmentFolderName: "x".repeat(ATTACHMENT_FOLDER_NAME_MAX_LENGTH + 1),
        },
      },
      `Attachment folder names must contain ${ATTACHMENT_FOLDER_NAME_MAX_LENGTH} characters or fewer.`,
    );
  });

  it("keeps structured decode failures in the engine setting verdict", () => {
    expect(workspaceEngineSetting({ ...DEFAULT_WORKSPACE_SETTINGS, token: "secret" })).toEqual({
      state: "untrusted",
      cause: 'Expected no excess property\n  at ["token"]',
    });
  });
});
