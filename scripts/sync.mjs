#!/usr/bin/env node
/**
 * Syncs LLM model pricing from open-source datasets into cc-router's `pricing.json` (pricingApi: 1).
 *
 * Data sources (in priority order):
 *   1. models.dev (`https://models.dev/api.json`) — primary source for direct & domestic providers
 *   2. OpenRouter (`https://openrouter.ai/api/v1/models`) — live authoritative rates for `openrouter`
 *   3. LiteLLM (`BerriAI/litellm` model_prices_and_context_window.json) — gap-fill for legacy/older snapshots
 *
 * Zero npm dependencies; requires Node.js 20+.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_FILE = join(ROOT, "pricing.json");

const SOURCES = {
  modelsDev: "https://models.dev/api.json",
  openRouter: "https://openrouter.ai/api/v1/models",
  liteLLM: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
};

const MAX_RULES = 5000;
const MAX_PRICE = 1_000_000;
const PROVIDER_RE = /^[a-z0-9_-]{1,60}$/;

/**
 * Mapping from cc-router built-in provider ID -> ordered list of models.dev provider IDs.
 * Earlier entries win when the same model ID exists in multiple upstream buckets.
 */
const MODELS_DEV_MAP = {
  anthropic: ["anthropic"],
  openai: ["openai"],
  openai_codex: ["openai"],
  google_ai_studio: ["google"],
  google_gemini_interactions: ["google"],
  deepseek: ["deepseek"],
  openrouter: ["openrouter"],
  requesty: ["requesty"],
  xai: ["xai"],
  fireworks: ["fireworks-ai"],
  cloudflare: ["cloudflare-workers-ai", "cloudflare-ai-gateway"],
  cloudflare_clef: ["cloudflare-workers-ai", "cloudflare-ai-gateway"],
  alibaba: ["alibaba", "alibaba-cn"],
  zhipu: ["zai", "zhipuai"],
  moonshot: ["moonshotai", "moonshotai-cn"],
  minimax: ["minimax", "minimax-cn"],
  volcengine: ["volcengine"],
  stepfun: ["stepfun-ai", "stepfun"],
  tencent: ["tencent-tokenhub", "tencent-token-plan"],
  xiaomi: ["xiaomi"],
};

/**
 * Gap-fill mapping from LiteLLM `litellm_provider` values -> cc-router provider IDs.
 * Only adds models not already present from models.dev / OpenRouter.
 */
const LITELLM_PROVIDER_MAP = {
  anthropic: ["anthropic"],
  "vertex_ai-anthropic_models": ["anthropic"],
  openai: ["openai", "openai_codex"],
  gemini: ["google_ai_studio", "google_gemini_interactions"],
  vertex_ai: ["google_ai_studio", "google_gemini_interactions"],
  deepseek: ["deepseek"],
  xai: ["xai"],
  fireworks_ai: ["fireworks"],
  dashscope: ["alibaba"],
  zai: ["zhipu"],
  moonshot: ["moonshot"],
  minimax: ["minimax"],
  volcengine: ["volcengine"],
  openrouter: ["openrouter"],
};

/**
 * Canonical first-party providers whose models are mirrored into `provider: "*"`
 * so custom subscriptions, third-party relays, and unmapped aggregators still get accurate estimates.
 * Ordered by precedence (earlier wins on model ID collision).
 */
const WILDCARD_SOURCE_PROVIDERS = [
  "anthropic",
  "openai",
  "google_ai_studio",
  "deepseek",
  "xai",
  "alibaba",
  "zhipu",
  "moonshot",
  "minimax",
  "volcengine",
  "stepfun",
  "xiaomi",
];

function roundPrice(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) return undefined;
  return Number(n.toFixed(6));
}

function isValidProvider(p) {
  return p === "*" || PROVIDER_RE.test(p);
}

function isValidModel(m) {
  if (typeof m !== "string" || m.length === 0 || m.length > 200) return false;
  if (/\s/.test(m)) return false;
  const body = m.endsWith("*") ? m.slice(0, -1) : m;
  return !body.includes("*");
}

function makeRule(provider, model, { input, output, cache_read, cache_write }) {
  if (!isValidProvider(provider) || !isValidModel(model)) return null;
  const inP = roundPrice(input);
  const outP = roundPrice(output);
  if (inP === undefined || outP === undefined) return null;
  const rule = { provider, model, input: inP, output: outP };
  const crP = roundPrice(cache_read);
  const cwP = roundPrice(cache_write);
  if (crP !== undefined) rule.cache_read = crP;
  if (cwP !== undefined) rule.cache_write = cwP;
  return rule;
}

async function fetchJson(url, name) {
  const res = await fetch(url, { headers: { "user-agent": "cc-router-model-pricing-sync" } });
  if (!res.ok) throw new Error(`Failed to fetch ${name} (${url}): HTTP ${res.status}`);
  return res.json();
}

/**
 * Extract normalized price object from a models.dev model entry.
 * Skips pure audio/image/embedding models that lack text token input/output pricing.
 */
function parseModelsDevCost(entry) {
  const c = entry?.cost;
  if (!c || typeof c !== "object") return null;
  if (typeof c.input !== "number" || typeof c.output !== "number") return null;
  return {
    input: c.input,
    output: c.output,
    cache_read: typeof c.cache_read === "number" ? c.cache_read : undefined,
    cache_write: typeof c.cache_write === "number" ? c.cache_write : undefined,
  };
}

/**
 * Strip provider prefix from LiteLLM model keys (e.g. "deepseek/deepseek-chat" -> "deepseek-chat"),
 * while preserving full paths for fireworks ("accounts/fireworks/models/...").
 */
function normalizeLiteLLMModel(rawKey, litellmProvider) {
  if (litellmProvider === "fireworks_ai") {
    return rawKey.replace(/^fireworks_ai\//, "");
  }
  if (litellmProvider === "openrouter") {
    const bare = rawKey.replace(/^openrouter\//, "");
    // Keep standard <vendor>/<model> OpenRouter IDs
    return /^[^/\s:]+\/[^/\s]+$/.test(bare) ? bare : null;
  }
  if (litellmProvider === "vertex_ai") {
    const bare = rawKey.replace(/^vertex_ai\//, "");
    // Only pull Gemini models from vertex_ai (skip partner models / regional routes)
    if (!bare.startsWith("gemini-") || bare.includes("/") || bare.includes(":")) return null;
    return bare;
  }
  if (litellmProvider === "vertex_ai-anthropic_models") {
    const bare = rawKey.replace(/^vertex_ai\//, "").replace("@", "-");
    if (!bare.startsWith("claude-") || bare.includes("/") || bare.includes(":")) return null;
    return bare;
  }
  const prefix = `${litellmProvider}/`;
  const bare = rawKey.startsWith(prefix) ? rawKey.slice(prefix.length) : rawKey;
  // Skip keys that still contain slashes (usually nested regional/cloud routes like us.anthropic.xxx or bedrock/...)
  if (bare.includes("/") || bare.includes(":")) return null;
  return bare;
}

/**
 * Generate helpful aliases for `*` fallback:
 *   1. Dot-version Claude aliases used by relays / Kiro / CheaperInference (e.g. `claude-sonnet-4-5` -> `claude-sonnet-4.5*`)
 *   2. Lowercase MiniMax aliases (e.g. `MiniMax-M2.7` -> `minimax-m2.7*`)
 *   3. Trailing `*` prefix rules for base (non-dated) Claude / Gemini / GPT / DeepSeek / Qwen / GLM / Kimi / Grok models
 */
function buildWildcardAliases(wildcardMap) {
  const extras = [];

  for (const [model, rule] of wildcardMap.entries()) {
    // Skip already-wildcarded or dated snapshot models for prefix generation
    if (model.endsWith("*")) continue;
    const isDated = /-\d{8}$|-\d{4}-\d{2}-\d{2}$|-\d{4}$/.test(model);

    // 1. Claude hyphen <-> dot alias (claude-sonnet-4-5 -> claude-sonnet-4.5 & claude-sonnet-4.5-*)
    const claudeVer = model.match(/^(claude-(?:opus|sonnet|haiku|fable)-)(\d+)-(\d+)$/);
    if (claudeVer) {
      const dotModel = `${claudeVer[1]}${claudeVer[2]}.${claudeVer[3]}`;
      extras.push({ model: dotModel, cost: rule });
      extras.push({ model: `${dotModel}-*`, cost: rule });
      extras.push({ model: `${model}-*`, cost: rule });
    } else if (/^claude-(?:opus|sonnet|haiku|fable)-\d+$/.test(model)) {
      extras.push({ model: `${model}-*`, cost: rule });
    }

    // 2. Lowercase MiniMax alias (MiniMax-M2.7 -> minimax-m2.7)
    if (model.startsWith("MiniMax-")) {
      extras.push({ model: model.toLowerCase(), cost: rule });
    }

    // 3. Prefix fallback for base versions of major non-dated chat families (handles dated snapshots & -thinking suffixes)
    if (
      !isDated &&
      /^(gpt-(?:4o|4\.1|5|6)[\w.-]*|o[134](?:-mini|-pro)?|gemini-(?:2|3|4)[\w.-]*|deepseek-[\w.-]+|grok-[\w.-]+|qwen[\w.-]+|glm-[\w.-]+|kimi-[\w.-]+|doubao-[\w.-]+|step-[\w.-]+|mimo-[\w.-]+)$/.test(
        model,
      )
    ) {
      extras.push({ model: `${model}-*`, cost: rule });
    }
  }

  return extras;
}

async function main() {
  console.log("Fetching pricing data from models.dev, OpenRouter, and LiteLLM...");
  const [modelsDev, openRouter, liteLLM] = await Promise.all([
    fetchJson(SOURCES.modelsDev, "models.dev"),
    fetchJson(SOURCES.openRouter, "OpenRouter"),
    fetchJson(SOURCES.liteLLM, "LiteLLM"),
  ]);

  /** @type {Map<string, { provider: string, model: string, input: number, output: number, cache_read?: number, cache_write?: number }>} */
  const rulesByKey = new Map();
  const stats = { modelsDev: 0, openRouter: 0, liteLLM: 0, wildcardExact: 0, wildcardAlias: 0 };

  function addRule(provider, model, cost, bucket) {
    const key = `${provider}\0${model}`;
    if (rulesByKey.has(key)) return false;
    const rule = makeRule(provider, model, cost);
    if (!rule) return false;
    rulesByKey.set(key, rule);
    if (bucket) stats[bucket]++;
    return true;
  }

  // 1. OpenRouter live API first for `openrouter` (authoritative live pricing)
  for (const item of openRouter?.data ?? []) {
    const p = item?.pricing;
    if (!p) continue;
    const prompt = Number(p.prompt);
    const completion = Number(p.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) continue;
    const cacheRead = p.input_cache_read !== undefined && p.input_cache_read !== null ? Number(p.input_cache_read) * 1e6 : undefined;
    const cacheWrite = p.input_cache_write !== undefined && p.input_cache_write !== null ? Number(p.input_cache_write) * 1e6 : undefined;
    const cost = {
      input: prompt * 1e6,
      output: completion * 1e6,
      cache_read: cacheRead,
      cache_write: cacheWrite,
    };
    addRule("openrouter", item.id, cost, "openRouter");
    // OpenRouter uses dot versions (`anthropic/claude-sonnet-4.5`), while users/examples often pass hyphen (`anthropic/claude-sonnet-4-5`)
    const orClaudeDot = item.id.match(/^(anthropic\/claude-(?:opus|sonnet|haiku|fable)-)(\d+)\.(\d+)$/);
    if (orClaudeDot) {
      addRule("openrouter", `${orClaudeDot[1]}${orClaudeDot[2]}-${orClaudeDot[3]}`, cost, "openRouter");
    }
  }

  // 2. models.dev primary mapping for all built-in cc-router providers
  for (const [ccrProvider, upstreamProviders] of Object.entries(MODELS_DEV_MAP)) {
    for (const up of upstreamProviders) {
      const models = modelsDev?.[up]?.models;
      if (!models || typeof models !== "object") continue;
      for (const [modelId, entry] of Object.entries(models)) {
        const cost = parseModelsDevCost(entry);
        if (!cost) continue;
        addRule(ccrProvider, modelId, cost, "modelsDev");
        // Volcengine models.dev uses `doubao-seed-2-0-code-preview-260215`, while Ark API uses `doubao-seed-2.0-code`
        if (ccrProvider === "volcengine") {
          const doubao = modelId.match(/^(doubao-seed-)(\d+)-(\d+)-([a-z0-9-]+?)(?:-preview)?-\d{6}$/);
          if (doubao) {
            addRule("volcengine", `${doubao[1]}${doubao[2]}.${doubao[3]}-${doubao[4]}`, cost, "modelsDev");
          }
        }
      }
    }
  }

  // 3. LiteLLM gap-fill for legacy / missing snapshots on mapped providers
  for (const [rawKey, entry] of Object.entries(liteLLM ?? {})) {
    if (rawKey === "sample_spec" || !entry || typeof entry !== "object") continue;
    if (entry.mode !== "chat" && entry.mode !== "responses") continue;
    const targetProviders = LITELLM_PROVIDER_MAP[entry.litellm_provider];
    if (!targetProviders) continue;
    if (typeof entry.input_cost_per_token !== "number" || typeof entry.output_cost_per_token !== "number") continue;

    const modelId = normalizeLiteLLMModel(rawKey, entry.litellm_provider);
    if (!modelId) continue;

    const cost = {
      input: entry.input_cost_per_token * 1e6,
      output: entry.output_cost_per_token * 1e6,
      cache_read: typeof entry.cache_read_input_token_cost === "number" ? entry.cache_read_input_token_cost * 1e6 : undefined,
      cache_write: typeof entry.cache_creation_input_token_cost === "number" ? entry.cache_creation_input_token_cost * 1e6 : undefined,
    };

    for (const ccrProvider of targetProviders) {
      addRule(ccrProvider, modelId, cost, "liteLLM");
    }
  }

  // 4. Build `provider: "*"` fallback from canonical first-party providers
  const wildcardSource = new Map();
  for (const provider of WILDCARD_SOURCE_PROVIDERS) {
    for (const rule of rulesByKey.values()) {
      if (rule.provider !== provider) continue;
      if (!wildcardSource.has(rule.model)) {
        wildcardSource.set(rule.model, rule);
      }
    }
  }
  // Also mirror Anthropic/xAI models from OpenRouter into `*` if missing from direct provider (e.g. claude-opus-4.1)
  for (const rule of rulesByKey.values()) {
    if (rule.provider !== "openrouter" || rule.model.includes(":")) continue;
    const m = rule.model.match(/^(?:anthropic|x-ai)\/(.+)$/);
    if (!m) continue;
    const bare = m[1];
    if (!wildcardSource.has(bare)) wildcardSource.set(bare, rule);
  }
  for (const [model, rule] of wildcardSource.entries()) {
    addRule("*", model, rule, "wildcardExact");
  }

  // 5. Add dot-version / lowercase / prefix wildcard aliases into `*`
  for (const { model, cost } of buildWildcardAliases(wildcardSource)) {
    addRule("*", model, cost, "wildcardAlias");
  }

  // Deterministic sort: named providers alphabetically, `*` last; model alphabetically within each provider
  const prices = [...rulesByKey.values()].sort((a, b) => {
    if (a.provider !== b.provider) {
      if (a.provider === "*") return 1;
      if (b.provider === "*") return -1;
      return a.provider.localeCompare(b.provider);
    }
    return a.model.localeCompare(b.model);
  });

  if (prices.length === 0) {
    throw new Error("Generated 0 pricing rules — aborting.");
  }
  if (prices.length > MAX_RULES) {
    throw new Error(`Generated ${prices.length} rules, exceeding cc-router MAX_RULES (${MAX_RULES}).`);
  }

  const output = {
    pricingApi: 1,
    currency: "USD",
    per: 1000000,
    prices,
  };

  writeFileSync(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  // Print summary
  const byProvider = new Map();
  for (const r of prices) byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + 1);
  console.log(`\nWrote ${OUT_FILE} (${prices.length} rules across ${byProvider.size} providers)`);
  console.log("Source breakdown:", stats);
  console.log("Per-provider counts:");
  for (const [p, count] of byProvider.entries()) {
    console.log(`  ${p.padEnd(28)} ${count}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
