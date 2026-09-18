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
