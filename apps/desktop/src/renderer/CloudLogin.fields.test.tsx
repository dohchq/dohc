// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudLogin } from "./CloudLogin";

const bridgeMock = {
  cloudStatus: vi.fn(),
  cloudLoginStart: vi.fn(),
  cloudLoginPoll: vi.fn(),
  cloudLogout: vi.fn(),
  onCloudSessionChanged: vi.fn(),
  openExternalUrl: vi.fn(),
  platform: "linux",
  insecureLoopbackServersForTests: false,
  getUpdateState: vi.fn(),
  onUpdateState: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue({ connected: false });
  bridgeMock.cloudLoginStart.mockResolvedValue({
    userCode: "ABCD",
    verificationUri: "https://cloud.dohc.dev/device",
  });
  bridgeMock.cloudLoginPoll.mockImplementation(() => new Promise(() => {}));
  bridgeMock.onCloudSessionChanged.mockReturnValue(() => undefined);
  bridgeMock.getUpdateState.mockResolvedValue({ status: "idle", message: "Up to date" });
  bridgeMock.onUpdateState.mockReturnValue(() => undefined);
});

afterEach(() => {
  cleanup();
});

describe("CloudLogin fields", () => {
  it("labels the address above its field and focuses it in its own dialog", async () => {
    render(<CloudLogin onConnectionError={() => undefined} />);
    const field = await screen.findByLabelText("Server address");
    expect(field).toBe(screen.getByTestId("cloud-server-url"));
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("leaves focus to a host that embeds it", async () => {
    render(<CloudLogin embedded onConnectionError={() => undefined} />);
    await screen.findByTestId("cloud-server-url");
    expect(document.activeElement).toBe(document.body);
  });

  it("shows no introduction above the address", async () => {
    render(<CloudLogin onConnectionError={() => undefined} />);
    await screen.findByTestId("cloud-server-url");
    expect(screen.queryByText(/already work on this machine/)).toBeNull();
  });

  it("checks the address when focus leaves it, not on each key", async () => {
    const user = userEvent.setup();
    render(<CloudLogin onConnectionError={() => undefined} />);
    const field = await screen.findByTestId("cloud-server-url");
    await user.click(field);
    await user.type(field, "http://dohc.example.test");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.tab();
    const error = screen.getByTestId("cloud-connection-error");
    expect(error.textContent).toBe("Enter an HTTPS server address.");
    expect(error.querySelector("svg")?.closest("[aria-hidden]")).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe("cloud-connection-error");

    // Typing clears it until the next check.
    await user.type(field, "x");
    expect(screen.queryByTestId("cloud-connection-error")).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("keeps the address in view with a disabled Connecting… while it starts", async () => {
    const user = userEvent.setup();
    bridgeMock.cloudLoginStart.mockImplementationOnce(() => new Promise(() => {}));
    render(<CloudLogin onConnectionError={() => undefined} />);
    const field = (await screen.findByTestId("cloud-server-url")) as HTMLInputElement;
    await user.type(field, "https://dohc.example.test{Enter}");

    const button = screen.getByTestId("cloud-connect-start") as HTMLButtonElement;
    await waitFor(() => expect(button.textContent).toBe("Connecting…"));
    expect(button.disabled).toBe(true);
    expect(field.value).toBe("https://dohc.example.test");
    expect(field.readOnly).toBe(true);
  });

  it("asks for browser approval in few words", async () => {
    const user = userEvent.setup();
    render(<CloudLogin onConnectionError={() => undefined} />);
    await user.type(await screen.findByTestId("cloud-server-url"), "https://dohc.example.test{Enter}");
    const pending = await screen.findByTestId("cloud-login-pending");
    expect(pending.textContent).toContain("Approve this device in your browser.");
    expect(screen.getByTestId("cloud-user-code").textContent).toBe("ABCD");
    expect(screen.getByRole("status").textContent).toBe("Waiting for approval");
  });

  it("offers Try again in place when the status check fails", async () => {
    const user = userEvent.setup();
    const onConnectionError = vi.fn();
    bridgeMock.cloudStatus.mockRejectedValueOnce(new Error("engine unavailable"));
    render(<CloudLogin onConnectionError={onConnectionError} />);
    const unknown = await screen.findByTestId("cloud-connection-unknown");
    expect(onConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dohc could not check this connection." }),
    );

    await user.click(within(unknown).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  });
});
