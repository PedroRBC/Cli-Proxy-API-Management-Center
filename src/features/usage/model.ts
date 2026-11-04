/**
 * Usage history model: hourly aggregate rows and quota samples.
 *
 * Pure and React-free. Token semantics follow the proxy usage queue: `input`
 * includes cache reads and cache writes, and `total = input + output`.
 * Reasoning tokens are already part of `output`.
 */

import { isRecord } from '@/utils/helpers';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * live            rows collected from this server's usage queue by the panel
 * easycliproxyapi proxy history imported from the local EasyCLIProxyAPI app
 * agents          client transcript totals; overlaps proxy history, never summed with it
 */
export type UsageSource = 'live' | 'easycliproxyapi' | 'agents';
export type AuthKind = 'oauth' | 'apikey';

export interface UsageCounts {
  requests: number;
  failed: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export interface UsageRow extends UsageCounts {
  id: string;
  source: UsageSource;
  /** UTC hour start, epoch ms. */
  hour: number;
  /** Upstream provider; for `agents` rows, the client that wrote the transcript. */
  provider: string;
  model: string;
  authKind: AuthKind;
}

export interface QuotaSample {
  id: string;
  /** Epoch ms of the observation. */
  t: number;
  provider: 'claude' | 'codex';
  /** Credential auth index; never an email or file name. */
  account: string;
  /** Matches the quota card window ids: `five-hour`, `seven-day`, `weekly`, ... */
  windowId: string;
  usedPercent: number;
  resetAtMs: number | null;
}

export const QUOTA_SAMPLE_SLOT_MS = 5 * 60_000;

export const quotaSampleId = (
  provider: QuotaSample['provider'],
  account: string,
  windowId: string,
  slot: number
) => `${provider}|${account}|${windowId}|${slot}`;

const COUNT_KEYS: (keyof UsageCounts)[] = [
  'requests',
  'failed',
  'input',
  'output',
  'reasoning',
  'cacheRead',
  'cacheCreation',
  'total',
];

export const emptyCounts = (): UsageCounts => ({
  requests: 0,
  failed: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
});

export const addCounts = (into: UsageCounts, from: UsageCounts): UsageCounts => {
  for (const key of COUNT_KEYS) into[key] += from[key];
  return into;
};

export const usageRowId = (
  source: UsageSource,
  hour: number,
  provider: string,
  model: string,
  authKind: AuthKind
) => `${source}|${hour}|${provider}|${model}|${authKind}`;

const num = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const str = (value: unknown, max = 160): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/* ---------- live queue records ---------- */

/**
 * Fold raw usage-queue records into hourly rows. Records without a valid
 * timestamp are dropped rather than guessed. Only aggregate counts are kept:
 * API keys, IPs, user agents and error bodies in the record are discarded.
 */
export function aggregateQueueRecords(records: readonly unknown[]): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const record of records) {
    if (!isRecord(record)) continue;
    const at = Date.parse(str(record.timestamp, 64));
    if (!Number.isFinite(at)) continue;
    const tokens = isRecord(record.tokens) ? record.tokens : {};
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
    const provider = str(record.provider) || 'unknown';
    const model = str(record.model) || 'unknown';
    const authKind: AuthKind = str(record.auth_type) === 'apikey' ? 'apikey' : 'oauth';
    const id = usageRowId('live', hour, provider, model, authKind);
    const row =
      rows.get(id) ??
      ({ id, source: 'live', hour, provider, model, authKind, ...emptyCounts() } as UsageRow);
    const input = num(tokens.input_tokens);
    const output = num(tokens.output_tokens);
    addCounts(row, {
      requests: 1,
      failed: record.failed === true ? 1 : 0,
      input,
      output,
      reasoning: num(tokens.reasoning_tokens),
      cacheRead: num(tokens.cache_read_tokens),
      cacheCreation: num(tokens.cache_creation_tokens),
      total: num(tokens.total_tokens) || input + output,
    });
    rows.set(id, row);
  }
  return [...rows.values()];
}

const header = (headers: Record<string, unknown>, name: string): string => {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? str(value[0], 64) : str(value, 64);
  }
  return '';
};

const finite = (raw: string): number | null => {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const CODEX_WINDOW_BY_MINUTES: Record<number, string> = { 300: 'five-hour', 10080: 'weekly' };

/**
 * Quota observations carried in a queue record's upstream rate-limit headers.
 * These cost no extra upstream calls. Claude reports utilization as a 0..1
 * fraction; Codex reports a 0..100 percentage.
 */
export function quotaSamplesFromRecord(record: unknown): QuotaSample[] {
  if (!isRecord(record) || !isRecord(record.response_headers)) return [];
  const t = Date.parse(str(record.timestamp, 64));
  const account = str(record.auth_index, 64);
  if (!Number.isFinite(t) || !account) return [];
  const headers = record.response_headers;
  const provider = str(record.provider);
  const samples: QuotaSample[] = [];
  const push = (
    p: QuotaSample['provider'],
    windowId: string,
    used: number | null,
    resetSec: number | null
  ) => {
    if (used === null || used < 0 || used > 100) return;
    // One sample per account/window per 5 minutes keeps months of history small.
    const slot = Math.floor(t / QUOTA_SAMPLE_SLOT_MS);
    samples.push({
      id: quotaSampleId(p, account, windowId, slot),
      t,
      provider: p,
      account,
      windowId,
      usedPercent: used,
      resetAtMs: resetSec && resetSec > 0 ? resetSec * 1000 : null,
    });
  };

  if (provider === 'claude') {
    for (const [suffix, windowId] of [
      ['5h', 'five-hour'],
      ['7d', 'seven-day'],
    ] as const) {
      const fraction = finite(header(headers, `anthropic-ratelimit-unified-${suffix}-utilization`));
      push(
        'claude',
        windowId,
        fraction === null ? null : Math.round(fraction * 10000) / 100,
        finite(header(headers, `anthropic-ratelimit-unified-${suffix}-reset`))
      );
    }
  } else if (provider === 'codex') {
    for (const slot of ['primary', 'secondary']) {
      const minutes = finite(header(headers, `x-codex-${slot}-window-minutes`));
      const windowId = minutes === null ? null : CODEX_WINDOW_BY_MINUTES[minutes];
      if (!windowId) continue;
      let resetSec = finite(header(headers, `x-codex-${slot}-reset-at`));
      if (resetSec === null) {
        const after = finite(header(headers, `x-codex-${slot}-reset-after-seconds`));
        resetSec = after === null ? null : Math.round(t / 1000 + after);
      }
      push('codex', windowId, finite(header(headers, `x-codex-${slot}-used-percent`)), resetSec);
    }
  }
  return samples;
}

/* ---------- import ---------- */

export const IMPORT_FORMAT = 'cliproxy-usage-history';
const MAX_IMPORT_ROWS = 200_000;
const MIN_HOUR = Date.UTC(2023, 0, 1);
/** One hour of a single provider/model cannot plausibly exceed this. */
const MAX_TOKENS_PER_ROW = 50_000_000_000;

export interface ParsedImport {
  proxy: UsageRow[];
  agents: UsageRow[];
}

/**
 * Validate an export written by `scripts/easycliproxy-usage-export.py`.
 * Throws on anything malformed instead of importing a partial file.
 */
export function parseUsageImport(doc: unknown, nowMs: number): ParsedImport {
  if (!isRecord(doc) || doc.format !== IMPORT_FORMAT || doc.version !== 1) {
    throw new Error('not a cliproxy-usage-history v1 file');
  }
  const proxyIn = Array.isArray(doc.proxy) ? doc.proxy : null;
  const agentsIn = Array.isArray(doc.agents) ? doc.agents : null;
  if (!proxyIn || !agentsIn) throw new Error('missing proxy or agents rows');
  if (proxyIn.length + agentsIn.length > MAX_IMPORT_ROWS) throw new Error('too many rows');

  const convert = (raw: unknown, source: 'easycliproxyapi' | 'agents'): UsageRow => {
    if (!isRecord(raw)) throw new Error('invalid row');
    const hour = raw.hour;
    if (
      typeof hour !== 'number' ||
      !Number.isInteger(hour) ||
      hour % HOUR_MS !== 0 ||
      hour < MIN_HOUR ||
      hour > nowMs + HOUR_MS
    ) {
      throw new Error('row hour out of range');
    }
    const counts = emptyCounts();
    for (const key of COUNT_KEYS) {
      const value = raw[key];
      if (key === 'failed' && value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`invalid ${key}`);
      }
      counts[key] = value;
    }
    if (counts.total > MAX_TOKENS_PER_ROW || counts.input + counts.output !== counts.total) {
      throw new Error('inconsistent token counts');
    }
    const provider = str(source === 'agents' ? raw.agent : raw.provider) || 'unknown';
    const model = str(raw.model) || 'unknown';
    const authKind: AuthKind = raw.authKind === 'apikey' ? 'apikey' : 'oauth';
    return {
      id: usageRowId(source, hour, provider, model, authKind),
      source,
      hour,
      provider,
      model,
      authKind,
      ...counts,
    };
  };

  const merge = (rows: UsageRow[]) => {
    const byId = new Map<string, UsageRow>();
    for (const row of rows) {
      const prev = byId.get(row.id);
      byId.set(row.id, prev ? (addCounts(prev, row) as UsageRow) : row);
    }
    return [...byId.values()];
  };

  return {
    proxy: merge(proxyIn.map((row) => convert(row, 'easycliproxyapi'))),
    agents: merge(agentsIn.map((row) => convert(row, 'agents'))),
  };
}

/* ---------- summaries ---------- */

export type UsageRange = '24h' | '7d' | '30d' | '90d' | 'all';
export const USAGE_RANGES: UsageRange[] = ['24h', '7d', '30d', '90d', 'all'];
const RANGE_MS: Record<Exclude<UsageRange, 'all'>, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
};

export const rangeStartMs = (range: UsageRange, nowMs: number): number =>
  range === 'all' ? 0 : Math.floor((nowMs - RANGE_MS[range]) / HOUR_MS) * HOUR_MS;

export interface ModelPrice {
  /** USD per token. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Estimated list-price cost of a row in USD, or null when the model is unpriced.
 * Cache reads and writes are charged at their own rates, never again as input.
 */
export function rowCost(counts: UsageCounts, price: ModelPrice | null | undefined): number | null {
  if (!price) return null;
  const uncached = Math.max(0, counts.input - counts.cacheRead - counts.cacheCreation);
  return (
    uncached * price.input +
    counts.cacheRead * price.cacheRead +
    counts.cacheCreation * price.cacheWrite +
    counts.output * price.output
  );
}

/** What the cache reads would have cost as uncached input, minus what they cost. */
export function cacheSavings(counts: UsageCounts, price: ModelPrice | null | undefined): number {
  return price ? counts.cacheRead * Math.max(0, price.input - price.cacheRead) : 0;
}

export interface UsageSummary {
  counts: UsageCounts;
  cost: number;
  /** API-key traffic is real spend; OAuth traffic is subscription value. */
  apiKeyCost: number;
  savings: number;
  unpricedTokens: number;
  byProvider: Map<string, { counts: UsageCounts; cost: number }>;
  byModel: Map<string, { provider: string; counts: UsageCounts; cost: number | null }>;
  /** Local day start → provider → cost and tokens. */
  byDay: Map<number, Map<string, { cost: number; tokens: number }>>;
}

export const localDayStart = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);

export function summarizeUsage(
  rows: readonly UsageRow[],
  priceFor: (model: string) => ModelPrice | null,
  dayStart: (ms: number) => number = localDayStart
): UsageSummary {
  const summary: UsageSummary = {
    counts: emptyCounts(),
    cost: 0,
    apiKeyCost: 0,
    savings: 0,
    unpricedTokens: 0,
    byProvider: new Map(),
    byModel: new Map(),
    byDay: new Map(),
  };
  for (const row of rows) {
    const price = priceFor(row.model);
    const cost = rowCost(row, price);
    addCounts(summary.counts, row);
    summary.savings += cacheSavings(row, price);
    if (cost === null) summary.unpricedTokens += row.total;
    else {
      summary.cost += cost;
      if (row.authKind === 'apikey') summary.apiKeyCost += cost;
    }

    const provider = summary.byProvider.get(row.provider) ?? { counts: emptyCounts(), cost: 0 };
    addCounts(provider.counts, row);
    provider.cost += cost ?? 0;
    summary.byProvider.set(row.provider, provider);

    const modelKey = `${row.provider}|${row.model}`;
    const model = summary.byModel.get(modelKey) ?? {
      provider: row.provider,
      counts: emptyCounts(),
      cost: null as number | null,
    };
    addCounts(model.counts, row);
    if (cost !== null) model.cost = (model.cost ?? 0) + cost;
    summary.byModel.set(modelKey, model);

    const day = dayStart(row.hour);
    const dayMap = summary.byDay.get(day) ?? new Map<string, { cost: number; tokens: number }>();
    const cell = dayMap.get(row.provider) ?? { cost: 0, tokens: 0 };
    cell.cost += cost ?? 0;
    cell.tokens += row.total;
    dayMap.set(row.provider, cell);
    summary.byDay.set(day, dayMap);
  }
  return summary;
}
