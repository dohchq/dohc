import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isExpectedOverload, summarizeBenchmark } from './benchmark-summary.mjs';

function fixture() {
  const stages = [];
  const stage = (label, attempts, extra = {}) => ({label, attempts, count: attempts, p50: 2, p95: 3, p99: 4, max: 5, elapsedMs: 20, failures: [], ...extra});
  for (const dataset of ['narrow', 'wide']) {
    for (const operation of ['read', 'write']) for (let round = 1; round <= 3; round++) stages.push(stage(`${dataset}/warm-${operation}/${round}`, 200));
    stages.push(stage(`${dataset}/cold-reopen`, 30));
    stages.push(stage(`${dataset}/burst-10`, 10, {rowsAdded: 10}));
    stages.push(stage(`${dataset}/burst-100`, 100, {count: 64, rowsAdded: 64, failures: Array.from({length: 36}, () => ({message: 'Dataset operation queue is full. Retry this operation.'}))}));
    for(const diagnostic of ['late-page','broad-text-search','export'])stages.push(stage(`${dataset}/${diagnostic}`,3));
  }
  stages.push(stage('ten-dataset-churn',100),stage('soak/0',100));
  return {stages,errors:[],remainingOwnedPids:[],fixtures:Array(10).fill({}),soak:{requestedSeconds:3600,actualSeconds:3601},
    memory:[{label:'soak/1/after-idle',at:'now',processes:[{}],workers:[],workerWorkingSetBytes:0,parent:{heapUsed:123,external:456,rss:789}}]};
}

test('only explicit bounded overload in the hundred-caller burst is expected', () => {
  assert.equal(isExpectedOverload('narrow/burst-100',{code:'queue_full'}),true);
  assert.equal(isExpectedOverload('narrow/burst-10',{code:'queue_full'}),false);
  assert.equal(isExpectedOverload('soak/0',{message:'Dataset workers are busy. Retry this operation.'}),false);
  assert.equal(isExpectedOverload('narrow/burst-100',{code:'queue_full',message:'Worker deadline expired'}),false);
  assert.equal(isExpectedOverload('narrow/burst-100',{code:'worker_deadline',message:'The dataset worker exceeded its deadline.'}),false);
  assert.equal(isExpectedOverload('narrow/burst-100',{message:'operation refused'}),false);
});

test('complete successful local evidence passes without claiming other campaign gates', () => {
  const summary=summarizeBenchmark(fixture());
  assert.equal(summary.passed,true);assert.equal(summary.failures,72);
  assert.equal(summary.coldReopen.length,2);assert.equal(summary.coldReopen[0].successes,30);
  assert.equal(summary.warmRounds.length,12);assert.ok(summary.unmeasured.includes('Ordinary 4-core/8 GiB hardware'));
});

test('one failed round or cold fixture cannot disappear inside pooled percentiles', () => {
  const evidence=fixture();evidence.stages[0].p95=51;
  assert.equal(summarizeBenchmark(evidence).checks.warmPerRound,false);
  evidence.stages[0].p95=3;evidence.stages.find(stage=>stage.label==='wide/cold-reopen').p95=1001;
  assert.equal(summarizeBenchmark(evidence).checks.coldPerFixture,false);
});

test('any workload failure, missing duration, duplicate burst count, or survivor fails', () => {
  for (const mutate of [
    value=>value.stages.at(-1).failures.push({message:'Dataset workers are busy. Retry this operation.'}),
    value=>value.soak.actualSeconds=3599,
    value=>value.stages.find(stage=>stage.label.endsWith('/burst-100')).rowsAdded++,
    value=>value.remainingOwnedPids.push(99),
    value=>value.errors.push({message:'shutdown failed'}),
    value=>value.stages.splice(0,1),
    value=>value.memory=[],
    value=>value.stages.find(stage=>stage.label.endsWith('/export')).count=0,
  ]) {const evidence=fixture();mutate(evidence);assert.equal(summarizeBenchmark(evidence).passed,false);}
});

test('frequent RSS observations cannot be hidden by low stage snapshots',()=>{
  const evidence=fixture();evidence.memorySampling={samples:10,maxSampledWorkerWorkingSetBytes:513*1024*1024};
  const summary=summarizeBenchmark(evidence);assert.equal(summary.passed,false);assert.equal(summary.checks.observedWorkerMemory,false);
  assert.equal(summary.diagnostics.length,6);assert.equal(summary.memory.idleGrowth.parentRss.delta,0);
});
