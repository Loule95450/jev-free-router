import { parse } from 'yaml';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, excluded, finite, AA_URL, CANONICAL_MODELS_URL } from '../src/config.mjs';
import { validSnapshot, publicBenchmarks } from '../src/benchmarks.mjs';

export const AIDER_URL = 'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml';

export function fromAider(rows) {
  const models = new Map();
  for (const row of rows) {
    const match = row.command?.match(/(?:^|\s)--model\s+([^\s]+)/);
    if (!match || !finite(row.pass_rate_2) || row.pass_rate_2 > 100 || row.test_cases !== 225) continue;
    const id = canonical(match[1].replace(/^['"]|['"]$/g, ''));
    if (excluded(id)) continue;
    const entry = models.get(id) ?? { id, benchmarks: [] };
    entry.benchmarks.push({
      name: 'aider_polyglot_pass_rate_2', score: row.pass_rate_2, scale: 'percent',
      source: 'https://aider.chat/docs/leaderboards/', date: String(row.date),
      setup: { command: row.command, editFormat: row.edit_format, testCases: row.test_cases,
        reasoningEffort: row.reasoning_effort ?? null, thinkingTokens: row.thinking_tokens ?? null },
    });
    models.set(id, entry);
  }
  return [...models.values()];
}

export function fromArtificialAnalysis(rows) {
  return rows.filter((row) => typeof row.slug === 'string' && !excluded(row.slug, { name: row.model_creator?.name }))
    .map((row) => ({
      id: canonical(row.slug), sourceModelId: row.id,
      benchmarks: Object.entries(row.evaluations ?? {}).filter(([, n]) => finite(n)).map(([name, score]) => ({
        name, score, source: 'https://artificialanalysis.ai/', date: new Date().toISOString(), dateKind: 'retrieved',
      })),
    }));
}

export async function sync({ source = 'models-dev', output = 'data/benchmarks.json', input } = {}) {
  let models;
  if (source === 'artificial-analysis') {
    if (process.env.AA_ALLOW_REDISTRIBUTION !== '1') {
      throw new Error('Artificial Analysis JSON redistribution requires a separate agreement. Set AA_ALLOW_REDISTRIBUTION=1 only when that right has been obtained.');
    }
    if (!process.env.ARTIFICIAL_ANALYSIS_API_KEY) throw new Error('ARTIFICIAL_ANALYSIS_API_KEY is required for the publisher');
    const response = await fetch(AA_URL, { headers: { 'x-api-key': process.env.ARTIFICIAL_ANALYSIS_API_KEY }, signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error(`Artificial Analysis HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.data)) throw new Error('Invalid Artificial Analysis response');
    models = fromArtificialAnalysis(data.data);
  } else if (source === 'models-dev') {
    const data = input ? JSON.parse(await readFile(input, 'utf8')) : await (async () => {
      const response = await fetch(CANONICAL_MODELS_URL, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
      return response.json();
    })();
    models = Object.values(data).filter((m) => typeof m.id === 'string' && !excluded(m.id)).map((m) => ({
      id: m.id, benchmarks: publicBenchmarks(m),
    })).filter((m) => m.benchmarks.length);
  } else if (source === 'aider') {
    const text = input ? await readFile(input, 'utf8') : await (async () => {
      const response = await fetch(AIDER_URL, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new Error(`Aider HTTP ${response.status}`);
      return response.text();
    })();
    const rows = parse(text, { maxAliasCount: 0 });
    if (!Array.isArray(rows)) throw new Error('Invalid Aider benchmark data');
    models = fromAider(rows);
  } else throw new Error('Unknown benchmark source');
  if (!models.length) throw new Error('Empty benchmark response: preserving existing snapshot');
  models.sort((a, b) => a.id.localeCompare(b.id));
  let previous;
  try { previous = JSON.parse(await readFile(output, 'utf8')); } catch {}
  if (previous?.source === source && JSON.stringify(previous.models) === JSON.stringify(models)) return false;
  const snapshot = { version: 1, generatedAt: new Date().toISOString(), source, models };
  if (!validSnapshot(snapshot)) throw new Error('Invalid generated snapshot');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source = 'models-dev', output = 'data/benchmarks.json', input] = process.argv.slice(2);
  await sync({ source, output, input });
}
