import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SERIES_ORDER, type SeriesKey } from './series';
import styles from './StackedDailyChart.module.scss';

export interface DailyPoint {
  day: number;
  values: Record<SeriesKey, number>;
}

interface Props {
  points: DailyPoint[];
  format: (value: number) => string;
  ariaLabel: string;
}

const W = 720;
const H = 200;
const GAP = 2;
const RADIUS = 4;

/** Rectangle with rounded top corners only (the data end), square at the baseline side. */
const topRounded = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

export function StackedDailyChart({ points, format, ariaLabel }: Props) {
  const { t, i18n } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const present = useMemo(
    () => SERIES_ORDER.filter((key) => points.some((p) => p.values[key] > 0)),
    [points]
  );
  const max = useMemo(
    () => Math.max(0, ...points.map((p) => present.reduce((sum, key) => sum + p.values[key], 0))),
    [points, present]
  );
  const dayLabel = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }),
    [i18n.language]
  );

  if (points.length === 0 || max === 0) {
    return <p className={styles.empty}>{t('usage.chart_empty')}</p>;
  }

  const slot = W / points.length;
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const hovered = hover === null ? null : points[hover];
  const ticks = [max, max / 2];

  return (
    <div className={styles.root}>
      <ul className={styles.legend}>
        {present.map((key) => (
          <li key={key}>
            <span className={styles.swatch} style={{ background: `var(--series-${key})` }} />
            {t(`usage.series_${key}`)}
          </li>
        ))}
        <li className={styles.tableToggle}>
          <button type="button" onClick={() => setShowTable((v) => !v)} aria-pressed={showTable}>
            {showTable ? t('usage.show_chart') : t('usage.show_table')}
          </button>
        </li>
      </ul>

      {showTable ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.col_day')}</th>
                {present.map((key) => (
                  <th scope="col" key={key}>
                    {t(`usage.series_${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.day}>
                  <th scope="row">{dayLabel.format(p.day)}</th>
                  {present.map((key) => (
                    <td key={key}>{format(p.values[key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.plot} onMouseLeave={() => setHover(null)}>
          <div className={styles.yAxis} aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick} style={{ top: `${100 - (tick / max) * 100}%` }}>
                {format(tick)}
              </span>
            ))}
          </div>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className={styles.svg}
            role="img"
            aria-label={ariaLabel}
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={W}
                y1={H - (tick / max) * H}
                y2={H - (tick / max) * H}
                className={styles.grid}
              />
            ))}
            {points.map((p, index) => {
              let y = H;
              const x = index * slot + (slot - barW) / 2;
              const stack = present.filter((key) => p.values[key] > 0);
              return (
                <g key={p.day} opacity={hover === null || hover === index ? 1 : 0.45}>
                  {stack.map((key, i) => {
                    const h = (p.values[key] / max) * H;
                    y -= h;
                    const gap = i === 0 ? 0 : GAP;
                    const height = Math.max(0, h - gap);
                    return i === stack.length - 1 ? (
                      <path
                        key={key}
                        d={topRounded(x, y, barW, height)}
                        fill={`var(--series-${key})`}
                      />
                    ) : (
                      <rect
                        key={key}
                        x={x}
                        y={y}
                        width={barW}
                        height={height}
                        fill={`var(--series-${key})`}
                      />
                    );
                  })}
                  <rect
                    x={index * slot}
                    y={0}
                    width={slot}
                    height={H}
                    fill="transparent"
                    onMouseEnter={() => setHover(index)}
                  />
                </g>
              );
            })}
          </svg>
          {hovered && hover !== null && (
            <div
              className={styles.tooltip}
              style={{ left: `${((hover + 0.5) / points.length) * 100}%` }}
              role="status"
            >
              <strong>{dayLabel.format(hovered.day)}</strong>
              {present
                .filter((key) => hovered.values[key] > 0)
                .map((key) => (
                  <span key={key}>
                    <i style={{ background: `var(--series-${key})` }} />
                    {t(`usage.series_${key}`)} {format(hovered.values[key])}
                  </span>
                ))}
            </div>
          )}
          <div className={styles.xAxis} aria-hidden="true">
            <span>{dayLabel.format(points[0].day)}</span>
            <span>{dayLabel.format(points[points.length - 1].day)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
