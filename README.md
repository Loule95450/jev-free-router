# Jev for OpenCode

Pick **Jev / jev**, **jev-free** or **jev-go** in `/models`, then chat normally. On every new message, TypeSafe Jev estimates a distribution of **P(best model for this request)** over the exact model IDs in the OpenCode catalogue. The provider shown in the UI stays Jev.

| Choice | Candidates |
| --- | --- |
| `jev/jev` | Free Zen models, plus Go when a Go account is connected |
| `jev/jev-free` | Free Zen models only |
| `jev/jev-go` | Go catalogue; requires a Go connection |

OpenAI and Anthropic models are excluded, even when Go lists them. This repository replaces the former Claude Code / Codex launchers from [jev-router](https://github.com/gargpratyush/jev-router).

## Install from this repository

Requirements: **Node.js 22+** and an OpenCode build speaking AI SDK provider spec v3. Verified against **OpenCode 1.18.31**.

```sh
git clone https://github.com/Loule95450/jev-free-router.git
cd jev-free-router
npm ci
node -e 'console.log(require("node:url").pathToFileURL(process.cwd() + "/src/plugin.mjs").href)'
```

The last command prints a `file://` URL. Add it to the `plugin` list of your `opencode.json` — global config lives at `~/.config/opencode/opencode.json`. Keep your existing plugins and settings:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/jev-free-router/src/plugin.mjs"]
}
```

Paths containing spaces must stay percent-encoded, exactly as the command prints them.

Then set the **TypeSafe brain** key in the environment that launches OpenCode:

```sh
export JEV_API_KEY='your-typesafe-key'
opencode
```

Put the `export` in your shell profile if you want it to persist — OpenCode inherits the environment of the shell that starts it, so a key exported in another terminal will not be visible.

Confirm the install:

```sh
opencode models jev
```

It should print `jev/jev`, `jev/jev-free` and `jev/jev-go`. Select one in `/models` and start chatting.

### What else you need

- **TypeSafe key — required.** Without it the plugin reports an explicit fallback instead of pretending to compute probabilities. This is the **only key you have to provide**: quality scores arrive through a public snapshot, with no benchmark key.
- **Free Zen models — no key needed.** They answer anonymously, as long as the request carries OpenCode's own identity (see below).
- **Go models — a Go account.** Use `/connect` → **OpenCode Go**, or set `OPENCODE_GO_API_KEY`. An existing Zen key is reused when present.

The plugin registers its three models at startup. No proxy to run, no port to open, no model list to maintain. If you use `enabled_providers`, add `jev` to it. Do not load the same plugin through both `plugin` and `.opencode/plugins/`.

### Why it must run inside OpenCode

Zen rejects free-tier calls that do not come from OpenCode, with `OpenCode's free tier can only be used from within OpenCode`. The plugin runs in the OpenCode process and forwards the caller's `User-Agent` untouched, so free models work. Overwriting that header — or routing the same traffic through an external proxy — breaks the free tier. This is why Jev is a plugin rather than a standalone server.

## Dynamic data, with nothing hardcoded

1. **Availability** — official [Zen](https://opencode.ai/zen/v1/models) and [Go](https://opencode.ai/zen/go/v1/models) catalogues. Zen also lists paid models: Jev keeps entries with a known zero price, or new IDs explicitly suffixed `-free`, unless a known price contradicts it.
2. **Context, capabilities, cost** — [models.dev/api.json](https://models.dev/api.json), no key. Go prices are quota consumption costs, not an extra bill. Personal quota balance is not exposed by `/models`.
3. **Public benchmarks** — [models.dev/models.json](https://models.dev/models.json), no key, carrying original sources, versions, dates and test conditions where available.
4. **Measured quality** — `data/benchmarks.json`, a snapshot built by CI from [Artificial Analysis](https://artificialanalysis.ai/) and downloaded independently of the plugin version. It carries, **per reasoning level** (`default`, `xhigh`, `high`, `medium`, `low`, `minimal`, `non-reasoning`), the available evaluations, published prices, and throughput and latency measurements. **The plugin never calls the Artificial Analysis API**: users supply no key for it.

The snapshot declares each metric's scale (`index_0_100` or `ratio_0_1`) in its `metrics` field, passed to Jev so no score is ever compared against a different scale. Scores are never merged into an invented single index.

Models that models.dev marks `status: deprecated` are dropped from both the catalogue and the snapshot. Zen keeps retired models in `/models` but no longer serves them, so routing to one would fail the turn.

A model that appears in the live catalogues becomes a candidate at their next refresh, with no plugin release and without waiting for the GitHub snapshot. A missing benchmark means **unknown**, never zero. Matching uses exact IDs, case-insensitive, without provider prefix, without the `-free` or `-contributor` suffix, and with dots normalised to dashes (`gemini-3.8-flash` ↔ `gemini-3-8-flash`). A suffix counts as a reasoning level only when the bare model is published too: `qwen3.8-max` and `magistral-medium` are model names, not effort variants. No score from an older version is ever attributed to its successor.

Token "size" comes from models.dev. Parameter count is not universally published and does not measure intelligence. With `JEV_FETCH_PARAMETER_COUNTS=1`, Jev also queries the public Hugging Face API for weight repositories linked by models.dev: total safetensors parameters, cached 7 days. For MoE models that total is not the active parameter count. A missing value stays `null`.

## Probabilistic decision

A single System One call carries a `Choice` over the exact IDs, alongside complexity, reasoning and tool scores. Jev receives the latest message (max 24,000 characters), a recent conversation excerpt (max 12,000 characters), the estimated context size and the candidates' metadata. No content is sent to benchmark sources; score requests carry no prompt.

The full distribution returned by TypeSafe is validated and kept. An incomplete or invalid result triggers the fallback. Probabilities are **router estimates**, not a guarantee nor experimentally calibrated success rates.

Selection maximises `P(best model) − cost_weight × estimated_relative_cost`. The weight defaults to `0.02`: price breaks near ties without overriding a strong quality preference. `JEV_COST_WEIGHT=0` disables it. Unknown costs are not treated as free. Overall confidence, probabilities and post-cost utility are separate fields.

Known-too-small contexts and known tool incompatibilities are filtered out. For a non-text attachment, the modality must be known to be supported. A new model with no metadata stays eligible for text requests, with unknown limits. The transport follows the protocol declared by models.dev — OpenAI-compatible, OpenAI Responses, Anthropic or Google SDKs — used **only** to reach **opencode.ai**, never those vendors.

**Adaptive thinking, per generation.** Adapted from [Astra-Ares](https://github.com/miuuyy/Astra-Ares). The routing call also judges the reasoning the first generation needs, on one model-independent ladder (`none` → `max`), and a lease: how many generations (1, 2, 5 or 10) that depth should hold. A generation is one model call, which may emit several tool calls. When the lease runs out, or a tool fails, a small System One call judges the effort of the next generation from bounded evidence: the request, up to three earlier requests, public text written since (never reasoning), and the last six tool calls with 1,000-character inputs and 4,000-character head-and-tail results. Generations inside a lease make no extra call. The model itself never changes inside a message. A failed reassessment keeps the current effort and asks again at the next generation; without a TypeSafe key, models keep their defaults. The transport maps that level onto the chosen model's own `reasoning_options` from models.dev: the lowest supported effort that covers the need (`reasoning_effort` for OpenAI-compatible models, `thinkingLevel` for Gemini, `effort` or a bounded thinking budget for Messages models). A model without a standard control, such as a plain on/off toggle over the OpenAI-compatible API, keeps its default, and no level is claimed. A fallback model maps the level onto its own controls. Messages models never switch thinking on or off inside a tool loop, which their APIs reject; their budget still moves.

**Prompt cache.** The effort only ever travels as a request parameter, never in the system prompt or messages, so the replayed prefix stays byte-identical when the effort changes between generations or messages. Responses models also receive the session as `promptCacheKey`, and every request carries `x-opencode-session`. Switching to a different model still starts a new cache on that model: providers do not share caches.

**In the chat.** The first generation of each message starts with a line such as `Jev → deepseek-v4-flash-free · thinking high`. A later generation shows `Jev · thinking high → low · étape 3 · 2 générations` only when the level applied to that model changes. These lines are removed from the history before any later request, so no model or judgment ever reads it and the cached prefix is unchanged. Titles, summaries and compaction never get it.

The model decision stays fixed across tool loops and network retries within one message. Every new message is re-evaluated; sessions and agents are isolated. Streaming, tools, cancellation and reasoning blocks pass through the native SDKs.

**Fallback to the next candidate.** Zen retires and rate-limits free models without notice. When inference fails, the transport walks down Jev's own ranking, up to three models. Nothing has been streamed at that point, so the retry is invisible; a toast reports it. A failed model (rate limit, retirement, server or network error) cools down until its `Retry-After`, two minutes by default, and is skipped meanwhile unless every candidate is cooling. The model that answered stays pinned for the rest of the message, so a recovering model never steals the turn back and discards the prompt cache; the chat shows `Jev → <model> · … · repli, étape N` when a fallback happens mid-message. A cancelled turn never spends a second model. If TypeSafe itself fails, Jev keeps the previous model when still eligible, otherwise the cheapest known one, with an explicit fallback reason and `null` probabilities.

## Cache and request counts

| Source | Refresh | Failure fallback |
| --- | --- | --- |
| Zen / Go catalogues | Conversation start, then at most every 5 min on new messages | Last catalogue, up to 24 h |
| models.dev metadata and benchmarks | 24 h | Cached up to 7 days |
| GitHub quality snapshot | 24 h | Cached up to 30 days, then the copy shipped in the package |
| Optional Hugging Face parameters | 7 days | Cached up to 30 days |

The cache persists across restarts. Concurrent requests to the same source within a process are shared, ETags are reused, and a failure imposes a backoff before retrying. Two processes started simultaneously with a cold cache may each make one call. No score is refreshed during a tool loop. On the user side, **zero calls** to the Artificial Analysis API.

## Publishing the shared snapshot

`.github/workflows/benchmarks.yml` refreshes `data/benchmarks.json` on `master` daily, with no npm release. It must live on the repository's default branch, with Actions and bot writes enabled. Installations download the public file at most once a day; new models arrive independently.

```sh
ARTIFICIAL_ANALYSIS_API_KEY='...' npm run benchmarks:sync
```

Set the `ARTIFICIAL_ANALYSIS_API_KEY` secret (the maintainer's key) on GitHub:

```sh
gh secret set ARTIFICIAL_ANALYSIS_API_KEY
```

The workflow makes **three requests per day** for all users combined: one to Artificial Analysis, which returns every model it publishes in a single response, and one per Zen catalogue. There is no per-model polling. Models that Zen exposes but Artificial Analysis has not measured are skipped rather than estimated, and retired models are dropped. The key stays in GitHub Secrets; users read the public snapshot. Never commit the key.

Redistributing Artificial Analysis JSON falls under their [terms](https://artificialanalysiscdn.com/legal/ProDataPlatformTerms.pdf): check your rights before making the repository public.

## Configuration

| Variable | Purpose |
| --- | --- |
| `JEV_API_KEY` / `TYPESAFE_API_KEY` | TypeSafe key used for routing |
| `OPENCODE_GO_API_KEY` | Overrides the Go key stored by OpenCode |
| `OPENCODE_API_KEY` | Overrides the Zen key stored by OpenCode |
| `JEV_COST_WEIGHT` | Cost factor between 0 and 1; defaults to `0.02` |
| `JEV_BENCHMARKS_URL` | HTTPS URL of the shared snapshot; defaults to this repository on `master` |
| `JEV_FETCH_PARAMETER_COUNTS` | `1` enables Hugging Face lookups |
| `JEV_CACHE_DIR` | Defaults to `$XDG_CACHE_HOME/jev-opencode` or `~/.cache/jev-opencode` |
| `JEV_AUTH_FILE` | Alternative path to OpenCode's `auth.json` |

The `OPENCODE_AUTH_CONTENT` format and keys declared in OpenCode provider configuration are recognised too. Keys are never written to the cache. This plugin does not load `.env` files.

A toast and the chat line report the model actually used and its thinking level; OpenCode logs carry the distribution and decision criteria, with no prompt text. The context budget advertised for the virtual provider is deliberately conservative (128k); the chosen model's real limits are re-checked at call time. Token estimation is not a per-model tokenizer, and limits remain enforced by the OpenCode server.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `free tier can only be used from within OpenCode` | The request did not carry OpenCode's identity. Run the plugin inside OpenCode, not behind a proxy or `opencode serve`. |
| `Model is unavailable` | The model was retired upstream. Refresh the catalogue, or clear `~/.cache/jev-opencode`. |
| Fallback reported, `null` probabilities | `JEV_API_KEY` is missing from OpenCode's environment, or TypeSafe did not answer in time. |
| `jev` models missing from `/models` | The plugin path is wrong, or `enabled_providers` omits `jev`. |

## Development

```sh
npm ci
npm test
npm run test:opencode # needs the OpenCode binary; LLM servers are stubbed
npm pack --dry-run
```

Tests cover unknown new models, exclusions, probabilities, context constraints, caching and outages, turn isolation, next-candidate fallback, streaming and tools through the real SDKs. They use no real key and consume no inference credit.

MIT, adapted from jev-router. See `NOTICE` for data sources and third-party licences.
