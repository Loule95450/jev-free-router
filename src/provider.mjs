import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { ENDPOINTS, MODES } from './config.mjs';
import { runtimes, describePrompt } from './runtime.mjs';

function adapter(model, apiKey, fetchFn) {
  const options = { baseURL: ENDPOINTS[model.pool], apiKey: apiKey || 'public', fetch: fetchFn };
  if (model.protocol === '@ai-sdk/anthropic') return createAnthropic(options).languageModel(model.id);
  if (model.protocol === '@ai-sdk/google') return createGoogleGenerativeAI(options).languageModel(model.id);
  return createOpenAICompatible({ ...options, name: 'jev-target', includeUsage: true }).chatModel(model.id);
}

export function createJev({ runtimeId, runtime = runtimes.get(runtimeId), fetch: fetchFn, createAdapter = adapter } = {}) {
  if (!runtime) throw new Error('Jev runtime missing: load the Jev OpenCode plugin');
  const provider = (modelId) => {
    if (!MODES.includes(modelId)) throw new Error(`Unknown Jev model: ${modelId}`);
    const run = async (method, options) => {
      const decision = await runtime.select(modelId, options);
      const model = decision.model;
      const headers = new Headers(options.headers);
      for (const name of [...headers.keys()]) if (name.startsWith('x-jev-') || ['authorization', 'x-api-key'].includes(name)) headers.delete(name);
      headers.set('x-opencode-session', decision.sessionID);
      headers.set('user-agent', 'jev-opencode/0.3.0');
      const target = createAdapter(model, decision.credentials[model.pool], fetchFn);
      const prompt = options.prompt.map((message) => {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
        if (model.protocol !== '@ai-sdk/openai-compatible' || !model.interleaved?.field) return message;
        const reasoning = message.content.filter((p) => p.type === 'reasoning').map((p) => p.text).join('');
        return { ...message, content: message.content.filter((p) => p.type !== 'reasoning'), providerOptions: {
          ...message.providerOptions, openaiCompatible: { [model.interleaved.field]: reasoning },
        } };
      });
      const maxOutputTokens = Math.min(options.maxOutputTokens ?? 4096, model.outputLimit ?? 4096,
        model.context == null ? Infinity : Math.max(1, model.context - describePrompt(options).contextTokens));
      return target[method]({ ...options, prompt, headers: Object.fromEntries(headers), maxOutputTokens,
        ...(model.temperature === false ? { temperature: undefined, topP: undefined, topK: undefined } : {}) });
    };
    return {
      specificationVersion: 'v3', provider: 'jev', modelId,
      supportedUrls: {},
      doGenerate: (options) => run('doGenerate', options),
      doStream: (options) => run('doStream', options),
    };
  };
  provider.specificationVersion = 'v3';
  provider.languageModel = provider;
  return provider;
}
