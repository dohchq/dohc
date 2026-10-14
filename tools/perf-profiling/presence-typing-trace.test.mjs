import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { measureTypingTrace, startTypingTrace, typingTraceMark, TYPING_TRACE_CATEGORIES } from './presence-typing-trace.mjs';

function fixture(durations = [7.123, 21.234]) {
  const events = [], samples = [], keys = [], reported = [];
  durations.forEach((duration, index) => {
    const start = 100 + index * 80, generated = start + 1;
    const base = { pid: 12, tid: 4, cat: 'cc,benchmark,input,input.scrolling', id2: { local: '0x6' } };
    const async = (name, ph, ts, args = {}) => ({ ...base, name, ph, ts, args });
    events.push({ pid: 12, name: typingTraceMark(index, 'before'), ts: start * 1000, args: { data: { startTime: start } } },
      async('EventLatency', 'b', generated * 1000, { event_latency: { event_type: 'KEY_PRESSED', display_trace_id: 10 } }),
      async('SubmitCompositorFrameToPresentationCompositorFrame', 'b', (generated + 1) * 1000),
      async('SubmitCompositorFrameToPresentationCompositorFrame', 'e', (generated + duration) * 1000),
      async('EventLatency', 'e', (generated + duration) * 1000),
      { pid: 12, name: typingTraceMark(index, 'after'), ts: (start + 60) * 1000 });
    samples.push({ index, start: start + .01, end: start + 60.01 });
    keys.push({ timestamp: generated + .1, eventTimestamp: generated, trusted: true, key: 'x' });
    if (duration >= 16) reported.push({ name: 'keydown', startTime: generated, duration: Math.round(duration / 8) * 8, interactionId: index + 1 });
  });
  return { events, samples, timing: { keys, events: reported } };
}
const measure = data => measureTypingTrace(data.events, data.samples, data.timing);

test('trace measures uncensored keys and reuses async track ids without joining different inputs', () => {
  const result = measure(fixture());
  assert.equal(result.validation.pass, true);
  assert.deepEqual(result.samples.map(sample => sample.inputToNextPaintMs), [7.123, 21.234]);
  assert.equal(result.validation.matchedKeys, 2);
  assert.equal(result.validation.eventTimingChecked, 1);
  assert.equal(result.validation.agreement, 'pass');
  assert.equal(result.samples[0].eventTimingMs, null);
});

test('a trace with a missing keystroke refuses the run', () => {
  const data = fixture();
  data.events = data.events.filter(event => !(event.name === 'EventLatency' && event.ts > 180000));
  const result = measure(data);
  assert.equal(result.validation.pass, false);
  assert.equal(result.validation.matchedKeys, 1);
  assert.equal(result.samples[1].inputToNextPaintMs, null);
  assert.match(result.validation.problems.join(' '), /expected one EventLatency match/);
});

test('an incomplete or unpresented EventLatency refuses the run', () => {
  for (const alter of [
    data => data.events = data.events.filter(event => !(event.name === 'EventLatency' && event.ph === 'e')),
    data => delete data.events.find(event => event.name === 'EventLatency' && event.ph === 'b').args.event_latency.display_trace_id,
    data => data.events = data.events.filter(event => !event.name.startsWith('SubmitCompositorFrame')),
  ]) {
    const data = fixture([20]); alter(data);
    assert.equal(measure(data).validation.pass, false);
  }
});

test('another renderer is excluded and ambiguous keys in this renderer refuse the run', () => {
  const data = fixture([20]);
  const copy = data.events.filter(event => event.name === 'EventLatency' || event.name.startsWith('SubmitCompositorFrame'));
  data.events.push(...copy.map(event => ({ ...event, pid: 99 })));
  assert.equal(measure(data).validation.pass, true);
  data.events.push(...copy.map(event => ({ ...event, id2: { local: '0x7' } })));
  assert.equal(measure(data).validation.pass, false);
});

test('reported Event Timing allows four milliseconds of rounding plus one millisecond', () => {
  const boundary = fixture([19]); boundary.timing.events[0].duration = 24;
  const at = measure(boundary);
  assert.equal(at.validation.pass, true);
  assert.equal(at.validation.toleranceMs, 5);
  assert.equal(at.validation.maxDeltaMs, 5);
  assert.equal(at.validation.eventTimingChecked, 1);
  const data = fixture([18.999]); data.timing.events[0].duration = 24;
  assert.equal(measure(data).validation.pass, false);
  assert.match(measure(data).validation.problems.join(' '), /beyond rounding/);
});

test('no reported Event Timing entries does not censor fast trace samples', () => {
  const result = measure(fixture([3.125, 8.001]));
  assert.equal(result.validation.pass, true);
  assert.equal(result.validation.agreement, 'unreported');
  assert.equal(result.validation.eventTimingChecked, 0);
});

test('untrusted input, wrong timestamps, and absent markers refuse the run', () => {
  for (const alter of [
    data => data.timing.keys[0].trusted = false,
    data => data.timing.keys[0].eventTimestamp += 3,
    data => data.timing.keys.push({ ...data.timing.keys[0] }),
    data => data.events = data.events.filter(event => event.name !== typingTraceMark(0, 'before')),
  ]) {
    const data = fixture(); alter(data);
    assert.equal(measure(data).validation.pass, false);
  }
});

test('CDP collection streams trace JSON and closes the stream and session once', async () => {
  const session = new EventEmitter(), calls = [];
  session.send = async (method, options) => {
    calls.push([method, options]);
    if (method === 'Browser.getVersion') return { product: 'Chrome/test' };
    if (method === 'Tracing.end') session.emit('Tracing.tracingComplete', { stream: 'owned' });
    if (method === 'IO.read') return { data: Buffer.from('{"traceEvents":[]}').toString('base64'), base64Encoded: true, eof: true };
  };
  session.detach = async () => calls.push(['detach']);
  const trace = await startTypingTrace({ context: () => ({ newCDPSession: async () => session }) });
  assert.equal(calls.find(([method]) => method === 'Tracing.start')[1].categories, TYPING_TRACE_CATEGORIES);
  const result = await trace.stop();
  assert.deepEqual(result.events, []);
  assert.equal(result.browser.product, 'Chrome/test');
  assert.equal(await trace.stop(), result);
  assert.equal(calls.filter(([method]) => method === 'Tracing.end').length, 1);
  assert.equal(calls.filter(([method]) => method === 'IO.close').length, 1);
  assert.equal(calls.filter(([method]) => method === 'detach').length, 1);
});

test('a lost trace fails and detaches instead of manufacturing measurements', async () => {
  const session = new EventEmitter(); let detached = false, closed = false;
  session.send = async method => {
    if (method === 'Tracing.end') session.emit('Tracing.tracingComplete', { stream: 'owned', dataLossOccurred: true });
    if (method === 'IO.close') closed = true;
  };
  session.detach = async () => { detached = true; };
  const trace = await startTypingTrace({ context: () => ({ newCDPSession: async () => session }) });
  await assert.rejects(trace.stop(), /incomplete or lost/);
  assert.equal(closed, true); assert.equal(detached, true);
});
