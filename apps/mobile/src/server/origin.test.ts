import { describe, expect, it } from "vitest";
import { checkServerAddress, serverName } from "./origin";

describe("checkServerAddress", () => {
  it("takes an HTTPS origin, with or without its scheme", () => {
    expect(checkServerAddress(" https://dohc.example.com ")).toEqual({ origin: "https://dohc.example.com" });
    expect(checkServerAddress("https://dohc.example.com/")).toEqual({ origin: "https://dohc.example.com" });
    expect(checkServerAddress("dohc.example.com")).toEqual({ origin: "https://dohc.example.com" });
    expect(checkServerAddress("HTTPS://Dohc.Example.com:8443")).toEqual({ origin: "https://dohc.example.com:8443" });
    expect(checkServerAddress("localhost:8787")).toEqual({ origin: "https://localhost:8787" });
  });

  it("takes plain HTTP only for the development server", () => {
    expect(checkServerAddress("http://127.0.0.1:8787")).toEqual({ origin: "http://127.0.0.1:8787" });
    expect(checkServerAddress("http://localhost:8787")).toEqual({ origin: "http://localhost:8787" });
    expect(checkServerAddress("http://10.0.2.2:8787")).toEqual({ origin: "http://10.0.2.2:8787" });
    expect(checkServerAddress("http://dohc.example.com")).toEqual({ problem: "insecure" });
    expect(checkServerAddress("http://192.168.1.4:8787")).toEqual({ problem: "insecure" });
  });

  it("refuses anything that isn't an origin", () => {
    expect(checkServerAddress("   ")).toEqual({ problem: "empty" });
    for (const address of [
      "https://dohc.example.com/path", "https://dohc.example.com/?a=1", "https://dohc.example.com/#top",
      "https://me:secret@dohc.example.com", "ftp://dohc.example.com", "https://", "not a server", `https://${"a".repeat(2050)}.com`,
    ]) expect(checkServerAddress(address)).toEqual({ problem: "invalid" });
  });
});

describe("serverName", () => {
  it("is the host, with its port", () => {
    expect(serverName("https://dohc.example.com")).toBe("dohc.example.com");
    expect(serverName("http://127.0.0.1:8787")).toBe("127.0.0.1:8787");
  });
});
