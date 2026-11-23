const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function rotl(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

function sha1(input: Uint8Array): Uint8Array {
  const bitLength = input.byteLength * 8;
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(input);
  buffer[input.byteLength] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getInt32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, h0, false);
  outView.setInt32(4, h1, false);
  outView.setInt32(8, h2, false);
  outView.setInt32(12, h3, false);
  outView.setInt32(16, h4, false);
  return out;
}

/** Deterministic RFC 4122 UUIDv5 (SHA-1) implemented in pure TypeScript for Node and browser callers. */
export function uuidv5(namespaceUuid: string, name: string): string {
  if (!UUID_PATTERN.test(namespaceUuid)) throw new Error("Invalid UUID namespace.");
  const hex = namespaceUuid.replaceAll("-", "");
  const nameBytes = encoder.encode(name);
  const input = new Uint8Array(16 + nameBytes.byteLength);
  for (let i = 0; i < 16; i += 1) {
    input[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  input.set(nameBytes, 16);
  const hash = sha1(input);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    parts.push(hash[i]!.toString(16).padStart(2, "0"));
  }
  return `${parts.slice(0, 4).join("")}-${parts.slice(4, 6).join("")}-${parts.slice(6, 8).join("")}-${parts.slice(8, 10).join("")}-${parts.slice(10, 16).join("")}`;
}
