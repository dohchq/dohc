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
  const fault = r.currentPath;
  if (fault === 'crash') return process.exit(17);
  if (fault === 'hang') return;
  if (fault === 'stderr') process.stderr.write(Buffer.alloc(100000, 120));
  if (fault === 'malformed') return process.stdout.write(Buffer.alloc(12));
  if (fault === 'oversize') {const h = frame(1, 0, Buffer.alloc(0)); h.writeUInt32LE(65537, 8); return process.stdout.write(h);}
  if (fault === 'refused') return control({id:r.id, kind:'refused', reason:'invalid-source'});
  const delta = Buffer.from([0, 0]);
  const response = {id: r.id, kind:r.method === 'construct' ? 'constructed' : 'proved',
    sourceSha256:r.source.sha256, sourceByteLength:r.source.length,
    projectionSha256:hash('projection'), stateSha256:hash('state'),
    delta:{length:r.method === 'construct' ? 2 : 0, sha256:hash(r.method === 'construct' ? delta : Buffer.alloc(0))}};
  if (fault === 'sha') response.sourceSha256 = hash('wrong');
  if (fault === 'length') response.sourceByteLength++;
  if (fault === 'obsolete-flag') response.strictJournal = true;
  if (fault === 'id') response.id++;
  if (fault === 'kind') response.kind = 'proved';
  if (fault === 'extra') response.extra = true;
  if (fault === 'delta') response.delta.sha256 = hash('wrong');
  if (fault === 'declaration') response.delta.length = 20 * 1024 * 1024 + 1;
  control(response);
  if (fault === 'eof-delta') return eof();
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(3n);
  if (fault === 'truncated-delta') return eof(frame(2, 1, Buffer.concat([prefix, delta])).subarray(0, 21));
  process.stdout.write(frame(2, 1, Buffer.concat([prefix, r.method === 'construct' ? delta : Buffer.alloc(0)])));
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
      if (mode === 'startup-hang') continue;
      if (mode === 'startup-crash') process.exit(18);
      const runtime = {...manifest.runtime}; delete runtime.sha256;
      if (mode === 'hello') runtime.icu = 'wrong';
      const hello = {id:1, kind:'hello', protocolVersion:1, schemaVersion:1, runtime};
      if (mode.startsWith('runtime-')) runtime[mode.slice(8)] = 'wrong';
      if (mode === 'protocol') hello.protocolVersion++;
      if (mode === 'schema') hello.schemaVersion++;
      if (mode === 'embedded-identity') hello.identity = manifest;
      control(hello);
    } else if (r.end) answer(request);
    else request = r;
  }
});
process.stdin.on('end', () => process.exit(0));
