import { DohcCliError } from "./errors";

// Reads stdin whole, or stops at `limit` and refuses with its message, so a
// huge pipe is never read in full.
export async function readStdinText(
  stream: AsyncIterable<string | Uint8Array>,
  limit?: { bytes: number; message: string },
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    bytesRead += bytes.length;
    if (limit !== undefined && bytesRead > limit.bytes) {
      throw new DohcCliError(limit.message);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const MAX_PASSWORD_BYTES = 1024;

// Reads a password from piped stdin, without its final line break, or asks
// for it on a terminal without echoing it.
export async function readPassword(
  stdin: NodeJS.ReadStream,
  prompt: NodeJS.WritableStream,
): Promise<string> {
  if (!stdin.isTTY) {
    const text = await readStdinText(stdin, { bytes: MAX_PASSWORD_BYTES + 2, message: "the password is at most 1024 bytes" });
    return text.replace(/\r?\n$/u, "");
  }
  prompt.write("Server account password: ");
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return await new Promise((resolvePassword, reject) => {
    let password = "";
    const finish = (error?: DohcCliError) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      prompt.write("\n");
      if (error) reject(error);
      else resolvePassword(password);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new DohcCliError("cancelled"));
        password = char === "\u007f" || char === "\b" ? [...password].slice(0, -1).join("") : password + char;
      }
    };
    stdin.on("data", onData);
  });
}
