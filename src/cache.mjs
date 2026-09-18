import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MINUTE } from './config.mjs';

const pending = new Map();

export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Public metadata only. Never cache prompts, credentials, or routing requests. */
export class JsonCache {
  constructor(directory, { fetch: fetchFn = globalThis.fetch, now = Date.now } = {}) {
    this.directory = directory;
    this.fetch = fetchFn;
    this.now = now;
  }

  get(url, { ttl, maxStale, validate, force = false, headers = {}, key = url } = {}) {
    const path = join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
    if (pending.has(path)) return pending.get(path);
    const promise = this.read(url, path, { ttl, maxStale, validate, force, headers }).finally(() => pending.delete(path));
    pending.set(path, promise);
    return promise;
  }

  async read(url, path, { ttl, maxStale, validate, force, headers }) {
    let saved;
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (Number.isFinite(value.checkedAt) && value.checkedAt <= this.now() &&
          (value.value === null || validate(value.value))) saved = value;
    } catch { /* Missing or corrupt cache: fetch again. */ }
    const usable = () => saved?.value != null && this.now() - saved.checkedAt <= maxStale;
    const result = (stale) => ({ value: saved.value, checkedAt: saved.checkedAt, stale });
    if (usable() && !force && this.now() - saved.checkedAt < ttl) return result(false);
    if (saved?.retryAt > this.now()) {
      if (usable()) return result(true);
      throw new Error('Metadata source is temporarily unavailable (cached backoff)');
    }
    let retryMs = 5 * MINUTE;
    try {
      const response = await this.fetch(url, {
        headers: { accept: 'application/json', ...(saved?.etag && saved.value ? { 'if-none-match': saved.etag } : {}), ...headers },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      if (response.status === 304 && saved?.value) {
        saved = { ...saved, checkedAt: this.now(), retryAt: 0 };
      } else {
        if (!response.ok) {
          const after = response.headers.get('retry-after');
          const delay = after == null ? 0 : /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - this.now();
          if (Number.isFinite(delay)) retryMs = Math.max(retryMs, Math.min(delay, 86_400_000));
          await response.body?.cancel();
          throw new Error(`Metadata HTTP ${response.status}`);
        }
        const value = await response.json();
        if (!validate(value)) throw new Error('Invalid metadata response');
        saved = { value, checkedAt: this.now(), etag: response.headers.get('etag'), retryAt: 0 };
      }
      await this.save(path, saved);
      return result(false);
    } catch (error) {
      saved = { value: null, checkedAt: 0, ...saved, retryAt: this.now() + retryMs };
      await this.save(path, saved);
      if (usable()) return result(true);
      throw error;
    }
  }

  async save(path, value) {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicJson(path, value);
    } catch { /* A read-only disk must not prevent live routing. */ }
  }
}
