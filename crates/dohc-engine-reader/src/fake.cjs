// Test-only misbehaving child. No code from this file ships in the reader.
const {createHash} = require('node:crypto');
const hash = b => createHash('sha256').update(b).digest('hex');
const manifest = MANIFEST;
const mode = MODE;
let bytes = Buffer.alloc(0), request;
function frame(type, flags, data) {
  const h = Buffer.alloc(12); h.write('DOP1'); h[4] = type; h[5] = flags; h.writeUInt32LE(data.length, 8);
  return Buffer.concat([h, data]);
}
const control = o => process.stdout.write(frame(1, 0, Buffer.from(JSON.stringify(o))));
const eof = bytes => process.stdout.end(bytes, () => process.exit(0));
function answer(r) {
  if (r.method === 'check-markdown-witness') {
    const keys = Object.keys(r).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['id', 'method', 'projectionSha256', 'source', 'sourceSha256'].sort())) process.exit(20);
    if (mode === 'witness-over-cap') {
      const header = frame(1, 0, Buffer.alloc(0)); header.writeUInt32LE(65537, 8);
      return process.stdout.write(header);
    }
    return control({id: r.id, kind: 'witness-checked',
      sourceSha256: mode === 'witness-source-mismatch' ? hash('wrong') : r.sourceSha256,
      projectionSha256: mode === 'witness-projection-mismatch' ? hash('wrong') : r.projectionSha256,
      keepsMeaning: mode !== 'witness-unsafe'});
  }
  const fault = r.currentPath;
  if (fault === 'crash') return process.exit(17);
  if (fault === 'hang') return;
  if (fault === 'memory') {const allocations = []; for (let i = 0; i < 40; i++) allocations.push(Buffer.alloc(16 * 1024 * 1024, 1));}
  if (fault === 'stderr') process.stderr.write(Buffer.alloc(100000, 120));
  if (fault === 'malformed') return process.stdout.write(Buffer.alloc(12));
  if (fault === 'oversize') {const h = frame(1, 0, Buffer.alloc(0)); h.writeUInt32LE(65537, 8); return process.stdout.write(h);}
  if (fault.startsWith('refused')) return control({id:r.id + Number(fault === 'refused-id'), kind:'refused', reason:fault === 'refused-reason' ? 'unknown-reason' : 'invalid-source'});
  const delta = fault === 'declaration' ? Buffer.alloc(20 * 1024 * 1024 + 1) : Buffer.from([0, 0]);
  const output = r.method === 'construct' || fault === 'prove-delta' ? delta : Buffer.alloc(0);
  const response = {id: r.id, kind:r.method === 'construct' ? 'constructed' : 'proved',
    sourceSha256:r.source.sha256, sourceByteLength:r.source.length,
    projectionSha256:hash('projection'), stateSha256:hash('state'),
    delta:{length:output.length, sha256:hash(output)}};
  if (fault.startsWith('expired')) response.kind = 'expired';
  if (fault === 'expired-delta') response.delta.length = 2;
  if (fault === 'sha') response.sourceSha256 = hash('wrong');
  if (fault === 'length') response.sourceByteLength++;
  if (fault === 'obsolete-flag') response.strictJournal = true;
  if (fault === 'id') response.id++;
  if (fault === 'kind') response.kind = 'proved';
  if (fault === 'extra') response.extra = true;
  if (fault === 'delta') response.delta.sha256 = hash('wrong');
  if (fault === 'projection-sha') response.projectionSha256 = 'g'.repeat(64);
  if (fault === 'state-sha') response.stateSha256 = 'short';
  control(response);
  if (fault === 'eof-delta') return eof();
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(3n);
  if (fault === 'truncated-delta') return eof(frame(2, 1, Buffer.concat([prefix, delta])).subarray(0, 21));
  for (let offset = 0; offset < Math.max(1, output.length); offset += 65536) {
    process.stdout.write(frame(2, Number(offset + 65536 >= output.length), Buffer.concat([prefix, output.subarray(offset, offset + 65536)])));
  }
  if (fault === 'eof-end') return eof();
  if (fault === 'truncated-end') return eof(frame(1, 0, Buffer.from(JSON.stringify({id:r.id,end:true}))).subarray(0, 16));
  if (fault === 'end-id') return control({id:r.id + 1, end:true});
  control({id:r.id, end:true});
}
process.stdin.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  while (bytes.length >= 12 && bytes.length >= 12 + bytes.readUInt32LE(8)) {
    const type = bytes[4], n = bytes.readUInt32LE(8), payload = bytes.subarray(12, 12+n);
    bytes = bytes.subarray(12+n);
    if (type !== 1) continue;
    const r = JSON.parse(payload);
    if (r.method === 'hello') {
      const expected = ['--permission', '--allow-fs-read=' + __filename, '--max-old-space-size=256'];
      const env = Object.keys(process.env);
      // Windows receives SystemRoot. On macOS, CoreFoundation sets this variable inside Node itself.
      const allowed = {win32: ['SystemRoot'], darwin: ['__CF_USER_TEXT_ENCODING']}[process.platform] ?? [];
      if (JSON.stringify(process.execArgv) !== JSON.stringify(expected)
        || JSON.stringify(env.sort()) !== JSON.stringify(allowed)
        || !process.permission || process.permission.has('fs.write') || process.permission.has('child')
        || process.cwd() === manifest.parentCwd) process.exit(19);
      if (mode === 'startup-hang') continue;
      if (mode === 'startup-crash') process.exit(18);
      const runtime = {...manifest.runtime}; delete runtime.sha256;
      if (mode === 'hello') runtime.icu = 'wrong';
      const hello = {id:1, kind:'hello', protocolVersion:1, schemaVersion:1, runtime};
      if (['version','platform','arch','unicode','icu'].some(key => mode === 'runtime-' + key)) runtime[mode.slice(8)] = 'wrong';
      if (mode === 'protocol') hello.protocolVersion++;
      if (mode === 'schema') hello.schemaVersion++;
      if (mode === 'embedded-identity') hello.identity = manifest;
      control(hello);
    } else if (r.end) answer(request);
    else request = r;
  }
});
process.stdin.on('end', () => {if (mode === 'ignore-eof') setInterval(() => {}, 1000); else process.exit(0)});
