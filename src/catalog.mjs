import { ENDPOINTS, MODELS_URL, CANONICAL_MODELS_URL, DAY, MINUTE, canonical, excluded, finite } from './config.mjs';
import { loadBenchmarks, publicBenchmarks, qualityFor } from './benchmarks.mjs';

const validList = (v) => Array.isArray(v?.data) && v.data.every((m) => typeof m.id === 'string' && m.id.length > 0);
const validMetadata = (v) => v && typeof v === 'object' && v.opencode?.models && typeof v.opencode.models === 'object';
const number = (n) => finite(n) ? n : null;

export class Catalog {
  constructor(cache, config) { this.cache = cache; this.config = config; this.metrics = {}; }

  async load({ force = false, hasGo = false, mode = 'jev' } = {}) {
    const pools = mode === 'jev-free' ? ['free'] : mode === 'jev-go' ? ['go'] : ['free', ...(hasGo ? ['go'] : [])];
    if (mode === 'jev-go' && !hasGo) throw new Error('Connect OpenCode Go with /connect or set OPENCODE_GO_API_KEY');
    const [metadata, canonicalData, benchmarks, ...lists] = await Promise.allSettled([
      this.cache.get(MODELS_URL, { ttl: DAY, maxStale: 7 * DAY, validate: validMetadata }),
      this.cache.get(CANONICAL_MODELS_URL, { ttl: DAY, maxStale: 7 * DAY,
        validate: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some((m) => typeof m?.id === 'string') }),
      loadBenchmarks(this.cache, this.config),
      ...pools.map((pool) => this.cache.get(`${ENDPOINTS[pool]}/models`, { ttl: 5 * MINUTE, maxStale: DAY, force, validate: validList })),
    ]);
    const meta = metadata.status === 'fulfilled' ? metadata.value.value : {};
    const canonicalModels = canonicalData.status === 'fulfilled' ? Object.values(canonicalData.value.value) : [];
    const scores = benchmarks.status === 'fulfilled' ? benchmarks.value : { models: new Map(), metrics: {}, generatedAt: null, source: null };
    // Metric scales are shared by every model: the router explains them once, not per candidate.
    this.metrics = scores.metrics;
    const candidates = [];
    pools.forEach((pool, index) => {
      const list = lists[index];
      if (list.status !== 'fulfilled') return;
      const providerID = pool === 'free' ? 'opencode' : 'opencode-go';
      const provider = meta[providerID];
      for (const entry of list.value.value.data) {
        const exact = provider?.models?.[entry.id];
        const matches = canonicalModels.filter((m) => typeof m.id === 'string' && canonical(m.id) === canonical(entry.id));
        const identity = matches.length === 1 ? matches[0] : null;
        // A free alias may inherit capabilities, but never a different provider's price.
        const capabilities = exact ?? meta.opencode?.models?.[canonical(entry.id)] ?? identity;
        if (excluded(entry.id, { ...capabilities, owned_by: entry.owned_by }) || (identity && excluded(identity.id))) continue;
        // Zen keeps retired models in /models but no longer serves them, and OpenCode hides them.
        // Routing to one fails the whole turn, so a declared retirement removes the candidate.
        if ((exact ?? capabilities)?.status === 'deprecated') continue;
        const freePrice = exact?.cost?.input === 0 && exact?.cost?.output === 0;
        if (pool === 'free' && !entry.id.endsWith('-free') && !freePrice) continue;
        // An explicit nonzero Zen price overrides the naming convention.
        if (pool === 'free' && exact?.cost && !freePrice) continue;
        const protocol = exact?.provider?.npm ?? provider?.npm ?? '@ai-sdk/openai-compatible';
        if (!['@ai-sdk/openai-compatible', '@ai-sdk/anthropic', '@ai-sdk/google'].includes(protocol)) continue;
        const cost = pool === 'free' ? { input: 0, output: 0, cacheRead: 0 } : {
          input: number(exact?.cost?.input), output: number(exact?.cost?.output), cacheRead: number(exact?.cost?.cache_read),
        };
        candidates.push({
          id: entry.id, pool, providerID, protocol,
          name: capabilities?.name ?? entry.id,
          description: capabilities?.description ?? null,
          context: number(capabilities?.limit?.context),
          inputLimit: number(capabilities?.limit?.input),
          outputLimit: number(capabilities?.limit?.output),
          modalities: capabilities?.modalities?.input ?? null,
          tools: typeof capabilities?.tool_call === 'boolean' ? capabilities.tool_call : null,
          reasoning: capabilities?.reasoning ?? null,
          interleaved: capabilities?.interleaved ?? null,
          temperature: capabilities?.temperature ?? null,
          parameters: null,
          weightSource: identity?.weights?.find((w) => /^https:\/\/huggingface.co\/[^/]+\/[^/]+\/?$/.test(w.url))?.url ?? null,
          cost, benchmarks: publicBenchmarks(identity), quality: qualityFor(entry.id, scores),
          metadataSource: capabilities ? (capabilities === identity ? CANONICAL_MODELS_URL : MODELS_URL) : null,
          catalogCheckedAt: list.value.checkedAt,
          catalogStale: list.value.stale,
        });
      }
    });
    // The Choice uses exact API IDs. For duplicate IDs, prefer the free endpoint.
    const unique = new Map();
    for (const model of candidates) if (!unique.has(model.id)) unique.set(model.id, model);
    const result = [...unique.values()];
    if (this.config.fetchParameterCounts) await Promise.all(result.map(async (model) => {
      if (!model.weightSource) return;
      try {
        const url = new URL(model.weightSource);
        const data = await this.cache.get(`https://huggingface.co/api/models${url.pathname.replace(/\/$/, '')}`, {
          ttl: 7 * DAY, maxStale: 30 * DAY,
          validate: (v) => finite(v?.safetensors?.total),
        });
        model.parameters = data.value.safetensors.total;
        model.parametersSource = model.weightSource;
      } catch { /* Undisclosed parameter counts stay unknown. */ }
    }));
    return result;
  }
}

export function eligible(models, { contextTokens = 0, outputTokens = 0, tools = false, modalities = ['text'] } = {}) {
  return models.filter((m) =>
    !(tools && m.tools === false) &&
    (m.context == null || contextTokens + outputTokens <= m.context) &&
    (m.inputLimit == null || contextTokens <= m.inputLimit) &&
    modalities.every((kind) => kind === 'text' || m.modalities?.includes(kind)));
}
