import { createHash } from 'node:crypto';
import { Catalog, eligible } from './catalog.mjs';
import { JsonCache } from './cache.mjs';
import { credentials } from './credentials.mjs';
import { Router } from './router.mjs';
import { MODES } from './config.mjs';

export const runtimes = new Map();
const ROUTE_LINE = /^Jev (?:→ \S+ · thinking|· thinking) [^\n]+$/;
/** The routing line shown in the chat is for the user only: no model or judgment ever reads it. */
export const isRouteLine = (part) => part.type === 'text' &&
  (part.providerOptions?.jev?.route === true || ROUTE_LINE.test(part.text.trim()));
const textOf = (message) => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter((p) => p.type === 'text' && !isRouteLine(p)).map((p) => p.text).join('\n');

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

const FAILED_OUTPUTS = ['error-text', 'error-json', 'execution-denied'];
const clip = (text, max) => text.length <= max ? text :
  `${text.slice(0, max / 2)}\n[… ${text.length - max} characters omitted …]\n${text.slice(-max / 2)}`;
const outputText = (output) => typeof output?.value === 'string' ? output.value : JSON.stringify(output?.value ?? output?.reason ?? null,
  (k, v) => k === 'data' ? '[attachment]' : v) ?? '';

/**
 * Bounded evidence for a mid-turn effort decision: the request, earlier requests, public text
 * written since, and the last six tool calls with head-and-tail previews. Reasoning is excluded.
 */
export function describeProgress(options) {
  const messages = options.prompt ?? [];
  const userIndex = messages.findLastIndex((m) => m.role === 'user');
  const after = messages.slice(userIndex + 1);
  const calls = new Map();
  for (const message of after) for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part.type === 'tool-call') {
      calls.set(part.toolCallId, { tool: part.toolName, input: clip(JSON.stringify(part.input ?? null), 1000), result: null, failed: false });
    }
    if (part.type === 'tool-result') {
      const call = calls.get(part.toolCallId) ?? { tool: part.toolName, input: null };
      calls.set(part.toolCallId, { ...call, result: clip(outputText(part.output), 4000), failed: FAILED_OUTPUTS.includes(part.output?.type) });
    }
  }
  const last = after.at(-1);
  return {
    request: clip(userIndex < 0 ? '' : textOf(messages[userIndex]), 24000),
    previousRequests: messages.slice(0, Math.max(0, userIndex)).filter((m) => m.role === 'user').slice(-3).map((m) => clip(textOf(m), 2000)),
    progress: after.filter((m) => m.role === 'assistant').map(textOf).filter(Boolean).join('\n').slice(-4000),
    toolCalls: [...calls.values()].slice(-6),
    toolFailed: last?.role === 'tool' && Array.isArray(last.content) &&
      last.content.some((p) => p.type === 'tool-result' && FAILED_OUTPUTS.includes(p.output?.type)),
  };
}

export class Runtime {
  constructor(config, { catalog, router, getCredentials, notify = async () => {}, onStep = async () => {} } = {}) {
    this.config = config;
    this.catalog = catalog ?? new Catalog(new JsonCache(config.cacheDir), config);
    this.router = router ?? new Router(config);
    this.getCredentials = getCredentials ?? (() => credentials(config, process.env, this.providers));
    this.notify = notify;
    this.onStep = onStep;
    this.turns = new Map();
    this.steps = new Map();
    this.cooling = new Map();
    this.sessions = new Map();
    this.announced = new Set();
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
    const step = await this.step(turnKey, decision, options, sessionID);
    return { ...decision, ...step, credentials: creds, sessionID, agent, turnKey, sessionKey };
  }

  /**
   * One call per model generation. The turn's routing fixes the model and the first effort and
   * lease; when the lease runs out or a tool fails, Jev judges the effort of the next generation.
   * Only request parameters change, so the cached prompt prefix survives every switch.
   */
  async step(turnKey, decision, options, sessionID) {
    let state = this.steps.get(turnKey);
    if (!state) {
      state = { step: 0, effort: decision.effort, turnEffort: decision.effort, until: decision.lease ?? 1 };
      this.steps.set(turnKey, state);
      if (this.steps.size > 512) this.steps.delete(this.steps.keys().next().value);
    }
    state.step += 1;
    const previousEffort = state.effort;
    const progress = state.step > 1 ? describeProgress(options) : null;
    // Without a TypeSafe key there is no judgment to renew: every generation keeps the model default.
    if (progress && decision.reason !== 'fallback/missing-typesafe-key' && (state.step > state.until || progress.toolFailed)) {
      const trigger = progress.toolFailed && state.step <= state.until ? 'tool-failure' : 'lease-expired';
      try {
        const next = await this.router.reassess({ ...progress, model: decision.model, currentEffort: state.effort, step: state.step }, options.abortSignal);
        Object.assign(state, { effort: next.effort, until: state.step + next.lease - 1 });
        await this.onStep({ sessionID, turnKey, step: state.step, trigger, previousEffort, effort: next.effort, lease: next.lease, elapsedMs: next.elapsedMs }).catch(() => {});
      } catch (error) {
        options.abortSignal?.throwIfAborted();
        // A failed reassessment keeps the current effort for this generation and asks again next time.
        state.until = state.step;
        await this.onStep({ sessionID, turnKey, step: state.step, trigger, previousEffort, effort: state.effort, error: error.message }).catch(() => {});
      }
    }
    return { effort: state.effort, turnEffort: state.turnEffort, previousEffort, step: state.step, leaseUntil: state.until, pinned: state.model ?? null };
  }

  /**
   * The model that actually answered stays for the rest of the turn: switching back mid-turn
   * would throw away its prompt cache. The session also remembers it for the next routing.
   */
  pin(turnKey, sessionKey, modelId) {
    const state = this.steps.get(turnKey);
    if (state) state.model = modelId;
    if (this.sessions.has(sessionKey)) this.sessions.set(sessionKey, { id: modelId });
  }

  /** A rate-limited or retired model is skipped until its Retry-After, two minutes by default. */
  cool(modelId, error, now = Date.now()) {
    const header = error?.responseHeaders?.['retry-after'];
    const seconds = header == null ? NaN : /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - now) / 1000;
    const ms = Number.isFinite(seconds) ? Math.min(Math.max(seconds * 1000, 30_000), 900_000) : 120_000;
    this.cooling.set(modelId, now + ms);
  }

  isCooling(modelId, now = Date.now()) {
    const until = this.cooling.get(modelId);
    if (until > now) return true;
    this.cooling.delete(modelId);
    return false;
  }

  /** True once per generation key, so a provider-level retry never prints the line twice. */
  announce(key) {
    if (this.announced.has(key)) return false;
    this.announced.add(key);
    if (this.announced.size > 512) this.announced.delete(this.announced.values().next().value);
    return true;
  }

  forget(sessionID) {
    for (const map of [this.sessions, this.turns]) for (const key of map.keys()) if (key.startsWith(`${sessionID}:`)) map.delete(key);
    for (const set of [this.announced, this.steps]) for (const key of set.keys()) if (key.startsWith(`${sessionID}:`)) set.delete(key);
  }
}
