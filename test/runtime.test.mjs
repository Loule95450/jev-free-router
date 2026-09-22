import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.mjs';
import { model, prompt } from './helpers.mjs';

test('one route per user turn, pinned tools, distinct sessions and agent isolation', async () => {
  let calls = 0, lists = [];
  const runtime = new Runtime({}, {
    catalog: { load: async (args) => { lists.push(args); return [model('dynamic')]; } },
    router: { route: async (args) => { calls++; return { model: args.models[0] }; } },
    getCredentials: async () => ({}),
  });
  const first = prompt();
  await Promise.all([runtime.select('jev', first), runtime.select('jev', first)]);
  const continuation = { ...first, prompt: [...first.prompt, { role: 'tool', content: [{ type: 'tool-result', output: { type: 'text', value: 'ok' } }] }] };
  await runtime.select('jev', continuation);
  assert.equal(calls, 1);
  await runtime.select('jev', prompt('Fix the tests', 'u2'));
  assert.equal(calls, 2); // Repeated text with new message ID is a fresh decision.
  assert.deepEqual(lists.map((l) => l.force), [true, false]);
  await runtime.select('jev', prompt('Fix the tests', 'u1', 'other-session'));
  await runtime.select('jev', { ...first, headers: { ...first.headers, 'x-jev-agent': 'explore' } });
  assert.equal(calls, 4);
  runtime.forget('s1');
  assert.equal(runtime.sessions.size, 1);
});
test('fallback turn fingerprint excludes tool results', async () => {
  let calls = 0;
  const runtime = new Runtime({}, {
    catalog: { load: async () => [model('dynamic')] },
    router: { route: async () => { calls++; return { model: model('dynamic') }; } },
    getCredentials: async () => ({}),
  });
  const options = { ...prompt(), headers: {} };
  await runtime.select('jev', options);
  await runtime.select('jev', { ...options, prompt: [...options.prompt, { role: 'assistant', content: [{ type: 'text', text: 'working' }] }] });
  assert.equal(calls, 1);
});

const toolStep = (options, output = { type: 'text', value: 'ok' }, id = 't1') => ({ ...options, prompt: [...options.prompt,
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'bash', input: { command: 'npm test' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'bash', output }] }] });
function stepping({ effort = 'low', lease = 2, reason = 'jev', reassess } = {}) {
  const asked = [], logged = [];
  const runtime = new Runtime({}, {
    catalog: { load: async () => [model('dynamic')] },
    router: {
      route: async (args) => ({ model: args.models[0], effort, lease, reason }),
      reassess: async (input) => { asked.push(input); return reassess ? reassess(input) : { effort: 'high', lease: 5, elapsedMs: 1 }; },
    },
    getCredentials: async () => ({}),
    onStep: async (event) => logged.push(event),
  });
  return { runtime, asked, logged };
}

test('the effort holds for its lease, then Jev judges the next generation from bounded progress', async () => {
  const { runtime, asked, logged } = stepping();
  let options = prompt();
  const efforts = [];
  for (let i = 0; i < 4; i++) {
    const decision = await runtime.select('jev', options);
    efforts.push([decision.step, decision.effort, decision.previousEffort]);
    options = toolStep(options, undefined, `t${i}`);
  }
  assert.deepEqual(efforts, [[1, 'low', 'low'], [2, 'low', 'low'], [3, 'high', 'low'], [4, 'high', 'high']]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].request, 'Fix the tests');
  assert.equal(asked[0].step, 3);
  assert.equal(asked[0].toolCalls.length, 2);
  assert.equal(logged[0].trigger, 'lease-expired');
  runtime.forget('s1');
  assert.equal(runtime.steps.size, 0);
});
test('a tool failure ends the lease early', async () => {
  const { runtime, asked, logged } = stepping({ lease: 10 });
  await runtime.select('jev', prompt());
  const decision = await runtime.select('jev', toolStep(prompt(), { type: 'error-text', value: 'exit 1' }));
  assert.equal(decision.effort, 'high');
  assert.equal(asked[0].toolFailed, true);
  assert.equal(logged[0].trigger, 'tool-failure');
});
test('a failed reassessment keeps the current effort and asks again at the next generation', async () => {
  let attempts = 0;
  const { runtime, asked } = stepping({ lease: 1, reassess: () => { if (++attempts === 1) throw new Error('timeout'); return { effort: 'minimal', lease: 2 }; } });
  await runtime.select('jev', prompt());
  assert.equal((await runtime.select('jev', toolStep(prompt()))).effort, 'low');
  assert.equal((await runtime.select('jev', toolStep(toolStep(prompt()), undefined, 't2'))).effort, 'minimal');
  assert.equal(asked.length, 2);
});
test('without a TypeSafe key no generation ever asks Jev', async () => {
  const { runtime, asked } = stepping({ effort: null, lease: null, reason: 'fallback/missing-typesafe-key' });
  await runtime.select('jev', prompt());
  await runtime.select('jev', toolStep(prompt(), { type: 'error-text', value: 'boom' }));
  assert.equal(asked.length, 0);
});
test('progress previews are head-and-tail bounded and exclude reasoning', async () => {
  const { describeProgress } = await import('../src/runtime.mjs');
  const long = 'a'.repeat(3000) + 'MIDDLE' + 'z'.repeat(3000);
  const options = toolStep({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'Running tests' }] }] }, { type: 'text', value: long });
  const progress = describeProgress(options);
  assert.equal(progress.progress, 'Running tests');
  assert.ok(progress.toolCalls[0].result.length < 4100);
  assert.ok(!progress.toolCalls[0].result.includes('MIDDLE'));
  assert.equal(progress.toolFailed, false);
});
test('cooling follows Retry-After within bounds and expires', () => {
  const runtime = new Runtime({}, { catalog: {}, router: {}, getCredentials: async () => ({}) });
  runtime.cool('m', { responseHeaders: { 'retry-after': '5' } }, 0);
  assert.equal(runtime.cooling.get('m'), 30_000);
  runtime.cool('m', {}, 0);
  assert.equal(runtime.cooling.get('m'), 120_000);
  assert.equal(runtime.isCooling('m', 119_999), true);
  assert.equal(runtime.isCooling('m', 120_000), false);
});
