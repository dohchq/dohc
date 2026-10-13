// Local stand-in for the Worker's state.trial outbound handler, for testing
// cell.mjs save and restore without Cloudflare. Keeps parts in memory.
// Usage: node fake-state.mjs (listens on port 80 inside a container named state.trial).
import { createServer } from 'node:http';

const parts = new Map();
let saved = { generation: 0, parts: 0, bytes: 0, relayStamp: 0, saveMs: 0 };
const body = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks); };

createServer(async (request, response) => {
  const [, kind, generation, index] = new URL(request.url, 'http://state.trial').pathname.split('/');
  console.log(request.method, request.url);
  if (kind === 'generation') return response.end(JSON.stringify(saved));
  if (kind === 'parts' && request.method === 'PUT') { parts.set(`${generation}/${index}`, await body(request)); response.statusCode = 204; return response.end(); }
  if (kind === 'parts') { const part = parts.get(`${generation}/${index}`); response.statusCode = part ? 200 : 404; return response.end(part); }
  if (kind === 'commit') {
    const next = { ...JSON.parse(await body(request)), generation: Number(generation) };
    if (next.generation !== saved.generation + 1) { response.statusCode = 409; return response.end(); }
    saved = next; console.log('commit', JSON.stringify(saved)); response.statusCode = 204; return response.end();
  }
  if (kind === 'probe') { await body(request); response.statusCode = 204; return response.end(); }
  response.statusCode = 404; response.end();
}).listen(80);
