import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, streamText } from 'ai';
import { createJev } from '../src/provider.mjs';
import { model } from './helpers.mjs';

function provider(target, fetch) {
  return createJev({ runtime: { select: async () => ({ model: target, credentials: { go: 'go-secret' }, sessionID: 'session' }) }, fetch })('jev');
}
test('real SDK preserves streaming text and forwards only the selected model credential', async () => {
  let wire;
  const result = streamText({ model: provider(model('new-free'), async (url, init) => {
    wire = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    const chunks = [
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'new-free', choices: [{ index: 0, delta: { role: 'assistant', content: 'Bonjour' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'new-free', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }), prompt: 'Salut', headers: { 'x-jev-turn': 'u1', authorization: 'Bearer must-not-forward' }, maxRetries: 0 });
  assert.equal(await result.text, 'Bonjour');
  assert.equal(wire.body.model, 'new-free');
  assert.equal(wire.url, 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(wire.headers.get('x-jev-turn'), null);
  assert.equal(wire.headers.get('authorization'), 'Bearer public');
  assert.equal(wire.headers.get('x-opencode-session'), 'session');
});
test('tool calls, results and interleaved reasoning survive the real compatible SDK', async () => {
  let wire;
  const language = provider(model('reasoner', { interleaved: { field: 'reasoning_content' } }), async (url, init) => {
    wire = JSON.parse(init.body);
    return Response.json({ id: 'c1', created: 1, model: 'reasoner', choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  });
  await language.doGenerate({ prompt: [
    { role: 'user', content: [{ type: 'text', text: 'test' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'Need tool' }, { type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: { command: 'pwd' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'bash', output: { type: 'text', value: '/tmp' } }] },
  ], tools: [{ type: 'function', name: 'bash', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }] });
  assert.equal(wire.messages[1].reasoning_content, 'Need tool');
  assert.equal(wire.messages[1].tool_calls[0].id, 't1');
  assert.equal(wire.messages[2].tool_call_id, 't1');
  assert.equal(wire.tools[0].function.name, 'bash');
});
test('Go models using Messages protocol still go exclusively to OpenCode', async () => {
  let wire;
  const result = await generateText({ model: provider(model('go-model', { pool: 'go', protocol: '@ai-sdk/anthropic' }), async (url, init) => {
    wire = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return Response.json({ id: 'm1', type: 'message', role: 'assistant', model: 'go-model', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }), prompt: 'Hello', maxRetries: 0 });
  assert.equal(result.text, 'OK');
  assert.equal(wire.url, 'https://opencode.ai/zen/go/v1/messages');
  assert.equal(wire.headers.get('x-api-key'), 'go-secret');
  assert.equal(wire.body.model, 'go-model');
});

test('an unavailable model falls through to Jev\'s next candidate instead of failing the turn', async () => {
  const seen = [];
  const notified = [];
  const ranked = [model('retired-free'), model('backup-free'), model('last-free')];
  const runtime = {
    select: async () => ({ model: ranked[0], ranked, credentials: {}, sessionID: 'session', reason: 'jev', probabilities: {} }),
    notify: async (d) => notified.push(`${d.model.id}:${d.reason}`),
  };
  const language = createJev({ runtime, fetch: async (url, init) => {
    const id = JSON.parse(init.body).model;
    seen.push(id);
    if (id === 'retired-free') return new Response('{"error":"Model is unavailable"}', { status: 404 });
    return Response.json({ id: 'c1', created: 1, model: id, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } })('jev');
  const result = await language.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  assert.deepEqual(seen, ['retired-free', 'backup-free']);
  assert.equal(result.content[0].text, 'OK');
  assert.deepEqual(notified, ['backup-free:retry/retired-free-unavailable']);
});
test('a cancelled turn never spends a second model', async () => {
  const seen = [];
  const controller = new AbortController();
  const ranked = [model('a-free'), model('b-free')];
  const runtime = { select: async () => ({ model: ranked[0], ranked, credentials: {}, sessionID: 's' }), notify: async () => {} };
  const language = createJev({ runtime, fetch: async (url, init) => {
    seen.push(JSON.parse(init.body).model);
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  } })('jev');
  await assert.rejects(language.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], abortSignal: controller.signal,
  }));
  assert.deepEqual(seen, ['a-free']);
});

const sse = (id, text) => new Response([
  { id: 'c1', object: 'chat.completion.chunk', created: 1, model: id, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
  { id: 'c1', object: 'chat.completion.chunk', created: 1, model: id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
].map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

test('the chat shows the routed model and applied thinking once per turn, and no model ever reads it', async () => {
  const bodies = [];
  const announced = new Set();
  const target = model('deepseek-free', { reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }] });
  const runtime = {
    select: async () => ({ model: target, credentials: {}, sessionID: 's', agent: 'build', turnKey: 't1', effort: 'medium', reason: 'jev' }),
    announce: (key) => !announced.has(key) && Boolean(announced.add(key)),
  };
  const language = createJev({ runtime, fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return sse('deepseek-free', 'OK'); } })('jev');
  const first = streamText({ model: language, prompt: 'Fix it', maxRetries: 0 });
  assert.equal(await first.text, 'Jev → deepseek-free · thinking highOK');
  const parts = (await first.response).messages[0].content;
  assert.equal(parts[0].providerOptions.jev.route, true);
  assert.equal(bodies[0].reasoning_effort, 'high');
  // The next step of the same turn: no second line, and the first one is stripped from the replay.
  const second = streamText({ model: language, maxRetries: 0, messages: [
    { role: 'user', content: 'Fix it' }, { role: 'assistant', content: parts }, { role: 'user', content: 'continue' },
  ] });
  assert.equal(await second.text, 'OK');
  assert.deepEqual(bodies[1].messages[1], { role: 'assistant', content: 'OK' });
});
test('internal title agents never receive the routing line', async () => {
  const runtime = { select: async () => ({ model: model('a-free'), credentials: {}, sessionID: 's', agent: 'title', turnKey: 't', effort: 'low' }), announce: () => true };
  const result = streamText({ model: createJev({ runtime, fetch: async () => sse('a-free', 'Titre') })('jev'), prompt: 'x', maxRetries: 0 });
  assert.equal(await result.text, 'Titre');
});
test('a fallback model maps Jev\'s effort onto its own controls', async () => {
  const seen = [];
  const ranked = [model('gone-free'), model('gemini', { protocol: '@ai-sdk/openai-compatible', reasoningOptions: [{ type: 'effort', values: ['low', 'medium'] }] })];
  const runtime = { select: async () => ({ model: ranked[0], ranked, credentials: {}, sessionID: 's', effort: 'high' }), notify: async () => {} };
  const language = createJev({ runtime, fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push([body.model, body.reasoning_effort]);
    if (body.model === 'gone-free') return new Response('{}', { status: 404 });
    return Response.json({ id: 'c1', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
  } })('jev');
  await language.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  assert.deepEqual(seen, [['gone-free', undefined], ['gemini', 'medium']]);
});
test('a later generation shows a line only when the applied thinking changes', async () => {
  const target = model('deepseek-free', { reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }] });
  const bodies = [];
  const run = async (decision) => {
    const runtime = { select: async () => ({ model: target, credentials: {}, sessionID: 's', agent: 'build', turnKey: 't', reason: 'jev', turnEffort: 'low', ...decision }), announce: () => true };
    const result = streamText({ model: createJev({ runtime, fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return sse('deepseek-free', 'OK'); } })('jev'), prompt: 'x', maxRetries: 0 });
    return result.text;
  };
  assert.equal(await run({ step: 3, effort: 'xhigh', previousEffort: 'low', leaseUntil: 4 }), 'Jev · thinking low → max · étape 3 · 2 générationsOK');
  assert.equal(bodies[0].reasoning_effort, 'max');
  // `medium` and `high` both map to `high` on this model: nothing visible changed.
  assert.equal(await run({ step: 4, effort: 'medium', previousEffort: 'high', leaseUntil: 4 }), 'OK');
});
test('a rate-limited model is cooled and the model that answered stays for the rest of the turn', async () => {
  const { Runtime } = await import('../src/runtime.mjs');
  const seen = [];
  const ranked = [model('muse-free'), model('pickle-free')];
  const runtime = new Runtime({}, {
    catalog: { load: async () => ranked },
    router: { route: async () => ({ model: ranked[0], ranked, reason: 'jev', effort: null, lease: 10, probabilities: {} }) },
    getCredentials: async () => ({}),
  });
  const language = createJev({ runtime, fetch: async (url, init) => {
    const id = JSON.parse(init.body).model;
    seen.push(id);
    if (id === 'muse-free') return new Response('{"error":"rate_limit_exceeded"}', { status: 429, headers: { 'retry-after': '60' } });
    return Response.json({ id: 'c1', created: 1, model: id, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
  } })('jev');
  const options = { ...(await import('./helpers.mjs')).prompt() };
  await language.doGenerate(options);
  await language.doGenerate({ ...options, prompt: [...options.prompt, { role: 'assistant', content: [{ type: 'text', text: 'OK' }] }] });
  // Second generation of the same turn goes straight to the model that answered.
  assert.deepEqual(seen, ['muse-free', 'pickle-free', 'pickle-free']);
  assert.equal(runtime.isCooling('muse-free'), true);
  assert.equal(runtime.sessions.get('s1:jev:build').id, 'pickle-free');
  // A new turn skips the cooling model too, while Jev's own ranking is untouched.
  await language.doGenerate((await import('./helpers.mjs')).prompt('next', 'u2'));
  assert.deepEqual(seen.slice(3), ['pickle-free']);
});
test('a cooled model is retried when every candidate is cooling', async () => {
  const seen = [];
  const ranked = [model('a-free'), model('b-free')];
  const runtime = { select: async () => ({ model: ranked[0], ranked, credentials: {}, sessionID: 's' }), notify: async () => {}, isCooling: () => true };
  const language = createJev({ runtime, fetch: async (url, init) => {
    seen.push(JSON.parse(init.body).model);
    return Response.json({ id: 'c1', created: 1, model: 'a-free', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
  } })('jev');
  await language.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  assert.deepEqual(seen, ['a-free']);
});
test('a mid-turn fallback names the new model in the chat', async () => {
  const ranked = [model('muse-free'), model('pickle-free')];
  const runtime = { select: async () => ({ model: ranked[0], ranked, pinned: 'muse-free', step: 4, effort: null, previousEffort: null,
    credentials: {}, sessionID: 's', agent: 'build', turnKey: 't', reason: 'jev' }), announce: () => true, notify: async () => {} };
  const language = createJev({ runtime, fetch: async (url, init) => JSON.parse(init.body).model === 'muse-free'
    ? new Response('{}', { status: 429 }) : sse('pickle-free', 'OK') })('jev');
  assert.equal(await streamText({ model: language, prompt: 'x', maxRetries: 0 }).text, 'Jev → pickle-free · thinking par défaut · repli, étape 4OK');
});
