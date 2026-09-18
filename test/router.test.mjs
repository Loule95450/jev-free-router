import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router, choose, distribution, routingRequest } from '../src/router.mjs';
import { model } from './helpers.mjs';

const models = [model('known-free'), model('brand-new-model')];
test('Choice contains exact IDs, live evidence and unknown quality without a zero score', () => {
  const request = routingRequest({ prompt: 'debug', contextTokens: 42, models });
  assert.deepEqual(Object.keys(request.questions.model.criteria), models.map((m) => m.id));
  assert.equal(request.questions.model.criteria['brand-new-model'].quality_status, 'unknown');
  assert.deepEqual(request.questions.model.criteria['brand-new-model'].benchmarks, []);
});
test('full TypeSafe probability distribution drives the decision, not its top-1 label', async () => {
  const client = { systemOne: async () => ({ answers: {
    model: { choice: 'known-free', probabilities: { 'known-free': 0.1, 'brand-new-model': 0.9 }, confidence: 0.91 },
    task_complexity: { score: 4 },
  } }) };
  const result = await new Router({ costWeight: 0.02 }, { client }).route({ prompt: 'debug', contextTokens: 1, models });
  assert.equal(result.model.id, 'brand-new-model');
  assert.equal(result.probabilities['known-free'], 0.1);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.metrics.task_complexity, 0.8);
});
test('cost is bounded and separate from quality probabilities', () => {
  const candidates = [model('free'), model('go', { cost: { input: 10, output: 20 } })];
  assert.equal(choose(candidates, { free: 0.49, go: 0.51 }, { costWeight: 0 }).model.id, 'go');
  assert.equal(choose(candidates, { free: 0.495, go: 0.505 }).model.id, 'free');
  assert.equal(choose(candidates, { free: 0.1, go: 0.9 }).model.id, 'go');
});
test('reject incomplete, negative, unknown, zero and non-normalized probability vectors', () => {
  for (const probabilities of [{ 'known-free': 1 }, { 'known-free': -0.1, 'brand-new-model': 1.1 },
    { other: 1, 'known-free': 0 }, { 'known-free': 0, 'brand-new-model': 0 }, { 'known-free': 0.8, 'brand-new-model': 0.8 }]) {
    assert.throws(() => distribution({ probabilities }, models));
  }
});
test('missing key uses explicit fallback with no fabricated probabilities', async () => {
  const result = await new Router({}).route({ prompt: 'debug', contextTokens: 0, outputTokens: 10, models, current: 'brand-new-model' });
  assert.equal(result.reason, 'fallback/missing-typesafe-key');
  assert.equal(result.model.id, 'brand-new-model');
  assert.equal(result.probabilities, null);
});
test('user cancellation never turns into a paid fallback request', async () => {
  await assert.rejects(new Router({}).route({ models }, AbortSignal.abort()), { name: 'AbortError' });
});
