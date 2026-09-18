// Runs the real CLI against deterministic local fixtures. No LLM network calls.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const directory = await mkdtemp(join(tmpdir(), 'jev-opencode-smoke-'));
try {
  for (const name of ['config/opencode', 'data', 'cache', 'state', 'project']) await mkdir(join(directory, name), { recursive: true });
  const fixturePlugin = join(directory, 'fixture.mjs');
  const capture = join(directory, 'wire.jsonl');
  await writeFile(fixturePlugin, `
    import JevPlugin from ${JSON.stringify(new URL('../src/plugin.mjs', import.meta.url).href)};
    import { runtimes } from ${JSON.stringify(new URL('../src/runtime.mjs', import.meta.url).href)};
    import { model } from ${JSON.stringify(new URL('./helpers.mjs', import.meta.url).href)};
    import { appendFile } from 'node:fs/promises';
    export default async (ctx) => {
      const hooks = await JevPlugin(ctx);
      const configure = hooks.config;
      hooks.config = async (config) => {
        await configure(config);
        const runtime = runtimes.get(config.provider.jev.options.runtimeId);
        runtime.getCredentials = async () => ({});
        runtime.catalog.load = async () => [model('fixture-free')];
        runtime.router.route = async () => ({model:model('fixture-free'), probabilities:{'fixture-free':1}, reason:'jev', candidates:[], metrics:{}, confidence:1});
        config.provider.jev.options.fetch = async (url, init) => {
          if (String(url) !== 'https://opencode.ai/zen/v1/chat/completions') throw new Error('Unexpected inference URL');
          const body = JSON.parse(init.body);
          await appendFile(${JSON.stringify(capture)}, JSON.stringify({body,headers:Object.fromEntries(new Headers(init.headers))})+'\\n');
          const chunk = {id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture-free',choices:[{index:0,delta:{role:'assistant',content:'JEV_SMOKE_OK'},finish_reason:null}]};
          const end = {...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}]};
          return new Response('data: '+JSON.stringify(chunk)+'\\n\\ndata: '+JSON.stringify(end)+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
        };
      };
      return hooks;
    };
  `);
  await writeFile(join(directory, 'config/opencode/opencode.json'), JSON.stringify({
    plugin: [pathToFileURL(fixturePlugin).href], model: 'jev/jev-free', small_model: 'jev/jev-free', enabled_providers: ['jev'],
  }));
  const env = { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
    XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_AUTH_CONTENT: '{}', OPENCODE_TEST_HOME: directory, JEV_CACHE_DIR: join(directory, 'cache/jev'),
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_CONFIG_DIR;
  const run = (args) => {
    const pending = promisify(execFile)('opencode', args, { env, cwd: join(directory, 'project'), timeout: 120000, maxBuffer: 2_000_000 });
    pending.child.stdin.end(); // CLI reads piped stdin before sending the message.
    return pending;
  };
  const { stdout: models } = await run(['models', 'jev']);
  assert.deepEqual(models.trim().split('\n').sort(), ['jev/jev', 'jev/jev-free', 'jev/jev-go']);
  const { stdout, stderr } = await run(['run', '--model', 'jev/jev-free', '--title', 'Jev smoke', '--format', 'json', 'Reply with JEV_SMOKE_OK.']);
  assert.match(stdout, /JEV_SMOKE_OK/, stderr);
  const requests = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(requests.length >= 1);
  assert.ok(requests.every((r) => r.body.model === 'fixture-free'));
  assert.ok(requests.every((r) => r.headers['x-opencode-session'] && r.headers['x-opencode-session'] !== 'auxiliary'));
  console.log('OpenCode CLI: three models registered; user message routed and response streamed successfully.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
