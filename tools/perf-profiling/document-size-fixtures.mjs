import { createHash } from 'node:crypto';

export const MiB = 1024 * 1024;
export const DOCUMENT_SIZES = [2, 5, 8, 10];
export const DOCUMENT_SHAPES = ['plain', 'formatted', 'plain-retained', 'formatted-retained'];
export const STATE_MAX_BYTES = 20 * MiB;
export const MIN_GATE_RUNS = 40;
export const OPEN_BUDGETS = {
  2: { firstContent: [487, 532], editReady: [750, 1000] },
  5: { firstContent: [750, 1000], editReady: [1250, 1500] },
  8: { firstContent: [1000, 1250], editReady: [1750, 2000] },
  10: { firstContent: [1250, 1500], editReady: [2250, 2500] },
};
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// Long paragraphs exercise bytes without first exhausting the independent node limit.
export function documentFixture(mib, shape, { structural = false } = {}) {
  if (!DOCUMENT_SIZES.includes(mib) || !DOCUMENT_SHAPES.includes(shape)) throw Error('Unknown document-size fixture');
  const retained = shape.endsWith('-retained'), formatted = shape.startsWith('formatted');
  const bytes = mib * MiB, title = 'Document size ' + mib + ' MiB ' + shape;
  const header = retained ? "---\n# retained source\ntitle: '" + title + "'\n---\n\n" : '# ' + title + '\n\n';
  const phrase = 'Measured text café 日本語 مرحبا. ';
  const pad = (text, end = '\n\n') => text + 's'.repeat(120 - Buffer.byteLength(text + end)) + end;
  const paragraph = structural ? [pad(phrase), pad('- ' + phrase), pad('| Column |\n| --- |\n| ' + phrase, ' |\n\n')].join('')
    : (formatted ? '**Formatted span** ' : '') + phrase.repeat(24) + '\n\n';
  const count = Math.floor((bytes - Buffer.byteLength(header) - 2) / Buffer.byteLength(paragraph));
  const prefix = header + paragraph.repeat(count);
  const text = prefix + 'z'.repeat(bytes - Buffer.byteLength(prefix) - 1) + '\n';
  if (Buffer.byteLength(text) !== bytes) throw Error('Fixture size drift');
  return { mib, shape, structural, title, text, bytes, sha256: sha256(text), paragraphs: count + 1,
    paragraphBytes: structural ? 120 : Buffer.byteLength(paragraph), patternBytes: Buffer.byteLength(paragraph), retained, formatted };
}

export function documentMatrix(options) {
  return options.documentMiB.flatMap(mib => DOCUMENT_SHAPES.map(shape => ({ mib, shape, key: mib + '/' + shape })));
}

export function restoreReservation(payloadBytes, { maxEvents = 64, headerBytes = 643_576, reserveBytes = 8 * MiB } = {}) {
  // Supported 64-bit targets: ceil(2*sizeof(String)/3)+4 = 20.
  const relayBytes = 16 * payloadBytes + reserveBytes;
  const nativeBytes = 20 * payloadBytes + 4 * maxEvents * headerBytes + reserveBytes + 128 * 1024;
  return { payloadBytes, relayBytes, nativeBytes, relayAggregateBytes: 40 * MiB, nativeAggregateBytes: 512 * MiB,
    fitsCurrentRelay: relayBytes <= 40 * MiB, fitsNative: nativeBytes <= 512 * MiB };
}

export function runtimeEstimate() {
  return { minimumHours: 48, bookedHours: 72,
    basis: '4 sizes × 4 shapes × 40 fresh/restart pairs; 1/2/4 separate and shared relay sessions; 100000-edit churn; sixteen 60-minute soaks. Refusals shorten the run; timeouts extend it.' };
}
