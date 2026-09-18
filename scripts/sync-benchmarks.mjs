import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AA_URL, AA_SOURCE, ENDPOINTS, MODELS_URL, aaBase, aaEffort, excluded, finite } from '../src/config.mjs';
import { validSnapshot } from '../src/benchmarks.mjs';

/** Scale of every Artificial Analysis evaluation, so no consumer rescales a score by guessing. */
export const METRICS = {
  artificial_analysis_intelligence_index: { label: 'Artificial Analysis Intelligence Index', scale: 'index_0_100', higherIsBetter: true },
  artificial_analysis_coding_index: { label: 'Artificial Analysis Coding Index', scale: 'index_0_100', higherIsBetter: true },
  artificial_analysis_math_index: { label: 'Artificial Analysis Math Index', scale: 'index_0_100', higherIsBetter: true },
  mmlu_pro: { label: 'MMLU-Pro', scale: 'ratio_0_1', higherIsBetter: true },
  gpqa: { label: 'GPQA Diamond', scale: 'ratio_0_1', higherIsBetter: true },
  hle: { label: "Humanity's Last Exam", scale: 'ratio_0_1', higherIsBetter: true },
  livecodebench: { label: 'LiveCodeBench', scale: 'ratio_0_1', higherIsBetter: true },
  scicode: { label: 'SciCode', scale: 'ratio_0_1', higherIsBetter: true },
  math_500: { label: 'MATH-500', scale: 'ratio_0_1', higherIsBetter: true },
  aime: { label: 'AIME', scale: 'ratio_0_1', higherIsBetter: true },
  aime_25: { label: 'AIME 2025', scale: 'ratio_0_1', higherIsBetter: true },
  ifbench: { label: 'IFBench (instruction following)', scale: 'ratio_0_1', higherIsBetter: true },
  lcr: { label: 'Long Context Reasoning', scale: 'ratio_0_1', higherIsBetter: true },
  terminalbench_hard: { label: 'Terminal-Bench Hard (agentic terminal use)', scale: 'ratio_0_1', higherIsBetter: true },
  terminalbench_v2_1: { label: 'Terminal-Bench v2.1 (agentic terminal use)', scale: 'ratio_0_1', higherIsBetter: true },
  tau2: { label: 'τ²-bench (tool use)', scale: 'ratio_0_1', higherIsBetter: true },
  tau_banking: { label: 'τ-bench Banking (tool use)', scale: 'ratio_0_1', higherIsBetter: true },
};

const numbers = (source) => Object.fromEntries(Object.entries(source ?? {}).filter(([, v]) => finite(v)));

async function json(url, { headers = {} } = {}) {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`${new URL(url).host} HTTP ${response.status}`);
  return response.json();
}

/** Groups Artificial Analysis rows by model identity, keeping every reasoning effort. */
export function indexArtificialAnalysis(rows) {
  const known = new Set(rows.map((row) => row.slug).filter((slug) => typeof slug === 'string'));
  const index = new Map();
  for (const row of rows) {
    if (typeof row.slug !== 'string') continue;
    const [base, effort] = aaEffort(row.slug, known);
    if (!index.has(base)) index.set(base, new Map());
    // A duplicate effort would silently overwrite a sibling: keep the first and move on.
    if (!index.get(base).has(effort)) index.get(base).set(effort, row);
  }
  return index;
}

export function levelOf(row) {
  const evaluations = numbers(row.evaluations);
  const pricing = numbers(row.pricing);
  const throughput = numbers({
    outputTokensPerSecond: row.median_output_tokens_per_second,
    timeToFirstTokenSeconds: row.median_time_to_first_token_seconds,
    timeToFirstAnswerTokenSeconds: row.median_time_to_first_answer_token,
  });
  const level = { aaModelId: row.id, aaSlug: row.slug, label: row.name };
  if (Object.keys(evaluations).length) level.evaluations = evaluations;
  if (Object.keys(pricing).length) level.pricing = pricing;
  if (Object.keys(throughput).length) level.throughput = throughput;
  return level;
}

/** Live Zen catalogues decide which models are worth carrying; Artificial Analysis supplies the scores. */
export function buildModels(zenIds, index) {
  const models = [];
  const skipped = [];
  for (const id of [...new Set(zenIds)].sort()) {
    const base = aaBase(id);
    const variants = index.get(base);
    // A model Artificial Analysis has not measured yet stays out rather than being guessed at.
    if (!variants) { skipped.push(id); continue; }
    const rows = [...variants.entries()];
    const reasoningLevels = Object.fromEntries(rows.map(([effort, row]) => [effort, levelOf(row)]));
    if (!Object.values(reasoningLevels).some((level) => level.evaluations)) { skipped.push(id); continue; }
    const primary = variants.get('default') ?? rows[0][1];
    models.push({
      id, aaBase: base,
      name: primary.name.replace(/\s*\([^()]*\)\s*$/, '').trim() || primary.name,
      creator: primary.model_creator?.name ?? null,
      releaseDate: typeof primary.release_date === 'string' ? primary.release_date : null,
      reasoningLevels,
    });
  }
  return { models, skipped };
}

export async function sync({ output = 'data/benchmarks.json', input, apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY } = {}) {
  if (!input && !apiKey) throw new Error('ARTIFICIAL_ANALYSIS_API_KEY is required to refresh the snapshot');
  // One request covers every model Artificial Analysis publishes: never poll it per model.
  const aa = input ? JSON.parse(await readFile(input, 'utf8')) : await json(AA_URL, { headers: { 'x-api-key': apiKey } });
  if (!Array.isArray(aa.data) || !aa.data.length) throw new Error('Invalid Artificial Analysis response');
  const [metadata, ...catalogues] = await Promise.allSettled([
    json(MODELS_URL), ...Object.values(ENDPOINTS).map((base) => json(`${base}/models`)),
  ]);
  // A model models.dev marks as retired is no longer served: carrying its scores only makes the
  // router consider a candidate the plugin already refuses.
  const retired = new Set(metadata.status === 'fulfilled'
    ? ['opencode', 'opencode-go'].flatMap((id) => Object.entries(metadata.value[id]?.models ?? {})
      .filter(([, model]) => model?.status === 'deprecated').map(([modelId]) => modelId))
    : []);
  const zenIds = catalogues.flatMap((result) => result.status === 'fulfilled' && Array.isArray(result.value?.data)
    ? result.value.data.map((entry) => entry.id)
      .filter((id) => typeof id === 'string' && !excluded(id) && !retired.has(id)) : []);
  if (!zenIds.length) throw new Error('Empty Zen catalogue: preserving existing snapshot');
  const { models, skipped } = buildModels(zenIds, indexArtificialAnalysis(aa.data));
  if (!models.length) throw new Error('No Zen model matched Artificial Analysis: preserving existing snapshot');
  const snapshot = {
    version: 2, generatedAt: new Date().toISOString(),
    source: 'artificial-analysis', sourceUrl: AA_SOURCE,
    metrics: METRICS, models,
  };
  if (!validSnapshot(snapshot)) throw new Error('Invalid generated snapshot');
  let previous;
  try { previous = JSON.parse(await readFile(output, 'utf8')); } catch { /* First run writes a new file. */ }
  const changed = JSON.stringify(previous?.models) !== JSON.stringify(models);
  if (changed) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  return { changed, matched: models.length, skipped, retired: retired.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output = 'data/benchmarks.json', input] = process.argv.slice(2);
  const { changed, matched, skipped, retired } = await sync({ output, input });
  console.log(`${matched} models matched, ${retired} retired dropped, ${skipped.length} skipped (no Artificial Analysis entry): ${skipped.join(', ') || 'none'}`);
  console.log(changed ? `Updated ${output}` : `${output} already current`);
}
