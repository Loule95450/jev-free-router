import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestEffort, reasoningSettings } from '../src/effort.mjs';
import { model } from './helpers.mjs';

test('the judged effort maps to the lowest supported level that covers it', () => {
  assert.equal(nearestEffort('medium', ['low', 'high', 'max']), 'high');
  assert.equal(nearestEffort('none', ['low', 'high', 'max']), 'low');
  assert.equal(nearestEffort('max', ['low', 'medium', 'high']), 'high');
  assert.equal(nearestEffort('low', ['max']), 'max');
});
test('each Zen protocol receives its own reasoning controls', () => {
  const levels = [{ type: 'effort', values: ['low', 'medium', 'high'] }];
  assert.deepEqual(reasoningSettings(model('deepseek', { reasoningOptions: levels }), 'medium'),
    { effort: 'medium', providerOptions: { openaiCompatible: { reasoningEffort: 'medium' } } });
  assert.deepEqual(reasoningSettings(model('gemini', { protocol: '@ai-sdk/google', reasoningOptions: levels }), 'high').providerOptions,
    { google: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } } });
  assert.deepEqual(reasoningSettings(model('qwen', { protocol: '@ai-sdk/anthropic', reasoningOptions: levels }), 'low').providerOptions,
    { anthropic: { effort: 'low' } });
});
test('budget and toggle models on Messages get bounded budgets or thinking disabled', () => {
  const options = [{ type: 'toggle' }, { type: 'budget_tokens', max: 81920 }];
  const qwen = model('qwen3.6-plus', { protocol: '@ai-sdk/anthropic', reasoningOptions: options, outputLimit: 8192 });
  assert.deepEqual(reasoningSettings(qwen, 'none').providerOptions, { anthropic: { thinking: { type: 'disabled' } } });
  assert.deepEqual(reasoningSettings(qwen, 'max').providerOptions, { anthropic: { thinking: { type: 'enabled', budgetTokens: 8191 } } });
});
test('models without a standard control keep their default and no level is claimed', () => {
  assert.equal(reasoningSettings(model('glm', { reasoningOptions: [{ type: 'toggle' }] }), 'high'), null);
  assert.equal(reasoningSettings(model('minimax', { reasoningOptions: [] }), 'high'), null);
  assert.equal(reasoningSettings(model('unknown'), 'high'), null);
  assert.equal(reasoningSettings(model('x', { reasoningOptions: [{ type: 'effort', values: ['low'] }] }), 'bogus'), null);
});
test('inside a tool loop a Messages model never toggles thinking, but its budget still moves', async () => {
  const { stepSettings } = await import('../src/effort.mjs');
  const qwen = model('qwen', { protocol: '@ai-sdk/anthropic', reasoningOptions: [{ type: 'toggle' }, { type: 'budget_tokens', max: 81920 }], outputLimit: 65536 });
  assert.deepEqual(stepSettings(qwen, 'high', 'none').providerOptions, { anthropic: { thinking: { type: 'disabled' } } });
  assert.equal(stepSettings(qwen, 'high', 'low').providerOptions.anthropic.thinking.budgetTokens, 8192);
  const deepseek = model('deepseek', { reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] });
  assert.equal(stepSettings(deepseek, 'high', 'none').effort, 'high');
});
