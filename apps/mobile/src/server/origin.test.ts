import { describe, expect, it } from "vitest";
import { checkServerAddress, serverName } from "./origin";

const check = (address: string) => checkServerAddress(address, { developmentServer: false });
const checkInDevelopment = (address: string) => checkServerAddress(address, { developmentServer: true });

describe("checkServerAddress", () => {
  it("takes an HTTPS origin, with or without its scheme", () => {
    expect(check(" https://dohc.example.com ")).toEqual({ origin: "https://dohc.example.com" });
    expect(check("https://dohc.example.com/")).toEqual({ origin: "https://dohc.example.com" });
    expect(check("dohc.example.com")).toEqual({ origin: "https://dohc.example.com" });
    expect(check("HTTPS://Dohc.Example.com:8443")).toEqual({ origin: "https://dohc.example.com:8443" });
    expect(check("localhost:8787")).toEqual({ origin: "https://localhost:8787" });
  });

  it("takes plain HTTP only for the development server, in a development build", () => {
    expect(checkInDevelopment("http://127.0.0.1:8787")).toEqual({ origin: "http://127.0.0.1:8787" });
    expect(checkInDevelopment("http://localhost:8787")).toEqual({ origin: "http://localhost:8787" });
    expect(checkInDevelopment("http://10.0.2.2:8787")).toEqual({ origin: "http://10.0.2.2:8787" });
    expect(checkInDevelopment("http://dohc.example.com")).toEqual({ problem: "insecure" });
    expect(checkInDevelopment("http://192.168.1.4:8787")).toEqual({ problem: "insecure" });
    for (const address of ["http://127.0.0.1:8787", "http://localhost:8787", "http://10.0.2.2:8787"]) {
      expect(check(address)).toEqual({ problem: "insecure" });
    }
  });

  it("refuses anything that isn't an origin", () => {
    expect(check("   ")).toEqual({ problem: "empty" });
    for (const address of [
      "https://dohc.example.com/path", "https://dohc.example.com/?a=1", "https://dohc.example.com/#top",
      "https://me:secret@dohc.example.com", "ftp://dohc.example.com", "https://", "not a server", `https://${"a".repeat(2050)}.com`,
    ]) expect(check(address)).toEqual({ problem: "invalid" });
  });
});

describe("serverName", () => {
  it("is the host, with its port", () => {
    expect(serverName("https://dohc.example.com")).toBe("dohc.example.com");
    expect(serverName("http://127.0.0.1:8787")).toBe("127.0.0.1:8787");
  });
});
