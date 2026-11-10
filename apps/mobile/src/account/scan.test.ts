import { phoneConnectCode } from "@dohc/workspace-contracts/phone-connect";
import { describe, expect, it } from "vitest";
import { cameraAccess, pendingScan, readScannedCode, scanReader, type CameraPermission } from "./scan";

const read = (text: string) => readScannedCode(text, { developmentServer: false });
const readInDevelopment = (text: string) => readScannedCode(text, { developmentServer: true });

describe("readScannedCode", () => {
  it("reads the code a computer makes for its server", () => {
    for (const server of ["https://dohc.example.com", "https://dohc.example.com/", "https://dohc.example.com:8443"]) {
      expect(read(phoneConnectCode(server))).toEqual({ origin: new URL(server).origin });
    }
    expect(phoneConnectCode("https://dohc.example.com/")).toBe("https://dohc.example.com");
  });

  it("normalises an origin as a typed address does", () => {
    expect(read(" HTTPS://Dohc.Example.com/ ")).toEqual({ origin: "https://dohc.example.com" });
    expect(read("https://dohc.example.com:443")).toEqual({ origin: "https://dohc.example.com" });
  });

  it("takes plain HTTP only for the development server, in a development build", () => {
    expect(readInDevelopment("http://127.0.0.1:8787")).toEqual({ origin: "http://127.0.0.1:8787" });
    expect(read("http://127.0.0.1:8787")).toEqual({ problem: "insecure" });
    expect(read("http://localhost:8787")).toEqual({ problem: "insecure" });
    expect(read("http://dohc.example.com")).toEqual({ problem: "insecure" });
    expect(readInDevelopment("http://dohc.example.com")).toEqual({ problem: "insecure" });
  });

  it("refuses a code that holds more than an origin", () => {
    for (const text of [
      "https://dohc.example.com/device", "https://dohc.example.com/device?user_code=ABCD-EFGH", "https://dohc.example.com/?code=1",
      "https://dohc.example.com/#token", "https://me:secret@dohc.example.com",
    ]) expect(read(text)).toEqual({ problem: "invalid" });
  });

  it("refuses text without a scheme, such as a sign-in code, that a typed address would take", () => {
    for (const text of ["ABCD-EFGH", "dohc.example.com", "dohc", "123456", "", "   ", "ftp://dohc.example.com", "dohc://open", "not a server"]) {
      expect(read(text)).toEqual({ problem: "invalid" });
    }
  });
});

describe("scanReader", () => {
  it("takes the first code with a server address, and nothing after it", () => {
    const scan = scanReader({ developmentServer: false });
    expect(scan("https://other.example.com/path")).toEqual({ problem: "invalid" });
    expect(scan("ABCD-EFGH")).toEqual({ problem: "invalid" });
    expect(scan("https://dohc.example.com")).toEqual({ origin: "https://dohc.example.com" });
    expect(scan("https://dohc.example.com")).toBeNull();
    expect(scan("https://other.example.com")).toBeNull();
    expect(scan("junk")).toBeNull();
  });

  it("starts again for each scanner", () => {
    expect(scanReader({ developmentServer: false })("https://dohc.example.com")).toEqual({ origin: "https://dohc.example.com" });
    expect(scanReader({ developmentServer: false })("https://dohc.example.com")).toEqual({ origin: "https://dohc.example.com" });
  });
});

describe("pendingScan", () => {
  it("gives the scanned origin once, when the sheet has gone", () => {
    const pending = pendingScan();
    pending.hold("https://dohc.example.com");
    expect(pending.take()).toBe("https://dohc.example.com");
    // Android reports the sheet gone on each render while it's hidden.
    expect(pending.take()).toBeNull();
  });

  it("gives nothing for a sheet closed without a scan", () => {
    expect(pendingScan().take()).toBeNull();
  });
});

describe("cameraAccess", () => {
  function permissions(current: CameraPermission, answer: CameraPermission) {
    const asked: string[] = [];
    return {
      asked,
      get: async () => { asked.push("get"); return current; },
      request: async () => { asked.push("request"); return answer; },
    };
  }
  const granted = { granted: true, canAskAgain: true };
  const undecided = { granted: false, canAskAgain: true };
  const refused = { granted: false, canAskAgain: false };

  it("uses the camera without asking once it's allowed", async () => {
    const camera = permissions(granted, refused);
    expect(await cameraAccess(camera)).toBe("granted");
    expect(camera.asked).toEqual(["get"]);
  });

  it("asks while the phone may, and follows the answer", async () => {
    expect(await cameraAccess(permissions(undecided, granted))).toBe("granted");
    const camera = permissions(undecided, refused);
    expect(await cameraAccess(camera)).toBe("denied");
    expect(camera.asked).toEqual(["get", "request"]);
  });

  it("doesn't ask again once the person refused", async () => {
    const camera = permissions(refused, granted);
    expect(await cameraAccess(camera)).toBe("denied");
    expect(camera.asked).toEqual(["get"]);
  });
});
