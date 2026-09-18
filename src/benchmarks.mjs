import { readFile } from 'node:fs/promises';
import { DAY, aaBase, finite } from './config.mjs';

const isLevel = (level) => level && typeof level === 'object' &&
  typeof level.aaSlug === 'string' &&
  [level.evaluations, level.pricing, level.throughput].every((group) =>
    group === undefined || (group && typeof group === 'object' && !Array.isArray(group) &&
      Object.values(group).every((value) => finite(value))));

export function validSnapshot(data) {
  return data?.version === 2 && Number.isFinite(Date.parse(data.generatedAt)) &&
    Array.isArray(data.models) && data.models.every((model) => typeof model.id === 'string' &&
      model.reasoningLevels && typeof model.reasoningLevels === 'object' &&
      Object.values(model.reasoningLevels).every(isLevel));
}

/** Sourced public scores carried by models.dev, kept alongside the Artificial Analysis snapshot. */
export function publicBenchmarks(model) {
  return (Array.isArray(model?.benchmarks) ? model.benchmarks : []).filter((b) =>
    typeof b.name === 'string' && finite(b.score) && typeof b.source === 'string' &&
    /^https:\/\//.test(b.source) && !/^https:\/\/openrouter.ai\/.*\/benchmarks/.test(b.source));
}

/** The published snapshot is the only quality source: the plugin never calls Artificial Analysis. */
export async function loadBenchmarks(cache, config) {
  let snapshot;
  try {
    const result = await cache.get(config.benchmarksUrl, { ttl: DAY, maxStale: 30 * DAY, validate: validSnapshot });
    snapshot = result.value;
  } catch { /* Fall back to the copy shipped with the package. */ }
  if (!validSnapshot(snapshot)) {
    try { snapshot = JSON.parse(await readFile(new URL('../data/benchmarks.json', import.meta.url), 'utf8')); } catch { /* No snapshot at all: quality stays unknown. */ }
  }
  if (!validSnapshot(snapshot)) return { models: new Map(), metrics: {}, generatedAt: null, source: null };
  return {
    models: new Map(snapshot.models.map((model) => [aaBase(model.id), model])),
    metrics: snapshot.metrics ?? {},
    generatedAt: snapshot.generatedAt,
    source: snapshot.source ?? null,
  };
}

/** Exact identities only: no fuzzy version matching and no fabricated score. */
export function qualityFor(id, data) {
  const model = data.models.get(aaBase(id));
  if (!model) return null;
  return {
    name: model.name, creator: model.creator, releaseDate: model.releaseDate,
    measuredAt: data.generatedAt, source: data.source,
    reasoningLevels: model.reasoningLevels,
  };
}
