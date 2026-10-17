import {createHash} from 'node:crypto';
import {expect, it} from 'vitest';
import * as Y from 'yjs';
import {markdownToYDoc, yDocToMarkdown} from '@dohc/ydoc-projection';
import {durableMarkdownFromSnapshot, markdownFromSnapshot, restoreRecoveryDraftText} from './recoverySnapshot';

it('projects deletion snapshots and unrefined recovery copies to the witnessed file bytes', async () => {
  const source = '---\nzebra: last\ntitle: "Outside"\nalpha: first\n---\n\n- one\n- two\n\n';
  const doc = markdownToYDoc(source);
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  doc.getMap('meta').set('dohcMarkdownSource', source);
  doc.getMap('meta').set('dohcMarkdownSourceSha256', sha(source));
  doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', sha(yDocToMarkdown(doc)));
  const snapshot = Y.encodeStateAsUpdate(doc);
  const unrefined = durableMarkdownFromSnapshot(doc, snapshot);
  doc.destroy();
  expect(await markdownFromSnapshot(snapshot)).toBe(source);
  expect(await restoreRecoveryDraftText(unrefined)).toBe(source);
});
