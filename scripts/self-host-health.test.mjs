import assert from 'node:assert/strict';
import test from 'node:test';
import { automationReadiness } from '../tools/self-host/health.mjs';

test('automation readiness requires the configured state even when the relay reports ok', () => {
  assert.deepEqual(automationReadiness({ok: true, automations: 'on'}, true), {ok: true, detail: 'engine daemon up; replica pass completed'});
  assert.deepEqual(automationReadiness({ok: true, automations: 'off'}, false), {ok: true, detail: 'off by configuration'});
  for (const value of [null, {}, {ok: true}, {ok: true, automations: 'unavailable'}]) {
    assert.equal(automationReadiness(value, true).ok, false);
    assert.equal(automationReadiness(value, false).ok, false);
  }
  assert.equal(automationReadiness({automations: 'off'}, true).ok, false);
  assert.equal(automationReadiness({automations: 'on'}, false).ok, false);
});
