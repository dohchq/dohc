import { describe, expect, it } from 'vitest';
import { mergeSyncEdits } from './sync-demo.js';

describe('sync demo edits', () => {
  it('keeps newlines, repeated sentences, and double spaces in concurrent appends', () => {
    const base = 'A  heading\nSame. Same.\n';
    expect(mergeSyncEdits(base, `${base}\nLeft.  Left.\n`, `${base}Right.\nRight.  `))
      .toBe(`${base}\nLeft.  Left.\nRight.\nRight.  `);
  });

  it('applies disjoint replacements without reformatting untouched text', () => {
    const base = 'one\n\ntwo  three\nfour';
    expect(mergeSyncEdits(base, 'ONE\n\ntwo  three\nfour', 'one\n\ntwo  three\nFOUR'))
      .toBe('ONE\n\ntwo  three\nFOUR');
  });

  it('combines deletion with a disjoint insertion', () => {
    expect(mergeSyncEdits('abc\ndef', 'a\ndef', 'abc\ndef\n  next'))
      .toBe('a\ndef\n  next');
  });

  it('combines overlapping deletions and preserves both overlapping insertions', () => {
    expect(mergeSyncEdits('abcdef', 'adef', 'abef')).toBe('aef');
    expect(mergeSyncEdits('abcdef', 'aLEFTef', 'abRIGHTf')).toBe('aLEFTRIGHTf');
    expect(mergeSyncEdits('abcdef', 'abRIGHTf', 'aLEFTef')).toBe('aRIGHTLEFTf');
  });

  it('does not duplicate identical edits or resurrect a one-sided deletion', () => {
    expect(mergeSyncEdits('Same. Same.', 'Same.', 'Same.')).toBe('Same.');
    expect(mergeSyncEdits('Same. Same.', 'Same. Same.', 'Same.')).toBe('Same.');
  });

  it('keeps every separate concurrent appended sentence, even when repeated', () => {
    const base = 'Start.';
    expect(mergeSyncEdits(base, `${base} Again. Again.`, `${base} Again. Again. Again.`))
      .toBe(`${base} Again. Again. Again. Again. Again.`);
  });

  it('keeps overlapping emoji edits as whole characters', () => {
    expect(mergeSyncEdits('Mood: 😀', 'Mood: 😃', 'Mood: 😄')).toBe('Mood: 😃😄');
  });
});
