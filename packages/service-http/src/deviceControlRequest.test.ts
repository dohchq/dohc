import { describe, expect, it } from "vitest";
import { createDeviceControlRequestParser } from "./deviceControlRequest.js";

const configuration = { hosts: new Set(["share.example.test"]), path: "/api/device-control",
  protocol: "dohc-device-control-v1", maxHeaderBytes: 4096, maxCredentialBytes: 1024 };
const rawHeaders = ["Host", "share.example.test", "Upgrade", "websocket", "Connection", "Upgrade",
  "Sec-WebSocket-Version", "13", "Sec-WebSocket-Key", "AQEBAQEBAQEBAQEBAQEBAQ==",
  "Sec-WebSocket-Protocol", "dohc-device-control-v1", "Authorization", "Bearer Y3JlZGVudGlhbA"];
const parse = createDeviceControlRequestParser(configuration);
function request(headers = rawHeaders, url = configuration.path, method = "GET") {
  return { rawHeaders: headers, url, method };
}
function replaced(name: string, value?: string) {
  const headers = [...rawHeaders], index = headers.findIndex(entry => entry.toLowerCase() === name.toLowerCase());
  if (value === undefined) headers.splice(index, 2); else headers[index + 1] = value;
  return headers;
}

describe("device control raw upgrade", () => {
  it("accepts only the configured transport and retains a bounded credential", () => {
    expect(parse(request())?.get("authorization")).toBe("Bearer Y3JlZGVudGlhbA");
    expect(parse(request(replaced("Host", "SHARE.EXAMPLE.TEST")))).not.toBeNull();
  });
  it.each(["Host", "Authorization", "Sec-WebSocket-Key", "Sec-WebSocket-Protocol", "Connection", "Upgrade",
    "Sec-WebSocket-Version"])("rejects absent and duplicate %s headers before authentication", name => {
    expect(parse(request(replaced(name)))).toBeNull();
    const value = rawHeaders[rawHeaders.indexOf(name) + 1]!;
    expect(parse(request([...rawHeaders, name.toLowerCase(), value]))).toBeNull();
  });
  it.each(["Origin", "Cookie", "Content-Length", "Transfer-Encoding", "Sec-WebSocket-Extensions"])("refuses browser or body header %s", name => {
    expect(parse(request([...rawHeaders, name, "value"]))).toBeNull();
  });
  it.each(["/api/device-control?credential=x", "/api/device-control/", "https://share.example.test/api/device-control",
    "/api/%64evice-control", "/api/live"])("refuses noncanonical target %s", target => {
    expect(parse(request(rawHeaders, target))).toBeNull();
  });
  it("refuses invalid host, protocol, key, method, framing, and byte counts", () => {
    for (const [name, value] of [["Host", "other.test"], ["Host", "share.example.test:443"],
      ["Authorization", "Bearer invalid=padding"], ["Sec-WebSocket-Key", "!!!!!!!!!!!!!!!!!!!!!!=="],
      ["Sec-WebSocket-Protocol", "dohc-live-v1"], ["Connection", "keep-alive, Upgrade"], ["Sec-WebSocket-Version", "8"]]) {
      expect(parse(request(replaced(name!, value)))).toBeNull();
    }
    expect(parse(request(rawHeaders, configuration.path, "POST"))).toBeNull();
    expect(parse(request([...rawHeaders, "incomplete"]))).toBeNull();
    expect(parse(request(replaced("Authorization", `Bearer ${"a".repeat(1024)}`)))).toBeNull();
    expect(parse(request([...rawHeaders, "X-Large", "a".repeat(4096)]))).toBeNull();
  });
  it("copies configured Hosts and rejects invalid configuration", () => {
    const hosts = new Set(["share.example.test"]), isolated = createDeviceControlRequestParser({ ...configuration, hosts });
    hosts.clear(); hosts.add("other.test");
    expect(isolated(request())).not.toBeNull();
    expect(() => createDeviceControlRequestParser({ ...configuration, hosts: new Set() })).toThrow();
    expect(() => createDeviceControlRequestParser({ ...configuration, hosts: new Set(["https://share.example.test"]) })).toThrow();
  });
});
