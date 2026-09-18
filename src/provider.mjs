import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { ENDPOINTS, MODES } from './config.mjs';
import { runtimes, describePrompt } from './runtime.mjs';

function adapter(model, apiKey, fetchFn) {
  const options = { baseURL: ENDPOINTS[model.pool], apiKey: apiKey || 'public', fetch: fetchFn };
  if (model.protocol === '@ai-sdk/anthropic') return createAnthropic(options).languageModel(model.id);
  if (model.protocol === '@ai-sdk/google') return createGoogleGenerativeAI(options).languageModel(model.id);
  // models.dev marks a few Zen models as Responses-only; they 404 on /chat/completions.
  if (model.protocol === '@ai-sdk/openai') return createOpenAI(options).responses(model.id);
  return createOpenAICompatible({ ...options, name: 'jev-target', includeUsage: true }).chatModel(model.id);
}

export function createJev({ runtimeId, runtime = runtimes.get(runtimeId), fetch: fetchFn, createAdapter = adapter } = {}) {
  if (!runtime) throw new Error('Jev runtime missing: load the Jev OpenCode plugin');
  const provider = (modelId) => {
    if (!MODES.includes(modelId)) throw new Error(`Unknown Jev model: ${modelId}`);
    const attempt = (model, decision, method, options) => {
      const headers = new Headers(options.headers);
      for (const name of [...headers.keys()]) if (name.startsWith('x-jev-') || ['authorization', 'x-api-key'].includes(name)) headers.delete(name);
      headers.set('x-opencode-session', decision.sessionID);
      // Never overwrite the caller's User-Agent: this plugin runs inside OpenCode and must keep
      // its host's identity. Overwriting it makes Zen reject the request as an external client.
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
    const run = async (method, options) => {
      const decision = await runtime.select(modelId, options);
      // Zen retires and rate-limits free models without warning. Rather than failing the turn,
      // walk down Jev's own ranking. Nothing has been streamed yet, so the retry is invisible.
      const order = (decision.ranked?.length ? decision.ranked : [decision.model]).slice(0, 3);
      let lastError;
      for (const [index, model] of order.entries()) {
        try {
          return await attempt(model, decision, method, options);
        } catch (error) {
          options.abortSignal?.throwIfAborted();
          // A cancelled turn is the user's decision, never a reason to spend another model.
          if (error?.name === 'AbortError') throw error;
          lastError = error;
          if (index + 1 < order.length) {
            await runtime.notify({ ...decision, model: order[index + 1], reason: `retry/${model.id}-unavailable` }).catch(() => {});
          }
        }
      }
      throw lastError;
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
