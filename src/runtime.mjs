import { createHash } from 'node:crypto';
import { Catalog, eligible } from './catalog.mjs';
import { JsonCache } from './cache.mjs';
import { credentials } from './credentials.mjs';
import { Router } from './router.mjs';
import { MODES } from './config.mjs';

export const runtimes = new Map();
const textOf = (message) => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');

export function describePrompt(options) {
  const messages = options.prompt ?? [];
  const userIndex = messages.findLastIndex((m) => m.role === 'user');
  const latest = messages[userIndex];
  const prompt = latest ? textOf(latest) : '';
  const modalities = new Set(['text']);
  for (const m of messages) for (const part of Array.isArray(m.content) ? m.content : []) {
    if (part.type === 'file') {
      const type = part.mediaType?.split('/')[0];
      modalities.add(type === 'application' ? 'pdf' : type ?? 'file');
    }
    if (part.type === 'image') modalities.add('image');
  }
  const serialized = JSON.stringify({ messages, tools: options.tools }, (k, v) =>
    k === 'data' || k === 'image' ? '[attachment]' : v);
  const contextTokens = Math.ceil(new TextEncoder().encode(serialized).length / 3) + (modalities.size - 1) * 4096;
  const recentContext = messages.slice(Math.max(0, userIndex - 6), userIndex)
    .filter((m) => ['user', 'assistant'].includes(m.role))
    .map((m) => `${m.role}: ${textOf(m)}`).join('\n').slice(-12000);
  const fallbackTurn = createHash('sha256').update(JSON.stringify(messages.slice(0, userIndex + 1))).digest('hex');
  return { prompt: prompt.slice(-24000), recentContext, contextTokens, modalities: [...modalities],
    tools: Boolean(options.tools?.length), outputTokens: Math.min(options.maxOutputTokens ?? 4096, 4096), fallbackTurn };
}

export class Runtime {
  constructor(config, { catalog, router, getCredentials, notify = async () => {} } = {}) {
    this.config = config;
    this.catalog = catalog ?? new Catalog(new JsonCache(config.cacheDir), config);
    this.router = router ?? new Router(config);
    this.getCredentials = getCredentials ?? (() => credentials(config, process.env, this.providers));
    this.notify = notify;
    this.turns = new Map();
    this.sessions = new Map();
    this.providers = {};
  }

  async select(mode, options) {
    if (!MODES.includes(mode)) throw new Error(`Unknown Jev model: ${mode}`);
    options.abortSignal?.throwIfAborted();
    const headers = new Headers(options.headers);
    const sessionID = headers.get('x-jev-session') ?? 'auxiliary';
    const agent = headers.get('x-jev-agent') ?? 'default';
    const info = describePrompt(options);
    const turn = headers.get('x-jev-turn') ?? info.fallbackTurn;
    const sessionKey = `${sessionID}:${mode}:${agent}`;
    const turnKey = `${sessionKey}:${turn}`;
    const creds = await this.getCredentials();
    if (!this.turns.has(turnKey)) {
      const promise = (async () => {
        const models = await this.catalog.load({ mode, force: !this.sessions.has(sessionKey), hasGo: Boolean(creds.go) });
        options.abortSignal?.throwIfAborted();
        const candidates = eligible(models, info);
        if (!candidates.length) throw new Error('No eligible live model for this Jev mode, context, or attachments');
        const decision = await this.router.route({ ...info, models: candidates, metrics: this.catalog.metrics,
          current: this.sessions.get(sessionKey)?.id }, options.abortSignal);
        this.sessions.delete(sessionKey);
        this.sessions.set(sessionKey, { id: decision.model.id });
        if (this.sessions.size > 256) this.sessions.delete(this.sessions.keys().next().value);
        await this.notify({ ...decision, sessionID }).catch(() => {});
        return decision;
      })();
      this.turns.set(turnKey, promise);
      promise.catch(() => { if (this.turns.get(turnKey) === promise) this.turns.delete(turnKey); });
      if (this.turns.size > 512) this.turns.delete(this.turns.keys().next().value);
    }
    const decision = await this.turns.get(turnKey);
    options.abortSignal?.throwIfAborted();
    if (!eligible([decision.model], info).length) throw new Error('Selected model context or capabilities exhausted during this turn; compact the conversation');
    return { ...decision, credentials: creds, sessionID };
  }

  forget(sessionID) {
    for (const map of [this.sessions, this.turns]) for (const key of map.keys()) if (key.startsWith(`${sessionID}:`)) map.delete(key);
  }
}
