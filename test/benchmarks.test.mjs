import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonCache } from '../src/cache.mjs';
import { loadBenchmarks, publicBenchmarks, benchmarksFor, validSnapshot } from '../src/benchmarks.mjs';
import { fromAider } from '../scripts/sync-benchmarks.mjs';

test('zero AA requests without a key; one cached request across conversations and restarts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-aa-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const fetch = async (url, options) => {
    if (url.includes('artificialanalysis.ai')) {
      calls++;
      assert.equal(options.headers['x-api-key'], 'test-key');
      return Response.json({ data: [{ id: 'stable-id', slug: 'new-model', evaluations: { coding: 91 } }] });
    }
    return Response.json({ version: 1, generatedAt: new Date().toISOString(), models: [] });
  };
  const config = { benchmarksUrl: 'https://example.com/benchmarks' };
  await loadBenchmarks(new JsonCache(dir, { fetch }), config);
  assert.equal(calls, 0);
  config.aaKey = 'test-key';
  let data = await loadBenchmarks(new JsonCache(dir, { fetch }), config);
  assert.equal(benchmarksFor('new-model-free', data)[0].score, 91);
  data = await loadBenchmarks(new JsonCache(dir, { fetch }), config);
  assert.equal(calls, 1);
  assert.equal(data.aa.value.data[0].id, 'stable-id');
});
test('public metadata retains sourced benchmarks without mirroring AA values', () => {
  const scores = publicBenchmarks({ benchmarks: [
    { name: 'SWE', score: 91, source: 'https://lab.example/paper', harness: 'mini' },
    { name: 'Artificial Analysis Intelligence Index', score: 70, source: 'https://artificialanalysis.ai' },
    { name: 'SciCode', score: 45, source: 'https://openrouter.ai/lab/model/benchmarks' },
    { name: 'Missing provenance', score: 100 },
  ] });
  assert.equal(scores.length, 1);
  assert.equal(scores[0].harness, 'mini');
});
test('ambiguous canonical identities are not assigned a mixed score', () => {
  assert.deepEqual(benchmarksFor('same-free', { models: [
    { id: 'lab-a/same', benchmarks: [{ score: 99 }] }, { id: 'lab-b/same', benchmarks: [{ score: 1 }] },
  ], aa: null }), []);
});
test('Aider import preserves conditions and does not invent newer version scores', () => {
  const rows = [{ command: 'aider --model lab/model-v2 --reasoning-effort high', pass_rate_2: 70, test_cases: 225, date: '2025-01-01', edit_format: 'diff', reasoning_effort: 'high' }];
  const result = fromAider(rows);
  assert.equal(result[0].id, 'model-v2');
  assert.equal(result[0].benchmarks[0].setup.reasoningEffort, 'high');
});
test('shipped snapshot has only sourced finite values', async () => {
  const data = JSON.parse(await readFile(new URL('../data/benchmarks.json', import.meta.url)));
  assert.ok(data.models.length);
  assert.ok(validSnapshot(data));
  if (data.source !== 'artificial-analysis') {
    assert.ok(data.models.every((m) => publicBenchmarks(m).length === m.benchmarks.length));
  }
});
