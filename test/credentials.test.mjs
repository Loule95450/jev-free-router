import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { credentials } from '../src/credentials.mjs';

test('reuse OpenCode Zen and Go keys with explicit environment and config precedence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFile = join(dir, 'auth.json');
  await writeFile(authFile, JSON.stringify({ opencode: { type: 'api', key: 'zen-test' }, 'opencode-go': { type: 'api', key: 'go-test' }, openai: { type: 'api', key: 'excluded' } }));
  assert.deepEqual(await credentials({ authFile }, {}), { free: 'zen-test', go: 'go-test' });
  assert.deepEqual(await credentials({ authFile }, { OPENCODE_GO_API_KEY: 'env-go' }, { opencode: { options: { apiKey: 'config-zen' } } }), { free: 'config-zen', go: 'env-go' });
  assert.deepEqual(await credentials({ authFile }, { OPENCODE_AUTH_CONTENT: '{}' }), { free: undefined, go: undefined });
});
