// Trusted relay: the owner supplies admission only after assigning the job.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

let child;
try {
  const iterator = process.stdin[Symbol.asyncIterator]();
  let header = Buffer.alloc(0), end = -1;
  while (end === -1) {
    const next = await iterator.next();
    if (next.done) throw new Error('Missing compiler job admission.');
    header = Buffer.concat([header, next.value]);
    end = header.indexOf(10);
  }
  const { worker, args } = JSON.parse(header.subarray(0, end).toString('utf8'));
  child = spawn(process.execPath, [worker, ...args], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  const transfer = pipeline(Readable.from((async function* () {
    if (header.length > end + 1) yield header.subarray(end + 1);
    for (;;) { const next = await iterator.next();if (next.done) return;yield next.value; }
  })()), child.stdin).catch(error => error);
  const [code] = await closed;
  const inputError = await transfer;
  process.exitCode = code ?? 1;
  if (inputError && !['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(inputError.code)) {
    console.error(inputError.message);process.exitCode = 1;
  }
} catch (error) {console.error(error.message);process.exitCode = 1;child?.kill();}
