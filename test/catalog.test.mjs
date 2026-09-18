import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, eligible } from '../src/catalog.mjs';
import { benchmarksFor } from '../src/benchmarks.mjs';
import { model } from './helpers.mjs';

function fixture() {
  let free = ['existing', 'new-free', 'paid', 'gpt-new-free', 'claude-new-free'];
  const meta = { opencode: { npm: '@ai-sdk/openai-compatible', models: {
    existing: { cost: { input: 0, output: 0 }, limit: { context: 200000 }, tool_call: true },
    paid: { cost: { input: 1, output: 2 } },
  } }, 'opencode-go': { models: {
    'go-model': { cost: { input: 1, output: 2 }, provider: { npm: '@ai-sdk/anthropic' } },
  } } };
  const cache = { get: async (url) => ({ checkedAt: Date.now(), stale: false, value:
    url.endsWith('/models.json') ? { 'lab/new-free': { id: 'lab/new', benchmarks: [{ name: 'Coding', score: 92, source: 'https://lab.example/eval' }] } } :
      url.includes('models.dev') ? meta : url.includes('benchmarks') ? { version: 1, generatedAt: new Date().toISOString(), models: [] } :
      { data: (url.includes('/go/') ? ['go-model', 'next-generation', 'gpt-5.6-luna'] : free).map((id) => ({ id })) },
  }) };
  return { catalog: new Catalog(cache, { benchmarksUrl: 'https://example.com/benchmarks' }),
    add: (id) => free.push(id) };
}
test('Zen only includes free entries; neither pool can include OpenAI or Anthropic models', async () => {
  const { catalog } = fixture();
  const result = await catalog.load({ hasGo: true });
  assert.deepEqual(result.map((m) => m.id), ['existing', 'new-free', 'go-model', 'next-generation']);
  assert.equal(result[2].protocol, '@ai-sdk/anthropic'); // Go transport, not a Claude model.
  assert.equal(result.find((m) => m.id === 'new-free').benchmarks[0].score, 92);
});
test('a newly listed model immediately participates without a score or package update', async () => {
  const { catalog, add } = fixture();
  await catalog.load();
  add('tomorrow-free');
  const result = await catalog.load({ force: true });
  const fresh = result.find((m) => m.id === 'tomorrow-free');
  assert.deepEqual(fresh.benchmarks, []);
  assert.equal(fresh.context, null);
  assert.equal(fresh.parameters, null);
});
test('Go requires credentials; mixed mode without Go only offers free models', async () => {
  const { catalog } = fixture();
  await assert.rejects(catalog.load({ mode: 'jev-go' }), /Connect OpenCode Go/);
  assert.ok((await catalog.load()).every((m) => m.pool === 'free'));
});
test('hard constraints filter known incompatibility without turning missing benchmarks into exclusions', () => {
  const candidates = [model('text'), model('vision', { modalities: ['text', 'image'] }), model('small', { context: 100 })];
  assert.deepEqual(eligible(candidates, { contextTokens: 1000 }).map((m) => m.id), ['text', 'vision']);
  assert.deepEqual(eligible(candidates, { modalities: ['image'] }).map((m) => m.id), ['vision']);
});
test('benchmark matching preserves versions and never borrows a predecessor score', () => {
  const data = { models: [{ id: 'model-2', benchmarks: [{ score: 90 }] }], aa: null };
  assert.equal(benchmarksFor('model-2-free', data)[0].score, 90);
  assert.deepEqual(benchmarksFor('model-3-free', data), []);
});

test('optional Hugging Face parameter counts are sourced and do not become quality scores', async () => {
  const calls = [];
  const cache = { get: async (url) => {
    calls.push(url);
    const value = url.includes('huggingface.co/api') ? { safetensors: { total: 123456 } } :
      url.endsWith('/models.json') ? { 'lab/fresh': { id: 'lab/fresh', weights: [{ url: 'https://huggingface.co/lab/fresh' }] } } :
      url.endsWith('/api.json') ? { opencode: { models: {} } } :
      url.includes('benchmarks') ? { version: 1, generatedAt: new Date().toISOString(), models: [] } :
      { data: [{ id: 'fresh-free' }] };
    return { value, checkedAt: Date.now(), stale: false };
  } };
  const catalog = new Catalog(cache, { benchmarksUrl: 'https://example.com/benchmarks', fetchParameterCounts: true });
  const [fresh] = await catalog.load();
  assert.equal(fresh.parameters, 123456);
  assert.deepEqual(fresh.benchmarks, []);
  assert.equal(fresh.parametersSource, 'https://huggingface.co/lab/fresh');
  assert.equal(calls.filter((url) => url.includes('huggingface')).length, 1);
});
