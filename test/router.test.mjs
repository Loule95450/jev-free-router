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
    standalone: { noul: 0.05 },
    task_complexity: { score: 4 },
  } }) };
  const result = await new Router({ costWeight: 0.02 }, { client }).route({ prompt: 'debug', contextTokens: 1, models });
  assert.equal(result.model.id, 'brand-new-model');
  assert.equal(result.probabilities['known-free'], 0.1);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.metrics.task_complexity, 0.8);
  assert.equal(result.standalone, 0.05);
  assert.equal(result.trivial, false);
});
test('a high standalone probability routes a greeting to the cheapest model without spending quality', async () => {
  const free = [model('flash-free'), model('pro', { cost: { input: 1.25, output: 10 } })];
  const client = { systemOne: async () => ({ answers: {
    model: { choice: 'pro', probabilities: { 'flash-free': 0.3, pro: 0.7 }, confidence: 0.6 },
    standalone: { noul: 0.95 },
  } }) };
  const result = await new Router({ costWeight: 0.02 }, { client }).route({ prompt: 'Thanks!', contextTokens: 1, models: free });
  assert.equal(result.model.id, 'flash-free');
  assert.equal(result.trivial, true);
  assert.equal(result.reason, 'jev');
  assert.equal(result.probabilities.pro, 0.7);
});
test('an uncertain standalone value stays on the normal Jev distribution path', async () => {
  const free = [model('flash-free'), model('pro', { cost: { input: 1.25, output: 10 } })];
  const client = { systemOne: async () => ({ answers: {
    model: { choice: 'pro', probabilities: { 'flash-free': 0.3, pro: 0.7 }, confidence: 0.6 },
    standalone: { noul: 0.6 },
  } }) };
  const result = await new Router({ costWeight: 0.02 }, { client }).route({ prompt: 'OK', contextTokens: 1, models: free });
  assert.equal(result.model.id, 'pro');
  assert.equal(result.trivial, false);
});
test('request carries a standalone presence judgment separate from the model Choice', () => {
  const request = routingRequest({ prompt: 'Thanks!', contextTokens: 0, models });
  assert.equal(request.questions.standalone.type, 'noul');
  assert.equal(request.state.request, 'Thanks!');
  assert.ok(!('routing_history' in request.state));
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
  assert.equal(result.standalone, null);
});
test('user cancellation never turns into a paid fallback request', async () => {
  await assert.rejects(new Router({}).route({ models }, AbortSignal.abort()), { name: 'AbortError' });
});
test('Jev judges one model-independent effort alongside the model Choice', async () => {
  const request = routingRequest({ prompt: 'debug', contextTokens: 1, models });
  assert.deepEqual(Object.keys(request.questions.effort.criteria), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const answer = (effort) => ({ systemOne: async () => ({ answers: {
    model: { choice: 'known-free', probabilities: { 'known-free': 0.6, 'brand-new-model': 0.4 } },
    effort: { choice: effort },
  } }) });
  assert.equal((await new Router({ costWeight: 0.02 }, { client: answer('high') }).route({ prompt: 'debug', models })).effort, 'high');
  assert.equal((await new Router({ costWeight: 0.02 }, { client: answer('ultra') }).route({ prompt: 'debug', models })).effort, null);
});
test('a mid-turn reassessment asks only effort and lease, never the model', async () => {
  const { effortRequest } = await import('../src/router.mjs');
  const request = effortRequest({ request: 'fix', toolCalls: [{ tool: 'bash', result: 'ok' }], model: models[0], currentEffort: 'low', step: 3 });
  assert.deepEqual(Object.keys(request.questions), ['effort', 'lease']);
  assert.deepEqual(Object.keys(request.questions.lease.criteria), ['1', '2', '5', '10']);
  assert.equal(request.state.session.generation, 3);
  const client = (answers) => ({ systemOne: async () => ({ answers }) });
  const router = (answers) => new Router({ costWeight: 0.02 }, { client: client(answers) });
  assert.deepEqual({ ...(await router({ effort: { choice: 'xhigh' }, lease: { choice: '5' } }).reassess({ request: 'fix' })), elapsedMs: 0 },
    { effort: 'xhigh', lease: 5, elapsedMs: 0 });
  assert.equal((await router({ effort: { choice: 'low' }, lease: { choice: '7' } }).reassess({ request: 'fix' })).lease, 1);
  await assert.rejects(router({ effort: { choice: 'ultra' } }).reassess({ request: 'fix' }));
});
