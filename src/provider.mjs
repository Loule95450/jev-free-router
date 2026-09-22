import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { ENDPOINTS, MODES } from './config.mjs';
import { runtimes, describePrompt, isRouteLine } from './runtime.mjs';
import { mergeProviderOptions, stepSettings } from './effort.mjs';

// OpenCode's internal agents write titles and summaries: a routing line would pollute them.
const INTERNAL_AGENTS = new Set(['title', 'summary', 'compaction']);

function announced(result, text) {
  let sent = false;
  const emit = (controller) => {
    sent = true;
    const providerMetadata = { jev: { route: true } };
    controller.enqueue({ type: 'text-start', id: 'jev-route', providerMetadata });
    controller.enqueue({ type: 'text-delta', id: 'jev-route', delta: text });
    controller.enqueue({ type: 'text-end', id: 'jev-route', providerMetadata });
  };
  return { ...result, stream: result.stream.pipeThrough(new TransformStream({
    transform(part, controller) {
      if (!sent && part.type !== 'stream-start') emit(controller);
      controller.enqueue(part);
    },
    flush(controller) { if (!sent) emit(controller); },
  })) };
}

/** The first generation names the route; later ones speak only when the applied thinking changes. */
function routeLine(model, decision, reasoning) {
  const applied = reasoning?.effort ?? 'par défaut';
  const step = decision.step ?? 1;
  if (step === 1) return `Jev → ${model.id} · thinking ${applied}${decision.reason?.startsWith('fallback/') ? ' · secours' : ''}`;
  // A mid-turn fallback changes the model, and with it the cache: the user should see it.
  if (model.id !== (decision.pinned ?? decision.model?.id)) return `Jev → ${model.id} · thinking ${applied} · repli, étape ${step}`;
  const before = (decision.previousEffort && stepSettings(model, decision.previousEffort, decision.turnEffort)?.effort) ?? 'par défaut';
  if (before === applied) return null;
  const lease = decision.leaseUntil - step + 1;
  return `Jev · thinking ${before} → ${applied} · étape ${step}${lease > 0 ? ` · ${lease} génération${lease > 1 ? 's' : ''}` : ''}`;
}

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
    const attempt = async (model, decision, method, options) => {
      const headers = new Headers(options.headers);
      for (const name of [...headers.keys()]) if (name.startsWith('x-jev-') || ['authorization', 'x-api-key'].includes(name)) headers.delete(name);
      headers.set('x-opencode-session', decision.sessionID);
      // Never overwrite the caller's User-Agent: this plugin runs inside OpenCode and must keep
      // its host's identity. Overwriting it makes Zen reject the request as an external client.
      const target = createAdapter(model, decision.credentials[model.pool], fetchFn);
      const prompt = options.prompt.map((message) => {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
        message = { ...message, content: message.content.filter((p) => !isRouteLine(p)) };
        if (model.protocol !== '@ai-sdk/openai-compatible' || !model.interleaved?.field) return message;
        const reasoning = message.content.filter((p) => p.type === 'reasoning').map((p) => p.text).join('');
        return { ...message, content: message.content.filter((p) => p.type !== 'reasoning'), providerOptions: {
          ...message.providerOptions, openaiCompatible: { [model.interleaved.field]: reasoning },
        } };
      }).filter((message) => message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length);
      // Effort is resolved per attempt: a fallback model maps Jev's level onto its own controls.
      const reasoning = decision.effort ? stepSettings(model, decision.effort, decision.turnEffort) : null;
      const providerOptions = mergeProviderOptions(options.providerOptions, {
        ...reasoning?.providerOptions,
        // Keeps the Responses prompt cache on one session, as OpenCode does for Zen.
        ...(model.protocol === '@ai-sdk/openai' ? { openai: { ...reasoning?.providerOptions.openai, promptCacheKey: decision.sessionID } } : {}),
      });
      const maxOutputTokens = Math.min(options.maxOutputTokens ?? 4096, model.outputLimit ?? 4096,
        model.context == null ? Infinity : Math.max(1, model.context - describePrompt(options).contextTokens));
      const result = await target[method]({ ...options, prompt, providerOptions, headers: Object.fromEntries(headers), maxOutputTokens,
        ...(model.temperature === false ? { temperature: undefined, topP: undefined, topK: undefined } : {}) });
      if (method !== 'doStream' || INTERNAL_AGENTS.has(decision.agent) || !decision.turnKey) return result;
      const line = routeLine(model, decision, reasoning);
      return line && runtime.announce?.(`${decision.turnKey}#${decision.step ?? 1}`) ? announced(result, line) : result;
    };
    const run = async (method, options) => {
      const decision = await runtime.select(modelId, options);
      // Zen retires and rate-limits free models without warning. Rather than failing the turn,
      // walk down Jev's own ranking. Nothing has been streamed yet, so the retry is invisible.
      const ranked = decision.ranked?.length ? decision.ranked : [decision.model];
      const pinned = ranked.find((m) => m.id === decision.pinned);
      // Within a turn, the model that already answered goes first; otherwise skip cooling models
      // unless every candidate is cooling, then try them anyway rather than failing the turn.
      const ready = ranked.filter((m) => !runtime.isCooling?.(m.id));
      const order = (pinned ? [pinned, ...ranked.filter((m) => m !== pinned)]
        : [...ready, ...ranked.filter((m) => !ready.includes(m))]).slice(0, 3);
      let lastError;
      for (const [index, model] of order.entries()) {
        try {
          const result = await attempt(model, decision, method, options);
          if (decision.turnKey) runtime.pin?.(decision.turnKey, decision.sessionKey, model.id);
          return result;
        } catch (error) {
          options.abortSignal?.throwIfAborted();
          // A cancelled turn is the user's decision, never a reason to spend another model.
          if (error?.name === 'AbortError') throw error;
          lastError = error;
          // Only availability failures cool a model: a malformed request would fail anywhere.
          if (error?.statusCode == null || [404, 408, 429].includes(error.statusCode) || error.statusCode >= 500) runtime.cool?.(model.id, error);
          if (index + 1 < order.length) {
            await runtime.notify({ ...decision, model: order[index + 1], reason: `retry/${model.id}-unavailable`,
              error: [error?.statusCode, String(error?.message ?? error).slice(0, 300)].filter(Boolean).join(' ') }).catch(() => {});
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
