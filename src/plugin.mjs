import { randomUUID } from 'node:crypto';
import { MODES, settings } from './config.mjs';
import { Runtime, runtimes } from './runtime.mjs';

export default async function JevPlugin({ client }) {
  const runtimeId = randomUUID();
  const runtime = new Runtime(settings(), {
    notify: async (decision) => {
      const p = decision.probabilities?.[decision.model.id];
      const message = decision.reason === 'jev'
        ? `${decision.model.id} · P(meilleur) ${Math.round(p * 100)}%`
        : `${decision.model.id} · secours (${decision.reason.endsWith('missing-typesafe-key') ? 'JEV_API_KEY manquante' : 'Jev indisponible'})`;
      await client.app.log({ body: { service: 'jev', level: 'info', message, extra: {
        sessionID: decision.sessionID, reason: decision.reason, probabilities: decision.probabilities,
        candidates: decision.candidates, metrics: decision.metrics, confidence: decision.confidence,
      } } });
      await client.tui?.showToast({ body: { title: 'Jev', message, variant: 'info', duration: 4500 } });
    },
  });
  runtimes.set(runtimeId, runtime);
  return {
    config: async (config) => {
      runtime.providers = config.provider ?? {};
      config.provider ??= {};
      config.provider.jev = {
        name: 'Jev', npm: new URL('./provider.mjs', import.meta.url).href,
        options: { runtimeId, apiKey: 'jev-local' },
        models: Object.fromEntries(MODES.map((id) => [id, {
          id, name: id, tool_call: true, reasoning: true, attachment: true,
          modalities: { input: ['text', 'image', 'pdf', 'audio', 'video'], output: ['text'] },
          // A conservative UI budget, not a claim about any underlying model.
          limit: { context: 128000, output: 8192 },
        }])),
      };
    },
    'chat.headers': async (input, output) => {
      if (input.model.providerID !== 'jev') return;
      output.headers['x-jev-session'] = input.sessionID;
      output.headers['x-jev-agent'] = input.agent;
      if (input.message?.id) output.headers['x-jev-turn'] = input.message.id;
    },
    event: async ({ event }) => {
      if (event.type === 'session.deleted') runtime.forget(event.properties.info.id);
    },
    dispose: async () => { runtimes.delete(runtimeId); runtime.turns.clear(); runtime.sessions.clear(); },
  };
}
