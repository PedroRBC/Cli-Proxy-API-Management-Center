import { describe, expect, test } from 'bun:test';
import {
  HOUR_MS,
  aggregateQueueRecords,
  cacheSavings,
  parseUsageImport,
  quotaSamplesFromRecord,
  rowCost,
  summarizeUsage,
  type UsageRow,
} from '@/features/usage/model';
import {
  makePriceLookup,
  priceLookupKeys,
  pricesFromLiteLLM,
  pricesFromModelsDev,
} from '@/features/usage/pricing';
import { seriesFor } from '@/features/usage/series';

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

const record = (overrides: Record<string, unknown> = {}) => ({
  timestamp: new Date(T0 + 5 * 60_000).toISOString(),
  provider: 'claude',
  model: 'claude-opus-5-5',
  auth_type: 'oauth',
  auth_index: '3',
  api_key: 'sk-secret',
  client_ip: '10.0.0.1',
  failed: false,
  tokens: {
    input_tokens: 1000,
    output_tokens: 200,
    reasoning_tokens: 50,
    cache_read_tokens: 600,
    cache_creation_tokens: 100,
    total_tokens: 1200,
  },
  ...overrides,
});

describe('aggregateQueueRecords', () => {
  test('folds records into hourly rows and keeps only aggregate counts', () => {
    const rows = aggregateQueueRecords([
      record(),
      record({ failed: true }),
      record({ timestamp: 'not a date' }),
      'garbage',
    ]);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.hour).toBe(T0);
    expect(row.requests).toBe(2);
    expect(row.failed).toBe(1);
    expect(row.input).toBe(2000);
    expect(row.cacheRead).toBe(1200);
    expect(row.total).toBe(2400);
    expect(JSON.stringify(row)).not.toContain('sk-secret');
    expect(JSON.stringify(row)).not.toContain('10.0.0.1');
  });

  test('separates API-key traffic from subscription traffic', () => {
    const rows = aggregateQueueRecords([record(), record({ auth_type: 'apikey' })]);
    expect(rows.map((r) => r.authKind).sort()).toEqual(['apikey', 'oauth']);
  });
});

describe('quotaSamplesFromRecord', () => {
  test('reads Claude unified headers as fractions', () => {
    const samples = quotaSamplesFromRecord(
      record({
        response_headers: {
          'Anthropic-Ratelimit-Unified-7d-Utilization': ['0.42'],
          'Anthropic-Ratelimit-Unified-7d-Reset': ['1793900000'],
        },
      })
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      provider: 'claude',
      account: '3',
      windowId: 'seven-day',
      usedPercent: 42,
      resetAtMs: 1793900000 * 1000,
    });
  });

  test('maps Codex windows by length and derives reset from reset-after', () => {
    const samples = quotaSamplesFromRecord(
      record({
        provider: 'codex',
        response_headers: {
          'X-Codex-Primary-Used-Percent': ['12'],
          'X-Codex-Primary-Window-Minutes': ['300'],
          'X-Codex-Primary-Reset-After-Seconds': ['600'],
          'X-Codex-Secondary-Used-Percent': ['77'],
          'X-Codex-Secondary-Window-Minutes': ['10080'],
          'X-Codex-Secondary-Reset-At': ['1794000000'],
        },
      })
    );
    const byWindow = Object.fromEntries(samples.map((s) => [s.windowId, s]));
    expect(byWindow['five-hour'].usedPercent).toBe(12);
    expect(byWindow['five-hour'].resetAtMs).toBe(Math.round((T0 + 5 * 60_000) / 1000 + 600) * 1000);
    expect(byWindow.weekly.usedPercent).toBe(77);
  });

  test('ignores records without an account or headers', () => {
    expect(quotaSamplesFromRecord(record())).toEqual([]);
    expect(
      quotaSamplesFromRecord(record({ auth_index: '', response_headers: { a: ['1'] } }))
    ).toEqual([]);
  });
});

describe('parseUsageImport', () => {
  const doc = {
    format: 'cliproxy-usage-history',
    version: 1,
    proxy: [
      {
        hour: T0,
        provider: 'codex',
        model: 'gpt-6.1-sol',
        authKind: 'oauth',
        requests: 3,
        failed: 1,
        input: 900,
        output: 100,
        reasoning: 40,
        cacheRead: 500,
        cacheCreation: 0,
        total: 1000,
      },
    ],
    agents: [
      {
        hour: T0,
        agent: 'claude',
        model: 'claude-opus-5-5',
        requests: 2,
        input: 300,
        output: 30,
        reasoning: 0,
        cacheRead: 200,
        cacheCreation: 50,
        total: 330,
      },
    ],
  };

  test('accepts a valid export with stable ids', () => {
    const first = parseUsageImport(doc, T0 + HOUR_MS);
    const again = parseUsageImport(doc, T0 + HOUR_MS);
    expect(first.proxy[0].source).toBe('easycliproxyapi');
    expect(first.agents[0].source).toBe('agents');
    expect(first.agents[0].provider).toBe('claude');
    expect(again.proxy.map((r) => r.id)).toEqual(first.proxy.map((r) => r.id));
  });

  test('merges duplicate buckets instead of dropping them', () => {
    const parsed = parseUsageImport({ ...doc, proxy: [doc.proxy[0], doc.proxy[0]] }, T0 + HOUR_MS);
    expect(parsed.proxy).toHaveLength(1);
    expect(parsed.proxy[0].requests).toBe(6);
  });

  test('rejects malformed files', () => {
    expect(() => parseUsageImport({ ...doc, format: 'x' }, T0)).toThrow();
    expect(() =>
      parseUsageImport({ ...doc, proxy: [{ ...doc.proxy[0], total: 5 }] }, T0 + HOUR_MS)
    ).toThrow('inconsistent');
    expect(() =>
      parseUsageImport({ ...doc, proxy: [{ ...doc.proxy[0], hour: T0 + 1 }] }, T0 + HOUR_MS)
    ).toThrow('hour');
    expect(() =>
      parseUsageImport({ ...doc, proxy: [{ ...doc.proxy[0], input: -1, total: 99 }] }, T0 + HOUR_MS)
    ).toThrow();
    // Future rows are refused.
    expect(() => parseUsageImport(doc, T0 - 2 * HOUR_MS)).toThrow('hour');
  });
});

describe('cost', () => {
  const price = { input: 5e-6, output: 25e-6, cacheRead: 0.5e-6, cacheWrite: 6.25e-6 };
  const counts = {
    requests: 1,
    failed: 0,
    input: 1000,
    output: 100,
    reasoning: 10,
    cacheRead: 600,
    cacheCreation: 100,
    total: 1100,
  };

  test('charges cache tokens at their own rate and never again as input', () => {
    // 300 uncached + 600 cache read + 100 cache write + 100 output
    expect(rowCost(counts, price)).toBeCloseTo(
      300 * 5e-6 + 600 * 0.5e-6 + 100 * 6.25e-6 + 100 * 25e-6
    );
    expect(rowCost(counts, null)).toBeNull();
    expect(cacheSavings(counts, price)).toBeCloseTo(600 * 4.5e-6);
  });

  test('summary separates API-key spend and unpriced tokens', () => {
    const row = (over: Partial<UsageRow>): UsageRow => ({
      id: String(Math.random()),
      source: 'live',
      hour: T0,
      provider: 'claude',
      model: 'priced',
      authKind: 'oauth',
      ...counts,
      ...over,
    });
    const summary = summarizeUsage(
      [row({}), row({ authKind: 'apikey' }), row({ model: 'mystery' })],
      (model) => (model === 'priced' ? price : null),
      (ms) => Math.floor(ms / (24 * HOUR_MS)) * 24 * HOUR_MS
    );
    const one = rowCost(counts, price) as number;
    expect(summary.cost).toBeCloseTo(2 * one);
    expect(summary.apiKeyCost).toBeCloseTo(one);
    expect(summary.unpricedTokens).toBe(1100);
    expect(summary.byModel.get('claude|mystery')?.cost).toBeNull();
    expect(summary.byDay.size).toBe(1);
  });
});

describe('pricing', () => {
  test('models.dev prefers first-party providers and scales per million', () => {
    const table = pricesFromModelsDev({
      openrouter: { models: { 'claude-opus-5-5': { cost: { input: 99, output: 99 } } } },
      anthropic: {
        models: {
          'claude-opus-5-5': { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
        },
      },
    });
    expect(table['claude-opus-5-5']).toEqual({
      input: 5e-6,
      output: 25e-6,
      cacheRead: 0.5e-6,
      cacheWrite: 6.25e-6,
    });
  });

  test('LiteLLM fills gaps and name variants resolve', () => {
    const fallback = pricesFromLiteLLM({
      'gpt-6.1-sol': { input_cost_per_token: 1e-6, output_cost_per_token: 8e-6 },
    });
    const lookup = makePriceLookup({}, fallback);
    expect(lookup('openai/gpt-6.1-sol')?.output).toBe(8e-6);
    expect(lookup('unknown-model')).toBeNull();
    expect(priceLookupKeys('anthropic/claude-x-20261001')).toContain('claude-x');
  });

  test('series colors follow the provider, not its rank', () => {
    expect(seriesFor('codex')).toBe('codex');
    expect(seriesFor('antigravity')).toBe('gemini');
    expect(seriesFor('kilo')).toBe('other');
  });
});
