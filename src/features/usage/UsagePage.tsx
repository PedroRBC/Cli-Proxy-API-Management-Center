/**
 * Usage page: estimated API value of proxy traffic from server-kept history.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { IconUpload } from '@/components/ui/icons';
import { useAuthStore, useNotificationStore } from '@/stores';
import { usageHistoryApi } from '@/services/api';
import {
  DAY_MS,
  USAGE_RANGES,
  localDayStart,
  parseUsageImport,
  rangeStartMs,
  summarizeUsage,
  type ModelPrice,
  type UsageRange,
  type UsageRow,
} from './model';
import { loadPriceLookup } from './pricing';
import { SERIES_ORDER, formatTokens, formatUsd, seriesFor, type SeriesKey } from './series';
import { StackedDailyChart, type DailyPoint } from './StackedDailyChart';
import { HISTORY_UPDATED_EVENT } from './useUsageHistoryCollector';
import styles from './UsagePage.module.scss';

type View = 'proxy' | 'agents';
type Metric = 'cost' | 'tokens';
const PREFS_KEY = 'cliproxy-usage-view';
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const readPrefs = (): { range: UsageRange; view: View; metric: Metric } => {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return {
      range: USAGE_RANGES.includes(raw.range) ? raw.range : '30d',
      view: raw.view === 'agents' ? 'agents' : 'proxy',
      metric: raw.metric === 'tokens' ? 'tokens' : 'cost',
    };
  } catch {
    return { range: '30d', view: 'proxy', metric: 'cost' };
  }
};

function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={props.value === option.value}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function UsagePage() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const apiBase = useAuthStore((state) => state.apiBase);
  const [prefs, setPrefs] = useState(readPrefs);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [importedCount, setImportedCount] = useState(0);
  const [priceFor, setPriceFor] = useState<(model: string) => ModelPrice | null>(() => () => null);
  const [pricesReady, setPricesReady] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadRef = useRef(0);

  const updatePrefs = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // Preferences are a convenience only.
    }
  };

  const load = useCallback(async () => {
    if (!apiBase) {
      setLoading(false);
      return;
    }
    const requestId = ++loadRef.current;
    try {
      const { rows: history } = await usageHistoryApi.list();
      if (requestId !== loadRef.current) return;
      setRows(history.filter((row) => row.hour >= rangeStartMs(prefs.range, Date.now())));
      setImportedCount(history.filter((row) => row.source === 'easycliproxyapi').length);
      setLoadError('');
    } catch (err) {
      if (requestId === loadRef.current) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (requestId === loadRef.current) setLoading(false);
    }
  }, [apiBase, prefs.range]);

  useEffect(() => {
    setRows([]);
    setImportedCount(0);
    void load();
    const onUpdate = () => void load();
    window.addEventListener(HISTORY_UPDATED_EVENT, onUpdate);
    const timer = window.setInterval(onUpdate, 60_000);
    return () => {
      loadRef.current += 1;
      window.removeEventListener(HISTORY_UPDATED_EVENT, onUpdate);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    let active = true;
    void loadPriceLookup().then(({ lookup, available }) => {
      if (!active) return;
      setPriceFor(() => lookup);
      setPricesReady(available);
    });
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(
    () => rows.filter((row) => (prefs.view === 'agents') === (row.source === 'agents')),
    [rows, prefs.view]
  );
  const summary = useMemo(() => summarizeUsage(visible, priceFor), [visible, priceFor]);

  const points = useMemo<DailyPoint[]>(() => {
    if (summary.byDay.size === 0) return [];
    const days = [...summary.byDay.keys()];
    const first = Math.min(...days);
    const last = Math.max(...days);
    const out: DailyPoint[] = [];
    // Step by calendar day so empty days still take a slot.
    for (let day = first; day <= last; day = localDayStart(day + DAY_MS + 3_600_000)) {
      const values = Object.fromEntries(SERIES_ORDER.map((key) => [key, 0])) as Record<
        SeriesKey,
        number
      >;
      summary.byDay.get(day)?.forEach((cell, provider) => {
        values[seriesFor(provider)] += prefs.metric === 'cost' ? cell.cost : cell.tokens;
      });
      out.push({ day, values });
    }
    return out;
  }, [summary, prefs.metric]);

  const models = useMemo(
    () =>
      [...summary.byModel.entries()]
        .map(([key, value]) => ({ key, model: key.slice(key.indexOf('|') + 1), ...value }))
        .sort((a, b) =>
          prefs.metric === 'cost'
            ? (b.cost ?? -1) - (a.cost ?? -1) || b.counts.total - a.counts.total
            : b.counts.total - a.counts.total
        ),
    [summary, prefs.metric]
  );

  const providers = useMemo(
    () => [...summary.byProvider.entries()].sort((a, b) => b[1].counts.total - a[1].counts.total),
    [summary]
  );

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !apiBase) return;
    setImporting(true);
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error(t('usage.import_too_large'));
      const document: unknown = JSON.parse(await file.text());
      const parsed = parseUsageImport(document, Date.now());
      await usageHistoryApi.import(document);
      const requests = parsed.proxy.reduce((sum, row) => sum + row.requests, 0);
      showNotification(t('usage.import_success', { count: requests }), 'success');
      await load();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showNotification(t('usage.import_failed', { message }), 'error');
    } finally {
      setImporting(false);
    }
  };

  const c = summary.counts;
  const uncached = Math.max(0, c.input - c.cacheRead - c.cacheCreation);
  const tokenTypes = [
    { key: 'uncached', value: uncached },
    { key: 'cache_read', value: c.cacheRead },
    { key: 'cache_write', value: c.cacheCreation },
    { key: 'output', value: c.output },
  ];
  const tokenMax = Math.max(1, ...tokenTypes.map((item) => item.value));
  const format = prefs.metric === 'cost' ? formatUsd : formatTokens;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.copy}>
          <h1 className={styles.title}>{t('usage.title')}</h1>
          <p className={styles.meta}>
            {t('usage.meta', {
              requests: c.requests.toLocaleString(),
              tokens: formatTokens(c.total),
            })}
          </p>
        </div>
        <div className={styles.actions}>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void handleImport(event)}
          />
          <button
            type="button"
            className={styles.primaryAction}
            disabled={importing || !apiBase}
            onClick={() => fileRef.current?.click()}
          >
            <IconUpload size={14} />
            {importing ? t('usage.importing') : t('usage.import')}
          </button>
        </div>
      </header>

      {loadError && <p role="alert">{t('usage.load_failed', { message: loadError })}</p>}

      <div className={styles.toolbar}>
        <Segmented
          label={t('usage.range_label')}
          value={prefs.range}
          options={USAGE_RANGES.map((range) => ({
            value: range,
            label: t(`usage.range_${range}`),
          }))}
          onChange={(range) => {
            setLoading(true);
            updatePrefs({ range });
          }}
        />
        <Segmented
          label={t('usage.view_label')}
          value={prefs.view}
          options={[
            { value: 'proxy', label: t('usage.view_proxy') },
            { value: 'agents', label: t('usage.view_agents') },
          ]}
          onChange={(view) => updatePrefs({ view })}
        />
        <Segmented
          label={t('usage.metric_label')}
          value={prefs.metric}
          options={[
            { value: 'cost', label: t('usage.metric_cost') },
            { value: 'tokens', label: t('usage.metric_tokens') },
          ]}
          onChange={(metric) => updatePrefs({ metric })}
        />
      </div>

      <p className={styles.note}>
        {prefs.view === 'agents' ? t('usage.note_agents') : t('usage.note_proxy')}{' '}
        {t('usage.note_storage', { count: importedCount })}
        {pricesReady === false && <> {t('usage.prices_unavailable')}</>}
      </p>

      {loading ? (
        <p className={styles.muted}>{t('usage.loading')}</p>
      ) : (
        <>
          <section className={styles.tiles} aria-label={t('usage.totals_label')}>
            <div className={styles.tile}>
              <span>{t('usage.tile_value')}</span>
              <strong>{formatUsd(summary.cost)}</strong>
              <small>{t('usage.tile_value_hint')}</small>
            </div>
            <div className={styles.tile}>
              <span>{t('usage.tile_api_spend')}</span>
              <strong>{formatUsd(summary.apiKeyCost)}</strong>
              <small>{t('usage.tile_api_spend_hint')}</small>
            </div>
            <div className={styles.tile}>
              <span>{t('usage.tile_tokens')}</span>
              <strong>{formatTokens(c.total)}</strong>
              <small>
                {t('usage.tile_requests', {
                  count: c.requests,
                  formatted: c.requests.toLocaleString(),
                })}
              </small>
            </div>
            <div className={styles.tile}>
              <span>{t('usage.tile_savings')}</span>
              <strong>{formatUsd(summary.savings)}</strong>
              <small>{t('usage.tile_savings_hint')}</small>
            </div>
            {summary.unpricedTokens > 0 && (
              <div className={styles.tile}>
                <span>{t('usage.tile_unpriced')}</span>
                <strong>{formatTokens(summary.unpricedTokens)}</strong>
                <small>{t('usage.tile_unpriced_hint')}</small>
              </div>
            )}
          </section>

          <section className={styles.card}>
            <h2>{prefs.metric === 'cost' ? t('usage.daily_cost') : t('usage.daily_tokens')}</h2>
            <StackedDailyChart
              points={points}
              format={format}
              ariaLabel={prefs.metric === 'cost' ? t('usage.daily_cost') : t('usage.daily_tokens')}
            />
          </section>

          <div className={styles.columns}>
            <section className={styles.card}>
              <h2>{t('usage.by_provider')}</h2>
              <ul className={styles.providerList}>
                {providers.map(([provider, value]) => (
                  <li key={provider}>
                    <span
                      className={styles.dot}
                      style={{ background: `var(--series-${seriesFor(provider)})` }}
                    />
                    <span className={styles.providerName}>{provider}</span>
                    <span>{formatTokens(value.counts.total)}</span>
                    <strong>{formatUsd(value.cost)}</strong>
                  </li>
                ))}
              </ul>
            </section>

            <section className={styles.card}>
              <h2>{t('usage.by_token_type')}</h2>
              <ul className={styles.typeList}>
                {tokenTypes.map((item) => (
                  <li key={item.key}>
                    <span>{t(`usage.type_${item.key}`)}</span>
                    <span className={styles.typeBar}>
                      <span style={{ width: `${(item.value / tokenMax) * 100}%` }} />
                    </span>
                    <strong>{formatTokens(item.value)}</strong>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className={styles.card}>
            <h2>{t('usage.by_model')}</h2>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('usage.col_model')}</th>
                    <th scope="col">{t('usage.col_provider')}</th>
                    <th scope="col">{t('usage.col_requests')}</th>
                    <th scope="col">{t('usage.type_uncached')}</th>
                    <th scope="col">{t('usage.type_cache_read')}</th>
                    <th scope="col">{t('usage.type_cache_write')}</th>
                    <th scope="col">{t('usage.type_output')}</th>
                    <th scope="col">{t('usage.col_cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.model}</th>
                      <td>{row.provider}</td>
                      <td>{row.counts.requests.toLocaleString()}</td>
                      <td>
                        {formatTokens(
                          Math.max(
                            0,
                            row.counts.input - row.counts.cacheRead - row.counts.cacheCreation
                          )
                        )}
                      </td>
                      <td>{formatTokens(row.counts.cacheRead)}</td>
                      <td>{formatTokens(row.counts.cacheCreation)}</td>
                      <td>{formatTokens(row.counts.output)}</td>
                      <td>{row.cost === null ? t('usage.unpriced') : formatUsd(row.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
