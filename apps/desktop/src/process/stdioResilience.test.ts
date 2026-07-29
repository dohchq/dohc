import { Console } from "node:console";
import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { makeStreamWriteNonFatal } from "./stdioResilience";

// AUDIT-KILLREC. The dogfood journey's first hard daemon kill produced
// "A JavaScript error occurred in the main process / Error: EPIPE: broken
// pipe, write ... at Socket._write ... at console.error", and the editor was
// dead afterwards. Node writes a pipe stdio stream SYNCHRONOUSLY, so a reader
// that has gone away makes `console.error` itself throw — inside whichever
// catch handler happened to be reporting the daemon's death. This models that
// exact shape: a Writable whose _write throws synchronously.
class BrokenPipeStream extends Writable {
  writeAttempts = 0;

  override _write(): void {
    this.writeAttempts += 1;
    throw Object.assign(new Error("EPIPE: broken pipe, write"), {
      code: "EPIPE",
      syscall: "write",
    });
  }
}

it("a synchronously failing stdio stream throws before the guard", () => {
  const stream = new BrokenPipeStream();
  expect(() => stream.write("diagnostic\n")).toThrow(/EPIPE/);
});

it("a guarded stdio stream swallows its own write failure", () => {
  const stream = new BrokenPipeStream();
  const restore = makeStreamWriteNonFatal(stream);
  try {
    expect(stream.write("diagnostic\n")).toBe(true);
    expect(stream.writeAttempts).toBe(1);
  } finally {
    restore();
  }
});

it("restoring a guarded stream puts its own write back", () => {
  const stream = new BrokenPipeStream();
  const original = stream.write;
  makeStreamWriteNonFatal(stream)();
  expect(stream.write).toBe(original);
});

// ignoreErrors:false is the console shape the journey actually hit — its stack
// showed the EPIPE propagating THROUGH console.error's write into the caller,
// so a console that swallows write errors itself would prove nothing here.
function brokenPipeConsole(stream: BrokenPipeStream): Console {
  return new Console({ stdout: stream, stderr: stream, ignoreErrors: false });
}

it("console.error over an unguarded broken pipe throws into its caller", () => {
  const stream = new BrokenPipeStream();
  const console = brokenPipeConsole(stream);
  expect(() => {
    console.error("[desktop] Rust engine daemon:", new Error("exited"));
  }).toThrow(/EPIPE/);
});

it("console.error over a guarded broken pipe cannot crash its caller", () => {
  const stream = new BrokenPipeStream();
  const restore = makeStreamWriteNonFatal(stream);
  const console = brokenPipeConsole(stream);
  try {
    expect(() => {
      console.error("[desktop] Rust engine daemon:", new Error("exited"));
    }).not.toThrow();
    expect(stream.writeAttempts).toBeGreaterThan(0);
  } finally {
    restore();
  }
});

it("a guarded stream still delivers writes that succeed", () => {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      callback();
    },
  });
  const restore = makeStreamWriteNonFatal(stream);
  try {
    expect(stream.write("kept\n")).toBe(true);
  } finally {
    restore();
  }
  expect(written).toEqual(["kept\n"]);
});
