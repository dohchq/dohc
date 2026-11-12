// A stand-in for the dohc app. The real MCP server sends it the requests it would send the
// app, so tool names, descriptions, schemas, and result shapes all come from this checkout.
// Document and file writes change the case's workspace folder as the app would. Every other
// request gets the answer the case lists, and an unlisted one is recorded so the sample ends
// as an error instead of grading an agent against an app that does not answer.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolContext } from "../src/tools";
import type { DesktopAnswer } from "./case";

type DesktopRequest = NonNullable<ToolContext["request"]>;
type Args = Record<string, unknown>;

async function readText(root: string, path: string): Promise<string | undefined> {
  return readFile(join(root, path), "utf8").catch(() => undefined);
}

async function writeText(root: string, path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

// The refusals quote the app's own wording, so an agent recovers here as it would in dohc.
export const workspaceVerbs: Record<string, (root: string, args: Args) => Promise<unknown>> = {
  async documentRead(root, args) {
    const path = String(args.path);
    const markdown = await readText(root, path);
    return markdown === undefined ? { ok: false, reason: `${path} does not exist.` } : { ok: true, path, markdown };
  },
  async documentEdit(root, args) {
    const path = String(args.path);
    const markdown = await readText(root, path);
    if (markdown === undefined) return { ok: false, reason: `${path} does not exist.` };
    const replacement = String(args.replacement);
    if (args.find === undefined) {
      await writeText(root, path, `${markdown.replace(/\n*$/, "")}\n\n${replacement}\n`);
      return { ok: true, path, changed: true };
    }
    const find = String(args.find);
    const count = markdown.split(find).length - 1;
    if (count === 0) return { ok: false, reason: "The text to replace is not in the document. Read the document again and copy the text exactly." };
    if (count > 1) return { ok: false, reason: `The text to replace occurs ${count} times. Include more of the text around it so it occurs once.` };
    await writeText(root, path, markdown.replace(find, () => replacement));
    return { ok: true, path, changed: find !== replacement };
  },
  async documentCreate(root, args) {
    const path = String(args.path);
    if ((await readText(root, path)) !== undefined) return { ok: false, reason: `${path} already exists. Edit it instead.` };
    await writeText(root, path, String(args.markdown ?? ""));
    return { ok: true, path };
  },
  async fileWrite(root, args) {
    const files = args.files as { path: string; contentBase64: string }[];
    for (const file of files) await writeText(root, file.path, Buffer.from(file.contentBase64, "base64"));
    return { ok: true, written: files.map((file) => file.path) };
  },
};

export function fakeDesktop(input: {
  root: string;
  answers: Readonly<Record<string, DesktopAnswer>>;
  /** Receives one line per request the case does not answer. */
  unansweredLog: string;
}): DesktopRequest {
  return async (request) => {
    const args = request.args as Args;
    if (Object.hasOwn(input.answers, request.verb)) {
      const answer = input.answers[request.verb];
      return typeof answer === "function" ? (answer as (args: Args, root: string) => unknown)(args, input.root) : answer;
    }
    const workspaceVerb = workspaceVerbs[request.verb];
    if (workspaceVerb) return workspaceVerb(input.root, args);
    await appendFile(input.unansweredLog, `${request.verb}\n`);
    throw new Error(`eval: the case lists no answer for the ${request.verb} request`);
  };
}
