/**
 * List prices for the Usage page: models.dev first, then LiteLLM, cached daily
 * in browser storage. Values are public list prices, used as estimates of what
 * the traffic would cost on the API; they are not billing records.
 */

import { isRecord } from '@/utils/helpers';
import type { ModelPrice } from './model';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const STORAGE_KEY = 'cliproxy-usage-prices-v1';
const MAX_AGE_MS = 24 * 3_600_000;
/** Same model id under several hosts: first-party prices win. */
const PREFERRED_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'deepseek'];

export type PriceTable = Record<string, ModelPrice>;

interface CachedPrices {
  fetchedAt: number;
  prices: PriceTable;
}

const perToken = (value: unknown, scale: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value / scale : null;

/** models.dev: `{ provider: { models: { id: { cost: { input, output, cache_read, cache_write } } } } }`, USD per 1M. */
export function pricesFromModelsDev(doc: unknown): PriceTable {
  const table: PriceTable = {};
  if (!isRecord(doc)) return table;
  const providers = Object.keys(doc).sort((a, b) => {
    const ia = PREFERRED_PROVIDERS.indexOf(a);
    const ib = PREFERRED_PROVIDERS.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  for (const providerId of providers) {
    const provider = doc[providerId];
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isRecord(model) || !isRecord(model.cost)) continue;
      const key = modelId.toLowerCase();
      if (table[key]) continue;
      const input = perToken(model.cost.input, 1e6);
      const output = perToken(model.cost.output, 1e6);
      if (input === null || output === null) continue;
      table[key] = {
        input,
        output,
        cacheRead: perToken(model.cost.cache_read, 1e6) ?? input,
        cacheWrite: perToken(model.cost.cache_write, 1e6) ?? input,
      };
    }
  }
  return table;
}

/** LiteLLM: `{ id: { input_cost_per_token, output_cost_per_token, cache_*_cost } }`, USD per token. */
export function pricesFromLiteLLM(doc: unknown): PriceTable {
  const table: PriceTable = {};
  if (!isRecord(doc)) return table;
  for (const [modelId, model] of Object.entries(doc)) {
    if (!isRecord(model)) continue;
    const input = perToken(model.input_cost_per_token, 1);
    const output = perToken(model.output_cost_per_token, 1);
    if (input === null || output === null) continue;
    const key = modelId.toLowerCase();
    if (table[key]) continue;
    table[key] = {
      input,
      output,
      cacheRead: perToken(model.cache_read_input_token_cost, 1) ?? input,
      cacheWrite: perToken(model.cache_creation_input_token_cost, 1) ?? input,
    };
  }
  return table;
}

/** Name variants tried in order: exact, no `vendor/` prefix, no date suffix, no `-thinking`. */
export function priceLookupKeys(model: string): string[] {
  const keys: string[] = [];
  const add = (key: string) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  const base = model.trim().toLowerCase();
  add(base);
  const noPrefix = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
  add(noPrefix);
  const noDate = noPrefix.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  add(noDate);
  add(noDate.replace(/-thinking$/, ''));
  return keys;
}

export function makePriceLookup(primary: PriceTable, fallback: PriceTable) {
  const memo = new Map<string, ModelPrice | null>();
  return (model: string): ModelPrice | null => {
    const cached = memo.get(model);
    if (cached !== undefined) return cached;
    let found: ModelPrice | null = null;
    for (const key of priceLookupKeys(model)) {
      found = primary[key] ?? fallback[key] ?? null;
      if (found) break;
    }
    memo.set(model, found);
    return found;
  };
}

const readCache = (key: string): CachedPrices | null => {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!isRecord(parsed) || typeof parsed.fetchedAt !== 'number' || !isRecord(parsed.prices)) {
      return null;
    }
    return parsed as unknown as CachedPrices;
  } catch {
    return null;
  }
};

const writeCache = (key: string, value: CachedPrices) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: prices are refetched next time.
  }
};

async function loadTable(
  url: string,
  key: string,
  parse: (doc: unknown) => PriceTable,
  nowMs: number
): Promise<PriceTable> {
  const cached = readCache(key);
  if (cached && nowMs - cached.fetchedAt < MAX_AGE_MS) return cached.prices;
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const prices = parse(await response.json());
    if (Object.keys(prices).length === 0) throw new Error('empty price list');
    writeCache(key, { fetchedAt: nowMs, prices });
    return prices;
  } catch {
    // Offline or blocked: an expired table is better than none.
    return cached?.prices ?? {};
  }
}

export async function loadPriceLookup(nowMs = Date.now()) {
  const [modelsDev, litellm] = await Promise.all([
    loadTable(MODELS_DEV_URL, `${STORAGE_KEY}:models.dev`, pricesFromModelsDev, nowMs),
    loadTable(LITELLM_URL, `${STORAGE_KEY}:litellm`, pricesFromLiteLLM, nowMs),
  ]);
  return {
    lookup: makePriceLookup(modelsDev, litellm),
    available: Object.keys(modelsDev).length + Object.keys(litellm).length > 0,
  };
}
