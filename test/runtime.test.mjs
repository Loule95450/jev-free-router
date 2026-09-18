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
