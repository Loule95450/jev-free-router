export const model = (id, extra = {}) => ({
  id, name: id, description: null, pool: 'free', providerID: 'opencode',
  protocol: '@ai-sdk/openai-compatible', context: 200000, outputLimit: 8192, inputLimit: null,
  modalities: ['text'], tools: true, reasoning: true, parameters: null,
  cost: { input: 0, output: 0 }, benchmarks: [], quality: null, metadataSource: null, ...extra,
});
export const snapshot = (models = []) => ({
  version: 2, generatedAt: new Date().toISOString(), source: 'artificial-analysis', metrics: {}, models,
});
export const prompt = (text = 'Fix the tests', turn = 'u1', session = 's1') => ({
  prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
  headers: { 'x-jev-session': session, 'x-jev-turn': turn, 'x-jev-agent': 'build' },
  maxOutputTokens: 8192,
});
