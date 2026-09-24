// Seeds one #general post and its replies through the checkout CLI. The harness runs this
// script through scripts/verification/process.mjs, so it lives inside a Windows job object
// (KILL_ON_JOB_CLOSE) or a detached POSIX process group. Every CLI launcher and worker it
// starts stops with that job or group, including a worker whose launcher exited abnormally.
// cwd selects the workspace and DOHC_STATE_DIR names the app profile; both come from the
// harness. Prints one JSON progress line per 50 messages and a final JSON result line.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const [launcher, title, count] = process.argv.slice(2);
const messages = Number(count);
if (!launcher || !title || !Number.isSafeInteger(messages) || messages < 2) {
  console.error('usage: node seed-chat-cli.mjs <dohc.js launcher> <title> <messages, at least 2>');
  process.exit(2);
}
const exec = promisify(execFile);
// execFile settles after both pipes close, so stdout is complete before it is parsed.
const dohc = async args => (await exec(process.execPath, [launcher, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout;
try {
  const started = performance.now();
  const posted = JSON.parse(await dohc(['--json', 'chat', 'post', 'general', '--title', title, 'Message 0']));
  if (typeof posted.threadId !== 'string') throw Error(`CLI post returned no thread id: ${JSON.stringify(posted)}`);
  for (let n = 1; n < messages; n++) {
    await dohc(['chat', 'reply', posted.threadId, `Message ${n}`]);
    if (n % 50 === 0) console.log(JSON.stringify({ phase: 'chat-seed', messages: n + 1 }));
  }
  // cliThreadId is the CLI's th_ handle, not the engine id the DOM carries.
  console.log(JSON.stringify({ channel: 'general', title, cliThreadId: posted.threadId, messages, seedingObservedMs: performance.now() - started }));
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
}
