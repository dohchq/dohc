import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
  DEFAULT_WORKSPACE_SETTINGS,
  decodeWorkspaceSettings,
} from "./workspaceSettings";
import { WORKSPACE_SETTINGS_DEFAULTS } from "./workspaceSettingsValues";

function expectFailureMessage(input: unknown, message: string): void {
  expect(() => decodeWorkspaceSettings(input)).toThrow(message);
}

describe("WorkspaceSettings", () => {
  it("decodes the current settings and defaults old optional groups", () => {
    const oldShape = {
      version: 1,
      sites: { defaultPreviewMode: "auto" },
      privacy: { confirmExternalLinks: true },
    };
    expect(decodeWorkspaceSettings(oldShape)).toEqual(DEFAULT_WORKSPACE_SETTINGS);
  });

  it("rejects excess properties at every strict object level", () => {
    expectFailureMessage(
      { ...DEFAULT_WORKSPACE_SETTINGS, token: "secret" },
      "unrecognized_keys",
    );
    for (const section of ["sites", "privacy", "files"] as const) {
      expectFailureMessage(
        {
          ...DEFAULT_WORKSPACE_SETTINGS,
          [section]: { ...DEFAULT_WORKSPACE_SETTINGS[section], token: "secret" },
        },
        "unrecognized_keys",
      );
    }
  });

  it("rejects the retired agents group", () => {
    expectFailureMessage(
      { ...DEFAULT_WORKSPACE_SETTINGS, agents: { mcpAutoStart: false } },
      "unrecognized_keys",
    );
  });

  it("keeps decoded settings mutable", () => {
    const decoded = decodeWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS);
    decoded.privacy.confirmExternalLinks = false;
    decoded.files.attachmentFolderName = "attachments";
    expect(decoded.privacy.confirmExternalLinks).toBe(false);
    expect(decoded.files.attachmentFolderName).toBe("attachments");
  });

  it("gives each decode its own defaulted files group", () => {
    const oldShape = {
      version: 1,
      sites: { defaultPreviewMode: "auto" },
      privacy: { confirmExternalLinks: true },
    };
    const first = decodeWorkspaceSettings(oldShape);
    const second = decodeWorkspaceSettings(oldShape);
    first.files.attachmentFolderName = "attachments";
    expect(second.files.attachmentFolderName).toBe("assets");
    expect(WORKSPACE_SETTINGS_DEFAULTS.files.attachmentFolderName).toBe("assets");
  });

  it("reports the attachment folder bound with its limit and unit", () => {
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

});
