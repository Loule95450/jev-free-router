import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, eligible } from '../src/catalog.mjs';
import { qualityFor } from '../src/benchmarks.mjs';
import { model, snapshot } from './helpers.mjs';

const level = (score) => ({ default: { aaSlug: 'x', evaluations: { artificial_analysis_intelligence_index: score } } });

function fixture() {
  let free = ['existing', 'new-free', 'paid', 'gpt-new-free', 'claude-new-free', 'retired-free'];
  const meta = { opencode: { npm: '@ai-sdk/openai-compatible', models: {
    existing: { cost: { input: 0, output: 0 }, limit: { context: 200000 }, tool_call: true },
    paid: { cost: { input: 1, output: 2 } },
    'retired-free': { cost: { input: 0, output: 0 }, status: 'deprecated' },
  } }, 'opencode-go': { models: {
    'go-model': { cost: { input: 1, output: 2 }, provider: { npm: '@ai-sdk/anthropic' } },
  } } };
  const cache = { get: async (url) => ({ checkedAt: Date.now(), stale: false, value:
    url.endsWith('/models.json') ? { 'lab/new-free': { id: 'lab/new', benchmarks: [{ name: 'Coding', score: 92, source: 'https://lab.example/eval' }] } } :
      url.includes('models.dev') ? meta : url.includes('benchmarks')
        ? snapshot([{ id: 'new-free', reasoningLevels: level(77) }]) :
      { data: (url.includes('/go/') ? ['go-model', 'next-generation', 'gpt-5.6-luna'] : free).map((id) => ({ id })) },
  }) };
  return { catalog: new Catalog(cache, { benchmarksUrl: 'https://example.com/benchmarks' }),
    add: (id) => free.push(id) };
}
test('Zen only includes free entries; neither pool can include OpenAI, Anthropic or retired models', async () => {
  const { catalog } = fixture();
  const result = await catalog.load({ hasGo: true });
  // retired-free is priced at zero but marked deprecated: Zen lists it and no longer serves it.
  assert.deepEqual(result.map((m) => m.id), ['existing', 'new-free', 'go-model', 'next-generation']);
  assert.equal(result[2].protocol, '@ai-sdk/anthropic'); // Go transport, not a Claude model.
  const fresh = result.find((m) => m.id === 'new-free');
  assert.equal(fresh.benchmarks[0].score, 92); // Sourced models.dev score.
  assert.equal(fresh.quality.reasoningLevels.default.evaluations.artificial_analysis_intelligence_index, 77);
});
test('a newly listed model immediately participates without a score or package update', async () => {
  const { catalog, add } = fixture();
  await catalog.load();
  add('tomorrow-free');
  const result = await catalog.load({ force: true });
  const fresh = result.find((m) => m.id === 'tomorrow-free');
  assert.deepEqual(fresh.benchmarks, []);
  assert.equal(fresh.quality, null);
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
  const data = { models: new Map([['model-2', { id: 'model-2', reasoningLevels: level(90) }]]), metrics: {}, generatedAt: null, source: null };
  assert.equal(qualityFor('model-2-free', data).reasoningLevels.default.evaluations.artificial_analysis_intelligence_index, 90);
  assert.equal(qualityFor('model-3-free', data), null);
});

test('optional Hugging Face parameter counts are sourced and do not become quality scores', async () => {
  const calls = [];
  const cache = { get: async (url) => {
    calls.push(url);
    const value = url.includes('huggingface.co/api') ? { safetensors: { total: 123456 } } :
      url.endsWith('/models.json') ? { 'lab/fresh': { id: 'lab/fresh', weights: [{ url: 'https://huggingface.co/lab/fresh' }] } } :
      url.endsWith('/api.json') ? { opencode: { models: {} } } :
      url.includes('benchmarks') ? snapshot() :
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
