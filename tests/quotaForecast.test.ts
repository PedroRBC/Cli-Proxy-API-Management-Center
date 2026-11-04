import { describe, expect, test } from 'bun:test';
import type { QuotaSample } from '@/features/usage/model';
import { HOUR_MS, burnRate, history, project } from '@/features/quota/forecast/forecastModel';
import { currentAccounts, dollarsPerPoint } from '@/features/quota/forecast/forecastData';
import { parseCodexResetFeed } from '@/features/quota/forecast/codexResets';

const NOW = Date.UTC(2026, 10, 4, 12);
const WEEK = 7 * 24 * HOUR_MS;

const sample = (
  t: number,
  used: number,
  account = 'a',
  resetAtMs: number | null = null
): QuotaSample => ({
  id: `${account}|${t}`,
  t,
  provider: 'claude',
  account,
  windowId: 'seven-day',
  usedPercent: used,
  resetAtMs,
});

describe('burnRate', () => {
  test('sums increases per hour and skips reset drops', () => {
    const samples = [
      sample(NOW - 4 * HOUR_MS, 10),
      sample(NOW - 3 * HOUR_MS, 30),
      sample(NOW - 2 * HOUR_MS, 0), // reset
      sample(NOW, 20),
    ];
    const burn = burnRate(samples, NOW, 24 * HOUR_MS);
    expect(burn?.consumed).toBe(40);
    expect(burn?.perHour).toBeCloseTo(10);
  });

  test('needs at least 30 minutes of history', () => {
    expect(burnRate([sample(NOW - 10 * 60_000, 1), sample(NOW, 2)], NOW, HOUR_MS)).toBeNull();
    expect(burnRate([sample(NOW, 2)], NOW, HOUR_MS)).toBeNull();
  });
});

describe('project', () => {
  const account = (used: number, resetAtMs: number | null, name = 'a') => ({
    account: name,
    usedPercent: used,
    resetAtMs,
    periodMs: WEEK,
  });

  test('runs a single account dry at its burn rate', () => {
    const result = project(
      [{ id: 'claude', accounts: [account(50, null)], burnPerHour: 10, weight: 1 }],
      NOW,
      WEEK,
      1
    );
    expect(result.firstEmptyAt).toBe(NOW + 5 * HOUR_MS);
    expect(result.poolEmptyAt).toBe(NOW + 5 * HOUR_MS);
  });

  test('refills at the reset and reports the next reset', () => {
    const reset = NOW + 2 * HOUR_MS;
    const result = project(
      [{ id: 'claude', accounts: [account(90, reset)], burnPerHour: 1, weight: 1 }],
      NOW,
      WEEK,
      1
    );
    expect(result.nextResetAt).toBe(reset);
    expect(result.points[2].remaining).toBeCloseTo(100 - 1);
  });

  test('spills demand from a dry account onto the others', () => {
    const result = project(
      [
        {
          id: 'claude',
          accounts: [account(95, null, 'a'), account(0, null, 'b')],
          burnPerHour: 20,
          weight: 1,
        },
      ],
      NOW,
      WEEK,
      1
    );
    // Hour 1: 10 each, `a` only has 5 → its other 5 moves to `b`.
    expect(result.points[1].accounts['claude|a']).toBe(0);
    expect(result.points[1].accounts['claude|b']).toBe(85);
    expect(result.firstEmptyAt).toBe(NOW + HOUR_MS);
  });

  test('without a burn rate there is no exhaustion estimate', () => {
    const result = project(
      [{ id: 'codex', accounts: [account(10, null)], burnPerHour: null, weight: 1 }],
      NOW,
      WEEK,
      1
    );
    expect(result.burnPerHour).toBeNull();
    expect(result.poolEmptyAt).toBeNull();
  });
});

describe('history and current state', () => {
  test('a window past its reset counts as refilled', () => {
    const samples = [sample(NOW - 3 * HOUR_MS, 80, 'a', NOW - HOUR_MS)];
    const past = history(samples, ['a'], NOW - 3 * HOUR_MS, NOW);
    expect(past[0].remaining).toBe(20);
    expect(past[past.length - 1].remaining).toBe(100);
    const [state] = currentAccounts(samples, NOW);
    expect(state.usedPercent).toBe(0);
    expect(state.resetAtMs).toBe(NOW - HOUR_MS + WEEK);
  });

  test('dollar weights use only subscription rows of the provider', () => {
    const price = { input: 1e-6, output: 1e-6, cacheRead: 1e-6, cacheWrite: 1e-6 };
    const base = {
      hour: NOW - HOUR_MS,
      model: 'm',
      requests: 1,
      failed: 0,
      input: 1_000_000,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 1_000_000,
    };
    const rows = [
      { ...base, id: '1', source: 'live' as const, provider: 'claude', authKind: 'oauth' as const },
      {
        ...base,
        id: '2',
        source: 'live' as const,
        provider: 'claude',
        authKind: 'apikey' as const,
      },
      {
        ...base,
        id: '3',
        source: 'agents' as const,
        provider: 'claude',
        authKind: 'oauth' as const,
      },
    ];
    expect(dollarsPerPoint('claude', rows, 2, NOW - 24 * HOUR_MS, () => price)).toBeCloseTo(0.5);
    expect(dollarsPerPoint('claude', rows, 0, NOW - 24 * HOUR_MS, () => price)).toBeNull();
  });
});

describe('codex reset feed', () => {
  test('parses events newest first and drops unsafe links', () => {
    const feed = parseCodexResetFeed({
      scheduled: { reset_at: '2026-11-06T00:00:00Z', display_text: 'Global reset' },
      events: [
        {
          announced_at: '2026-11-01T00:00:00Z',
          reset_type: 'banked',
          display_text: 'a',
          tweet_url: 'javascript:alert(1)',
        },
        {
          announced_at: '2026-11-02T00:00:00Z',
          reset_type: 'regular',
          display_text: 'b',
          tweet_url: 'https://x.com/a/status/1',
        },
        { announced_at: 'nope' },
      ],
    });
    expect(feed?.events.map((e) => e.text)).toEqual(['b', 'a']);
    expect(feed?.events[1].url).toBeNull();
    expect(feed?.scheduledAt).toBe(Date.parse('2026-11-06T00:00:00Z'));
    expect(parseCodexResetFeed({ nope: true })).toBeNull();
  });
});
