// Jev judges how much reasoning the request needs on one model-independent ladder.
// Each model then declares its own controls in models.dev `reasoning_options`.
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_CRITERIA = {
  none: 'No reasoning is needed: the reply is fully determined by the request or explicit, verified facts.',
  minimal: 'An immediate, unambiguous answer or step with almost no inference or comparison.',
  low: 'Routine work or continuation of an established plan: the next useful move and its interpretation are clear, even if the overall task is large.',
  medium: 'Focused reasoning over a few connected facts: compare local alternatives, explain a bounded behavior, or choose a well-scoped implementation or diagnostic step.',
  high: 'Resolve material uncertainty across interacting code paths, competing explanations or design constraints; the answer needs broad understanding or careful correctness analysis.',
  xhigh: 'Difficult synthesis across subsystems or conflicting evidence, with subtle invariants or failure paths; substantial reasoning is needed to discriminate plausible solutions.',
  max: 'Exceptionally demanding reasoning from first principles, a novel algorithm or a proof-like correctness argument. Importance or impressive terminology alone is insufficient.',
};

// A lease counts upcoming generations that keep the chosen effort without asking Jev again.
export const LEASES = [1, 2, 5, 10];
export const LEASE_CRITERIA = {
  1: 'Reassess after the next generation: fresh evidence or a phase boundary could change the reasoning requirement.',
  2: 'A short continuation of two generations is predictable at the same reasoning depth.',
  5: 'An established sequence is likely to need the same reasoning depth for five generations.',
  10: 'A sustained, predictable phase is likely to keep the same reasoning requirement for ten generations.',
};

// Budgets only serve models that expose no named levels. They grow with the ladder.
const BUDGETS = { none: 1024, minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };
const PROVIDER_KEYS = {
  '@ai-sdk/openai-compatible': 'openaiCompatible', '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'google', '@ai-sdk/openai': 'openai',
};

/** The lowest supported level that covers the need; the highest one when the need exceeds them all. */
export function nearestEffort(effort, values) {
  const rank = EFFORTS.indexOf(effort);
  const supported = values.filter((v) => EFFORTS.includes(v)).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  return supported.find((v) => EFFORTS.indexOf(v) >= rank) ?? supported.at(-1) ?? null;
}

function levelOptions(protocol, effort) {
  if (protocol === '@ai-sdk/google') return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } };
  if (protocol === '@ai-sdk/anthropic') return { effort };
  return { reasoningEffort: effort };
}

/**
 * Translates Jev's effort into request options for one exact model, mirroring OpenCode's own
 * variants. Returns null when the model offers no control: its default then applies, and no
 * level is claimed. Everything stays in request parameters, never in the prompt, so the
 * cached prompt prefix is identical whatever effort a turn uses.
 */
export function reasoningSettings(model, effort) {
  const options = model.reasoningOptions;
  const key = PROVIDER_KEYS[model.protocol];
  if (!EFFORTS.includes(effort) || !Array.isArray(options) || !key) return null;
  const levels = options.find((o) => o.type === 'effort' && Array.isArray(o.values));
  if (levels) {
    const applied = nearestEffort(effort, levels.values);
    return applied && { effort: applied, providerOptions: { [key]: levelOptions(model.protocol, applied) } };
  }
  const toggle = options.some((o) => o.type === 'toggle');
  const budget = options.find((o) => o.type === 'budget_tokens');
  if (model.protocol === '@ai-sdk/anthropic') {
    if (toggle && ['none', 'minimal'].includes(effort)) {
      return { effort: 'none', providerOptions: { anthropic: { thinking: { type: 'disabled' } } } };
    }
    if (budget) {
      const ceiling = Math.min(budget.max ?? Infinity, model.outputLimit == null ? Infinity : model.outputLimit - 1);
      const tokens = Math.max(budget.min ?? 1024, Math.min(BUDGETS[effort], ceiling));
      return { effort: `${tokens} tokens`, providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: tokens } } } };
    }
  }
  // OpenAI-compatible toggles and budgets have no standard request field: keep the model default.
  return null;
}

/**
 * Settings for one generation inside a turn. Messages APIs reject switching thinking on or off
 * in the middle of a tool loop, so the turn's first mode sticks there; levels and budgets move.
 */
export function stepSettings(model, effort, turnEffort) {
  const current = reasoningSettings(model, effort);
  if (model.protocol !== '@ai-sdk/anthropic' || !turnEffort || turnEffort === effort) return current;
  const first = reasoningSettings(model, turnEffort);
  const off = (settings) => settings?.providerOptions.anthropic.thinking?.type === 'disabled';
  return off(first) !== off(current) ? first : current;
}

/** Shallow per-provider merge: Jev's reasoning keys win, OpenCode's other options survive. */
export function mergeProviderOptions(base = {}, extra = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra)) merged[key] = { ...base[key], ...value };
  return merged;
}
