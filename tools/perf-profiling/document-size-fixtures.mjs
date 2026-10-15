import { createHash } from 'node:crypto';

export const MiB = 1024 * 1024;
export const DOCUMENT_SIZES = [2, 5, 8, 10];
export const DOCUMENT_SHAPES = ['plain', 'formatted', 'plain-retained', 'formatted-retained'];
export const STATE_MAX_BYTES = 20 * MiB;
export const PILOT_PAIRS = 3;
export function pairsForCase(options, item) {
  if (options.documentMode === 'pilot') return options.runCount;
  if (options.label === 'baseline') return item.mib === 2 && item.shape === 'formatted-retained' ? 20 : 3;
  return item.shape === 'formatted-retained' ? (item.mib === 2 ? 10 : 20) : PILOT_PAIRS;
}
export const OPEN_BUDGETS = {
  2: { firstContent: [487, 532], editReady: [750, 1000] },
  5: { firstContent: [750, 1000], editReady: [1250, 1500] },
  8: { firstContent: [1000, 1250], editReady: [1750, 2000] },
  10: { firstContent: [1250, 1500], editReady: [2250, 2500] },
};
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Long paragraphs exercise bytes without first exhausting the independent node limit.
export function documentFixture(mib, shape, { structural = false } = {}) {
  if (!DOCUMENT_SIZES.includes(mib) || !DOCUMENT_SHAPES.includes(shape)) throw Error('Unknown document-size fixture');
  const retained = shape.endsWith('-retained'),
    formatted = shape.startsWith('formatted');
  const bytes = mib * MiB,
    title = 'Document size ' + mib + ' MiB ' + shape;
  const header = retained ? "---\n# retained source\ntitle: '" + title + "'\n---\n\n" : '# ' + title + '\n\n';
  const phrase = 'Measured text café 日本語 مرحبا. ';
  const pad = (text, end = '\n\n') => text + 's'.repeat(120 - Buffer.byteLength(text + end)) + end;
  const paragraph = structural
    ? [pad(phrase), pad('- ' + phrase), pad('| Column |\n| --- |\n| ' + phrase, ' |\n\n')].join('')
    : (formatted ? '**Formatted span** ' : '') + phrase.repeat(24) + '\n\n';
  const count = Math.floor((bytes - Buffer.byteLength(header) - 2) / Buffer.byteLength(paragraph));
  const prefix = header + paragraph.repeat(count);
  const text = prefix + 'z'.repeat(bytes - Buffer.byteLength(prefix) - 1) + '\n';
  if (Buffer.byteLength(text) !== bytes) throw Error('Fixture size drift');
  return {
    mib,
    shape,
    structural,
    title,
    text,
    bytes,
    sha256: sha256(text),
    paragraphs: count + 1,
    paragraphBytes: structural ? 120 : Buffer.byteLength(paragraph),
    patternBytes: Buffer.byteLength(paragraph),
    retained,
    formatted,
  };
}

export function documentControlFiles() {
  const targets = Array.from({ length: 500 }, (_, n) => ({
    name: 'linked/target-' + n + '.md',
    text: '# Linked target ' + n + '\n',
  }));
  const paragraphs = Array.from(
    { length: 5000 },
    (_, n) =>
      'Paragraph ' +
      n +
      '. Performance text.' +
      (n % 10 === 0 ? ' [Link ' + n / 10 + '](' + targets[n / 10].name + ')' : ''),
  );
  return [{ name: 'links.md', text: '# Workspace 0 large links\n\n' + paragraphs.join('\n\n') + '\n' }, ...targets];
}

export function documentMatrix(options) {
  return options.documentMiB.flatMap((mib) =>
    DOCUMENT_SHAPES.map((shape) => ({
      mib,
      shape,
      key: mib + '/' + shape,
      plannedPairs: pairsForCase(options, { mib, shape }),
    })),
  );
}

export function restoreReservation(
  payloadBytes,
  { maxEvents, headerBytes, reserveBytes, relayAggregateBytes, nativeAggregateBytes },
) {
  // Supported 64-bit targets: ceil(2*sizeof(String)/3)+4 = 20.
  const relayBytes = 16 * payloadBytes + reserveBytes;
  const nativeBytes = 20 * payloadBytes + 4 * maxEvents * headerBytes + reserveBytes + 128 * 1024;
  return {
    payloadBytes,
    relayBytes,
    nativeBytes,
    relayAggregateBytes,
    nativeAggregateBytes,
    fitsCurrentRelay: relayBytes <= relayAggregateBytes,
    fitsNative: nativeBytes <= nativeAggregateBytes,
  };
}

export function runtimeEstimate() {
  return {
    minimumHours: 4.75,
    bookedHours: 6,
    fallbackHours: 5.75,
    basis:
      '106 lean GUI pairs at 65 s (115 min), one control block (5 min), independent relay/fixture work (90 min), one 60 min soak, 15 min extensions/setup = 285 min. A fallback soak adds 60 min. Baseline: 65 lean/refusal pairs plus 2 MiB relay and soak, about 3 h. Hard deadline 360 min; unfinished receipts are inconclusive.',
  };
}
