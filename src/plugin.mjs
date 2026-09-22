import { randomUUID } from 'node:crypto';
import { MODES, settings } from './config.mjs';
import { Runtime, runtimes } from './runtime.mjs';

const NAMES = { jev: 'Jev', 'jev-free': 'Jev Free', 'jev-go': 'Jev Go' };

export default async function JevPlugin({ client }) {
  const runtimeId = randomUUID();
  const runtime = new Runtime(settings(), {
    notify: async (decision) => {
      const p = decision.probabilities?.[decision.model.id];
      const route = decision.reason === 'jev'
        ? decision.trivial
          ? `${decision.model.id} · trivial`
          : `${decision.model.id} · P(meilleur) ${Math.round(p * 100)}%`
        : decision.reason.startsWith('retry/')
          ? `${decision.model.id} · repli, ${decision.reason.slice('retry/'.length)}`
          : `${decision.model.id} · secours (${decision.reason.endsWith('missing-typesafe-key') ? 'JEV_API_KEY manquante' : 'Jev indisponible'})`;
      const message = decision.effort ? `${route} · thinking ${decision.effort}` : route;
      await client.app.log({ body: { service: 'jev', level: 'info', message, extra: {
        sessionID: decision.sessionID, reason: decision.reason, error: decision.error, effort: decision.effort, probabilities: decision.probabilities,
        candidates: decision.candidates, metrics: decision.metrics, confidence: decision.confidence,
      } } });
      await client.tui?.showToast({ body: { title: 'Jev', message, variant: 'info', duration: 4500 } });
    },
    onStep: async (event) => {
      const message = event.error
        ? `étape ${event.step} · thinking ${event.effort ?? 'par défaut'} conservé (${event.trigger}, Jev indisponible)`
        : `étape ${event.step} · thinking ${event.previousEffort ?? 'par défaut'} → ${event.effort} · ${event.lease} génération(s) · ${event.trigger}`;
      await client.app.log({ body: { service: 'jev', level: 'info', message, extra: event } });
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
            id, name: NAMES[id] ?? id, tool_call: true, reasoning: true, attachment: true,
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
    dispose: async () => { runtimes.delete(runtimeId); runtime.turns.clear(); runtime.sessions.clear(); runtime.announced.clear(); runtime.steps.clear(); runtime.cooling.clear(); },
  };
}
