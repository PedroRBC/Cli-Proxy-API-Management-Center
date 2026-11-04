/**
 * Fixed provider → chart slot assignment. Color follows the provider, never its
 * rank, and providers beyond the three named ones fold into "other".
 */

export type SeriesKey = 'codex' | 'claude' | 'gemini' | 'other';
export const SERIES_ORDER: SeriesKey[] = ['codex', 'claude', 'gemini', 'other'];

export function seriesFor(provider: string): SeriesKey {
  const p = provider.toLowerCase();
  if (p === 'codex' || p === 'openai') return 'codex';
  if (p === 'claude' || p === 'anthropic') return 'claude';
  if (p === 'gemini' || p === 'antigravity' || p === 'gemini-cli' || p === 'vertex') {
    return 'gemini';
  }
  return 'other';
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });
const usdWhole = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export const formatTokens = (n: number) => compact.format(n);
export const formatUsd = (n: number) => (Math.abs(n) >= 1000 ? usdWhole : usd).format(n);
