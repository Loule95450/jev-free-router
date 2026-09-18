import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonCache } from '../src/cache.mjs';
import { loadBenchmarks, publicBenchmarks, qualityFor, validSnapshot } from '../src/benchmarks.mjs';
import { aaBase, aaEffort } from '../src/config.mjs';
import { buildModels, indexArtificialAnalysis, levelOf } from '../scripts/sync-benchmarks.mjs';
import { snapshot } from './helpers.mjs';

const row = (slug, extra = {}) => ({ id: `id-${slug}`, slug, name: slug, release_date: '2026-01-01',
  model_creator: { name: 'Lab' }, evaluations: { artificial_analysis_intelligence_index: 40 }, ...extra });

test('the plugin never calls Artificial Analysis: one cached snapshot request, no API key anywhere', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-bench-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return Response.json(snapshot([{ id: 'grok-4.6', aaBase: 'grok-4-6', name: 'Grok 4.6', creator: 'Lab', releaseDate: '2026-08-12',
      reasoningLevels: { default: { aaSlug: 'grok-4-6', evaluations: { gpqa: 0.949 } } } }]));
  };
  const config = { benchmarksUrl: 'https://example.com/benchmarks' };
  const data = await loadBenchmarks(new JsonCache(dir, { fetch }), config);
  await loadBenchmarks(new JsonCache(dir, { fetch }), config);
  assert.equal(urls.length, 1);
  assert.ok(!urls.some((url) => url.includes('artificialanalysis')));
  assert.equal(qualityFor('grok-4.6', data).reasoningLevels.default.evaluations.gpqa, 0.949);
});

test('a missing snapshot falls back to the shipped copy rather than guessing a score', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-bench-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetch = async () => { throw new Error('offline'); };
  const data = await loadBenchmarks(new JsonCache(dir, { fetch }), { benchmarksUrl: 'https://example.com/benchmarks' });
  assert.ok(data.models.size, 'the packaged snapshot should still answer offline');
  assert.equal(qualityFor('model-that-does-not-exist', data), null);
});

test('Zen aliases resolve to the Artificial Analysis identity', () => {
  // Zen writes gemini-3.8-flash and serves muse-spark through a -contributor alias.
  assert.equal(aaBase('gemini-3.8-flash'), 'gemini-3-8-flash');
  assert.equal(aaBase('muse-spark-1.3-contributor-free'), 'muse-spark-1-3');
  assert.equal(aaBase('lab/qwen3.5-plus'), 'qwen3-5-plus');
});

test('an effort suffix only splits when the bare slug is published too', () => {
  const known = new Set(['grok-4-6', 'grok-4-6-xhigh', 'qwen3-8-max', 'magistral-medium', 'claude-5', 'claude-5-non-reasoning']);
  assert.deepEqual(aaEffort('grok-4-6-xhigh', known), ['grok-4-6', 'xhigh']);
  assert.deepEqual(aaEffort('claude-5-non-reasoning', known), ['claude-5', 'non-reasoning']);
  // qwen3-8-max and magistral-medium are model names: splitting them would invent qwen3-8 and magistral.
  assert.deepEqual(aaEffort('qwen3-8-max', known), ['qwen3-8-max', 'default']);
  assert.deepEqual(aaEffort('magistral-medium', known), ['magistral-medium', 'default']);
});

test('every reasoning level of a model is kept under one candidate', () => {
  const index = indexArtificialAnalysis([
    row('grok-4-6'), row('grok-4-6-xhigh'), row('grok-4-6-low'), row('qwen3-8-max'),
  ]);
  const { models, skipped } = buildModels(['grok-4.6', 'qwen3.8-max', 'big-pickle'], index);
  assert.deepEqual(models.map((m) => m.id), ['grok-4.6', 'qwen3.8-max']);
  assert.deepEqual(Object.keys(models[0].reasoningLevels).sort(), ['default', 'low', 'xhigh']);
  assert.deepEqual(skipped, ['big-pickle']);
});

test('a model Artificial Analysis has not measured is skipped, never scored at zero', () => {
  const index = indexArtificialAnalysis([row('measured'), row('unmeasured', { evaluations: {} })]);
  const { models, skipped } = buildModels(['measured', 'unmeasured'], index);
  assert.deepEqual(models.map((m) => m.id), ['measured']);
  assert.deepEqual(skipped, ['unmeasured']);
});

test('non-finite and non-numeric values are dropped instead of being carried as scores', () => {
  const level = levelOf(row('x', { evaluations: { gpqa: 0.9, mmlu_pro: null, hle: 'n/a' }, pricing: {}, median_output_tokens_per_second: 55 }));
  assert.deepEqual(level.evaluations, { gpqa: 0.9 });
  assert.equal(level.pricing, undefined);
  assert.equal(level.throughput.outputTokensPerSecond, 55);
});

test('sourced public scores from models.dev survive alongside the snapshot', () => {
  const scores = publicBenchmarks({ benchmarks: [
    { name: 'SWE', score: 91, source: 'https://lab.example/paper', harness: 'mini' },
    { name: 'SciCode', score: 45, source: 'https://openrouter.ai/lab/model/benchmarks' },
    { name: 'Missing provenance', score: 100 },
  ] });
  assert.equal(scores.length, 1);
  assert.equal(scores[0].harness, 'mini');
});

test('shipped snapshot is a valid v2 with finite values only', async () => {
  const data = JSON.parse(await readFile(new URL('../data/benchmarks.json', import.meta.url)));
  assert.ok(validSnapshot(data));
  assert.ok(data.models.length);
  assert.equal(data.source, 'artificial-analysis');
  for (const model of data.models) {
    assert.ok(Object.keys(model.reasoningLevels).length);
    for (const level of Object.values(model.reasoningLevels)) {
      for (const value of Object.values(level.evaluations ?? {})) assert.ok(Number.isFinite(value));
    }
  }
});

test('a v1 snapshot is rejected rather than read with the wrong shape', () => {
  assert.ok(!validSnapshot({ version: 1, generatedAt: new Date().toISOString(), models: [] }));
  assert.ok(!validSnapshot(snapshot([{ id: 'x', reasoningLevels: { default: { aaSlug: 'x', evaluations: { gpqa: 'high' } } } }])));
  assert.ok(validSnapshot(snapshot([{ id: 'x', reasoningLevels: { default: { aaSlug: 'x' } } }])));
});
