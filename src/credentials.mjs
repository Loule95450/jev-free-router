import { readFile } from 'node:fs/promises';

export async function credentials(config, env = process.env, providers = {}) {
  let auth = {};
  try { auth = JSON.parse(env.OPENCODE_AUTH_CONTENT || await readFile(config.authFile, 'utf8')); } catch {}
  const key = (id) => auth[id]?.type === 'api' && typeof auth[id].key === 'string' ? auth[id].key : undefined;
  return {
    free: env.OPENCODE_API_KEY || providers.opencode?.options?.apiKey || key('opencode'),
    go: env.OPENCODE_GO_API_KEY || providers['opencode-go']?.options?.apiKey || key('opencode-go'),
  };
}
