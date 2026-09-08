import { expect, it } from "vitest";
import { DeviceCreditSender } from "./deviceCreditSender";
import { DeviceControlWriter, DeviceCreditWindow } from "./deviceControlWriter";

it("stalls at the peer window and resumes only on new valid cumulative credit", () => {
  const sent: Buffer[] = [];
  let drains = 0, errors = 0;
  const queue = new DeviceCreditSender({ maxQueuedBytes: 1024, maxPayloadBytes: 8, windowBytes: 48,
    send(bytes, done) { sent.push(Buffer.from(bytes)); done(); }, onDrain() { drains++; }, onError() { errors++; } });
  queue.write(Buffer.from("0123456789abcdefghijklmnopqrstuv"));
  expect(sent).toHaveLength(2); expect(drains).toBe(0);
  queue.acknowledge(24);
  expect(sent).toHaveLength(3);
  queue.acknowledge(48);
  expect(sent).toHaveLength(4); expect(drains).toBe(1);
  expect(Buffer.concat(sent).toString()).toBe("0123456789abcdefghijklmnopqrstuv");
  queue.acknowledge(48);
  expect(errors).toBe(1);
});

it("refuses excess credit and releases a parked send on close", () => {
  let sends = 0, errors = 0;
  const queue = new DeviceCreditSender({ maxQueuedBytes: 100, maxPayloadBytes: 8, windowBytes: 24,
    send(_bytes, done) { sends++; done(); }, onDrain() {}, onError() { errors++; } });
  queue.write(Buffer.alloc(24));
  queue.acknowledge(25);
  expect(errors).toBe(1); expect(sends).toBe(1);
  queue.acknowledge(24); expect(sends).toBe(1);
});

it("bounds a buffered burst even before socket pausing can take effect", () => {
  const window = new DeviceCreditWindow(8192, 4096);
  window.receive(4096);
  expect(() => window.receive(4096)).toThrow("credit exhausted");
  window.acknowledge(4112);
  window.receive(4096);
  expect(() => window.acknowledge(4112)).toThrow("Invalid device credit");
});

it("coalesces credits while a local write is pending without losing the latest total", () => {
  const sent: { bytes: Buffer; done: (error?: Error) => void }[] = [];
  let errors = 0;
  const writer = new DeviceControlWriter({ send(bytes, _binary, done) { sent.push({ bytes, done }); }, onError() { errors++; } });
  writer.write(Buffer.from("data"), true, () => {});
  writer.acknowledge(24); writer.acknowledge(48); writer.acknowledge(72);
  expect(sent).toHaveLength(1);
  sent[0]!.done();
  expect(JSON.parse(sent[1]!.bytes.toString()).receivedBytes).toBe(72);
  writer.close(); sent[1]!.done(); expect(errors).toBe(0);
});
