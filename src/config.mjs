import { homedir } from 'node:os';
import { join } from 'node:path';

export const MODES = ['jev', 'jev-free', 'jev-go'];
export const ENDPOINTS = {
  free: 'https://opencode.ai/zen/v1',
  go: 'https://opencode.ai/zen/go/v1',
};
export const MODELS_URL = 'https://models.dev/api.json';
export const CANONICAL_MODELS_URL = 'https://models.dev/models.json';
export const BENCHMARKS_URL = 'https://raw.githubusercontent.com/Loule95450/jev-free-router/master/data/benchmarks.json';
export const AA_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
export const AA_SOURCE = 'https://artificialanalysis.ai/';
export const DAY = 86_400_000;
export const MINUTE = 60_000;

// Artificial Analysis publishes one entry per reasoning effort, suffixed on the slug.
// Longest first so `-non-reasoning` is not truncated to `-reasoning`.
export const EFFORTS = ['non-reasoning', 'minimal', 'thinking', 'reasoning', 'xhigh', 'medium', 'high', 'low'];

export function settings(env = process.env) {
  const weight = Number(env.JEV_COST_WEIGHT ?? 0.02);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('JEV_COST_WEIGHT must be between 0 and 1');
  return {
    cacheDir: env.JEV_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'jev-opencode'),
    authFile: env.JEV_AUTH_FILE || join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'auth.json'),
    benchmarksUrl: env.JEV_BENCHMARKS_URL || BENCHMARKS_URL,
    typesafeKey: env.JEV_API_KEY || env.TYPESAFE_API_KEY,
    fetchParameterCounts: env.JEV_FETCH_PARAMETER_COUNTS === '1',
    costWeight: weight,
  };
}

export const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export const canonical = (id) => id.split('/').at(-1).replace(/-free$/, '').toLowerCase();
/**
 * Artificial Analysis writes `gemini-3-8-flash` where Zen writes `gemini-3.8-flash`, and Zen
 * serves some models through a `-contributor` alias that Artificial Analysis does not mirror.
 */
export const aaBase = (id) => canonical(id).replace(/-contributor$/, '').replace(/\./g, '-');
/**
 * Splits `grok-4-6-xhigh` into its model identity and its reasoning effort. A suffix only counts
 * when the bare slug is published too: `qwen3-8-max` and `magistral-medium` are model names,
 * not efforts, and splitting them would invent a model that does not exist.
 */
export function aaEffort(slug, known) {
  for (const effort of EFFORTS) {
    if (!slug.endsWith(`-${effort}`)) continue;
    const base = slug.slice(0, -effort.length - 1);
    if (known?.has(base)) return [base, effort];
  }
  return [slug, 'default'];
}
// Exclusion is a provider policy, never a quality ranking or model allowlist.
export function excluded(id, metadata = {}) {
  return /(^|[\s/\-_])(openai|anthropic|claude|gpt|chatgpt|codex)([\s/\-_.\d]|$)|(^|\/)o[134](?:-|$)/i
    .test([id, metadata.name, metadata.family, metadata.owned_by].filter(Boolean).join(' '));
}
