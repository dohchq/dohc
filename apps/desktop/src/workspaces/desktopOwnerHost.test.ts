import {afterEach, expect, it, vi} from "vitest";
import {startDesktopOwnerHost} from "./desktopOwnerHost";

const transport = vi.hoisted(() => ({connect: vi.fn()}));
vi.mock("@dohc/sync-relay/device-host", async importOriginal => ({
  ...await importOriginal<object>(), connectDeviceHost: transport.connect,
}));
afterEach(() => { vi.useRealTimers(); transport.connect.mockReset(); });

it.each(["lookup", "owner", "registered"])("reconnects after a binding retires during %s and leaves the next connection alone", async phase => {
  vi.useFakeTimers();
  type Options = Parameters<typeof startDesktopOwnerHost>[0];
  let generation = 0;
  const calls: {options: Parameters<typeof import("@dohc/sync-relay/device-host").connectDeviceHost>[0]; stop: ReturnType<typeof vi.fn>}[] = [];
  transport.connect.mockImplementation(options => {
    const closed = Promise.withResolvers<void>();
    const stop = vi.fn(() => closed.resolve()); calls.push({options,stop});
    return {stop,closed:closed.promise};
  });
  const owner = {nativeSessionId:"session", assertCurrent:vi.fn(), prepareHandoff:vi.fn(), finishHandoff:vi.fn(), remoteApplied:vi.fn()};
  const ownerFor = vi.fn(() => owner);
  const bindings = vi.fn(async () => {
    const captured = generation;
    return {client:{} as Awaited<ReturnType<Options["bindings"]>>["client"],workspaces:[{workspaceId:"workspace",workspaceHandle:`handle-${captured}`}],
      assertCurrent() {if (generation !== captured) throw new Error("binding retired");}};
  });
  const host = startDesktopOwnerHost({
    config:{url:"wss://owner.test",credential:{},control:{},transport:{},reconnectDelayMs:10} as Options["config"],
    bindings,ownerFor,onError:vi.fn(),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    const first = calls[0]!;
    const binding = {} as Parameters<Options["ownerFor"]>[0];
    const retained = phase === "owner" ? first.options.existingOwner!.ownerFor(binding) : undefined;
    generation++;
    const check = phase === "lookup" ? () => first.options.existingOwner!.ownerFor(binding)
      : phase === "owner" ? () => retained!.assertCurrent() : () => first.options.onRegistered!({} as never);
    expect(check).toThrow("binding retired");
    expect(first.stop).toHaveBeenCalledOnce();
    if (phase === "lookup") expect(ownerFor).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(bindings).toHaveBeenCalledTimes(2);
    expect(calls[1]!.options.existingOwner!.workspaces[0]!.workspaceHandle).toBe("handle-1");
    expect(check).toThrow("binding retired");
    expect(calls[1]!.stop).not.toHaveBeenCalled();
  } finally {host.stop(); await vi.advanceTimersByTimeAsync(100);}
});

it("keeps a current connection when the requested editor is unavailable", async () => {
  type Options = Parameters<typeof startDesktopOwnerHost>[0];
  const connected = Promise.withResolvers<Parameters<typeof import("@dohc/sync-relay/device-host").connectDeviceHost>[0]>();
  const closed = Promise.withResolvers<void>(), stop = vi.fn(() => closed.resolve());
  transport.connect.mockImplementation(options => {connected.resolve(options);return {stop,closed:closed.promise};});
  const host = startDesktopOwnerHost({config:{url:"wss://owner.test",credential:{},control:{},transport:{},reconnectDelayMs:10} as Options["config"],
    bindings:async () => ({client:{} as Awaited<ReturnType<Options["bindings"]>>["client"],workspaces:[],assertCurrent(){}}),
    ownerFor(){throw new Error("Existing owner is unavailable.");},onError:vi.fn()});
  try {const options = await connected.promise;expect(() => options.existingOwner!.ownerFor({} as never)).toThrow("Existing owner is unavailable");expect(stop).not.toHaveBeenCalled();}
  finally {host.stop();await closed.promise;}
});
