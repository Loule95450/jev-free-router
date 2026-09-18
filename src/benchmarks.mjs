import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AA_URL, DAY, canonical, finite } from './config.mjs';

export function validSnapshot(data) {
  return data?.version === 1 && Number.isFinite(Date.parse(data.generatedAt)) &&
    Array.isArray(data.models) && data.models.every((m) => typeof m.id === 'string' &&
      Array.isArray(m.benchmarks) && m.benchmarks.every((b) => typeof b.name === 'string' &&
        finite(b.score) && typeof b.source === 'string' && (b.date == null || typeof b.date === 'string')));
}

export function publicBenchmarks(model) {
  return (Array.isArray(model?.benchmarks) ? model.benchmarks : []).filter((b) =>
    typeof b.name === 'string' && finite(b.score) && typeof b.source === 'string' &&
    /^https:\/\//.test(b.source) && !/artificial.?analysis/i.test(`${b.name} ${b.source}`) &&
    !/^https:\/\/openrouter.ai\/.*\/benchmarks/.test(b.source));
}

export async function loadBenchmarks(cache, config) {
  const tasks = [cache.get(config.benchmarksUrl, { ttl: DAY, maxStale: 30 * DAY, validate: validSnapshot })];
  if (config.aaKey) tasks.push(cache.get(AA_URL, {
    ttl: DAY, maxStale: 7 * DAY,
    // Separate account caches without saving API keys in filenames or payloads.
    key: `${AA_URL}:${createHash('sha256').update(config.aaKey).digest('hex')}`,
    headers: { 'x-api-key': config.aaKey },
    validate: (v) => Array.isArray(v?.data) && v.data.every((m) => typeof m.id === 'string' && typeof m.slug === 'string'),
  }));
  const [shared, aa] = await Promise.allSettled(tasks);
  let snapshot;
  if (shared.status === 'fulfilled') snapshot = shared.value.value;
  else {
    try { snapshot = JSON.parse(await readFile(new URL('../data/benchmarks.json', import.meta.url), 'utf8')); } catch {}
  }
  const models = validSnapshot(snapshot) ? snapshot.models : [];
  return { models, source: snapshot?.source, aa: aa?.status === 'fulfilled' ? aa.value : null };
}

/** Exact IDs only: no fuzzy version matching and no fabricated benchmark. */
export function benchmarksFor(id, data) {
  const key = canonical(id);
  const matches = data.models.filter((m) => canonical(m.id) === key);
  const publicScores = matches.length === 1 ? matches[0].benchmarks : [];
  const aaMatches = data.aa?.value.data.filter((m) => canonical(m.slug) === key) ?? [];
  const aaScores = aaMatches.length === 1 ? Object.entries(aaMatches[0].evaluations ?? {})
    .filter(([, value]) => finite(value)).map(([name, score]) => ({
      name, score, source: 'https://artificialanalysis.ai/',
      date: new Date(data.aa.checkedAt).toISOString(),
      sourceModelId: aaMatches[0].id,
      dateKind: 'retrieved',
    })) : [];
  return [...publicScores, ...aaScores];
}
