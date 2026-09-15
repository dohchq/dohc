import { compileClosedApp } from "./closedAppCompiler.ts";

// This entry executes only under the trusted process supervisor's OS job.
try {
  const [maxInputBytes, maxOutputBytes] = process.argv.slice(2).map(Number);
  if (![maxInputBytes, maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid compiler wire bounds.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.byteLength;
    if (length > maxInputBytes!) throw new Error("Compiler wire input bound exceeded.");
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(request.inputs)) throw new Error("Invalid compiler input.");
  request.inputs = request.inputs.map((file: { path: string; sha256: string; bytes: string }) => ({ ...file, bytes: Buffer.from(file.bytes, "base64") }));
  const build = await compileClosedApp(request);
  const output = Buffer.from(JSON.stringify({ ...build, files: build.files.map(file => ({ ...file, bytes: Buffer.from(file.bytes).toString("base64") })) }));
  if (output.byteLength > maxOutputBytes!) throw new Error("Compiler wire output bound exceeded.");
  process.stdout.write(output);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
