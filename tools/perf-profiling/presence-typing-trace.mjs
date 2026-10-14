// EventLatency is emitted by Chromium cc/metrics/event_latency_tracing_recorder.cc.
// Its presented slice runs from kGenerated to presentation, in trace-clock microseconds.
export const TYPING_TRACE_CATEGORIES = 'input,blink.user_timing';
export const EVENT_TIMING_TOLERANCE_MS = 5;
export const typingTraceMark = (index, side) => `dohc-presence-key-${index}-${side}`;

// Frame completion allows compositor work to advance; the completed trace still
// decides whether the last key reached presentation.
export async function stopTypingTraceAfterFrames(page, trace) {
  const completed = await page.waitForFunction(() => new Promise(resolve => {
    let frames = 0;
    const next = () => {
      if (++frames === 3) resolve(true);
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }), null, { timeout: 1_000 });
  await completed.dispose();
  return trace.stop();
}

export async function startTypingTrace(page) {
  const session = await page.context().newCDPSession(page);
  let browser;
  try {
    browser = await session.send('Browser.getVersion');
    await session.send('Tracing.start', { categories: TYPING_TRACE_CATEGORIES,
      options: 'record-as-much-as-possible', transferMode: 'ReturnAsStream', streamFormat: 'json' });
  } catch (error) { await session.detach(); throw error; }
  let result;
  return { stop() {
    result ??= (async () => {
      let timer, complete, handle;
      try {
        const completed = new Promise((resolve, reject) => {
          complete = resolve;
          session.once('Tracing.tracingComplete', complete);
          timer = setTimeout(() => reject(new Error('Typing trace did not finish within 120 seconds')), 120_000);
        });
        // Attach rejection handling before sending the stop request.
        void completed.catch(() => {});
        await session.send('Tracing.end');
        const receipt = await completed;
        handle = receipt.stream;
        if (!handle || receipt.dataLossOccurred) throw new Error('Typing trace is incomplete or lost events');
        const chunks = [];
        for (;;) {
          const chunk = await session.send('IO.read', { handle });
          chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
          if (chunk.eof) break;
        }
        const raw = Buffer.concat(chunks).toString('utf8'), trace = JSON.parse(raw);
        if (!Array.isArray(trace.traceEvents)) throw new Error('Typing trace has no event array');
        return { raw, events: trace.traceEvents, browser, categories: TYPING_TRACE_CATEGORIES };
      } finally {
        clearTimeout(timer);
        session.off('Tracing.tracingComplete', complete);
        try { if (handle) await session.send('IO.close', { handle }); }
        finally { await session.detach(); }
      }
    })();
    return result;
  } };
}

const trackKey = event => event.id2?.global !== undefined
  ? JSON.stringify(['global', event.cat, event.id2.global])
  : JSON.stringify([event.pid, event.cat, event.id2?.local ?? event.id ?? event.tid]);

function latencySlices(events) {
  const pending = new Map(), slices = [];
  const names = new Set(['EventLatency', 'SubmitCompositorFrameToPresentationCompositorFrame']);
  for (const event of [...events].sort((a, b) => a.ts - b.ts)) {
    if (!names.has(event.name)) continue;
    if (event.ph === 'X' && Number.isFinite(event.dur)) {
      slices.push({ begin: event, end: event.ts + event.dur, track: trackKey(event) });
      continue;
    }
    const key = JSON.stringify([trackKey(event), event.name]);
    if (event.ph === 'b' || event.ph === 'B') {
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push(event);
    } else if (event.ph === 'e' || event.ph === 'E') {
      const begin = pending.get(key)?.pop();
      if (begin) slices.push({ begin, end: event.ts, track: trackKey(begin) });
    }
  }
  return slices;
}

export function measureTypingTrace(events, samples, timing) {
  const slices = latencySlices(events);
  const keys = slices.filter(slice => slice.begin.name === 'EventLatency' && slice.begin.args?.event_latency?.event_type === 'KEY_PRESSED');
  const presentation = slices.filter(slice => slice.begin.name === 'SubmitCompositorFrameToPresentationCompositorFrame');
  const problems = [], agreements = [];
  let matchedKeys = 0;
  const measured = samples.map(sample => {
    const marks = side => events.filter(event => event.name === typingTraceMark(sample.index, side));
    const before = marks('before'), after = marks('after');
    const trustedKeys = timing.keys.filter(key => key.timestamp >= sample.start && key.timestamp <= sample.end);
    const result = { ...sample, inputToNextPaintMs: null, eventTimingMs: null, trace: null };
    if (before.length !== 1 || after.length !== 1 || before[0].pid !== after[0].pid || after[0].ts <= before[0].ts) {
      problems.push(`Key ${sample.index}: missing or ambiguous trace markers`); return result;
    }
    if (trustedKeys.length !== 1 || !trustedKeys[0].trusted || trustedKeys[0].key !== 'x') {
      problems.push(`Key ${sample.index}: missing or untrusted keydown`); return result;
    }
    const matches = keys.filter(slice => slice.begin.pid === before[0].pid && slice.begin.ts >= before[0].ts && slice.begin.ts <= after[0].ts);
    if (matches.length !== 1) { problems.push(`Key ${sample.index}: expected one EventLatency match, found ${matches.length}`); return result; }
    const slice = matches[0], begin = slice.begin;
    const presented = begin.args.event_latency.display_trace_id !== undefined && presentation.some(part => part.track === slice.track && part.begin.ts >= begin.ts && part.end <= slice.end);
    if (!presented || slice.end <= begin.ts) { problems.push(`Key ${sample.index}: EventLatency did not reach presentation`); return result; }
    // The mark carries both trace-clock and renderer-clock coordinates. Confirm the
    // generated timestamp belongs to this DOM key, not another window or input.
    const markTime = before[0].args?.data?.startTime;
    const keyTime = trustedKeys[0].eventTimestamp;
    const generatedTime = markTime + (begin.ts - before[0].ts) / 1000;
    if (!Number.isFinite(generatedTime) || Math.abs(generatedTime - keyTime) > 1) {
      problems.push(`Key ${sample.index}: EventLatency and trusted key timestamps differ`); return result;
    }
    matchedKeys++;
    result.inputToNextPaintMs = (slice.end - begin.ts) / 1000;
    result.trace = { generatedUs: begin.ts, presentationUs: slice.end, rendererPid: begin.pid, track: slice.track };
    const reported = timing.events.filter(event => event.name === 'keydown' && event.interactionId > 0 && Math.abs(event.startTime - keyTime) <= 1);
    if (reported.length > 1) problems.push(`Key ${sample.index}: ambiguous Event Timing keydown`);
    if (reported.length === 1) {
      result.eventTimingMs = reported[0].duration;
      const deltaMs = Math.abs(result.inputToNextPaintMs - result.eventTimingMs);
      const pass = Number.isFinite(deltaMs) && deltaMs <= EVENT_TIMING_TOLERANCE_MS;
      agreements.push({ index: sample.index, traceMs: result.inputToNextPaintMs, eventTimingMs: result.eventTimingMs, deltaMs, pass });
      if (!pass) problems.push(`Key ${sample.index}: trace and Event Timing differ beyond rounding`);
    }
    return result;
  });
  if (timing.keys.length !== samples.length) problems.push('Trusted keydown count differs from the workload');
  return { samples: measured, validation: { pass: problems.length === 0 && matchedKeys === samples.length,
    expectedKeys: samples.length, matchedKeys, eventTimingChecked: agreements.length,
    agreement: agreements.length ? (agreements.every(row => row.pass) ? 'pass' : 'mismatch') : 'unreported',
    toleranceMs: EVENT_TIMING_TOLERANCE_MS, maxDeltaMs: agreements.length ? Math.max(...agreements.map(row => row.deltaMs)) : null,
    agreements, problems } };
}
