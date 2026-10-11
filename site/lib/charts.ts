// Inline SVG charts, generated at build time. No JavaScript.
//
// Each plot is an <svg> stretched to the width of its column
// (preserveAspectRatio="none") at a fixed pixel height, so the y axis is in
// real pixels and the x axis is in thousandths of the width. Strokes use
// vector-effect="non-scaling-stroke", and dots are zero-length round-capped
// strokes, so neither distorts when the plot stretches. Axis labels are HTML,
// positioned in percentages, so they stay legible at phone width.
//
// Colours come from the theme: marks use `currentColor` (set on .chart in
// style.css) and the classes below can be restyled freely.

import type { AffectPoint, LedgerDay } from './content.ts';
import { esc, fmtDayMonth, fmtLong, fmtShort, fmtUsd, joinList } from './util.ts';

const W = 1000;

interface Tick {
  value: number;
  label: string;
}

function pct(x: number): string {
  return `${round((x / W) * 100)}%`;
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function yAxis(ticks: Tick[], toY: (v: number) => number): string {
  return `<div class="chart-y" aria-hidden="true">${ticks
    .map((t) => `<span style="top:${round(toY(t.value))}px">${esc(t.label)}</span>`)
    .join('')}</div>`;
}

function gridLines(ticks: Tick[], toY: (v: number) => number, strongValue?: number): string {
  return ticks
    .map((t) => {
      const y = round(toY(t.value));
      const cls = t.value === strongValue ? 'chart-grid chart-zero' : 'chart-grid';
      return `<line class="${cls}" x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="currentColor" stroke-opacity="0.18" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    })
    .join('');
}

function xAxis(labels: { x: number; text: string }[]): string {
  if (labels.length === 0) return '';
  return `<div class="chart-x" aria-hidden="true">${labels
    .map((l, i) => {
      const edge = labels.length > 1 && i === 0 ? ' class="first"' : labels.length > 1 && i === labels.length - 1 ? ' class="last"' : '';
      return `<span${edge} style="left:${pct(l.x)}">${esc(l.text)}</span>`;
    })
    .join('')}</div>`;
}

function dot(x: number, y: number, opacity: number, tip: string): string {
  const d = `M${round(x)} ${round(y)}h0`;
  const style = opacity < 1 ? ` style="opacity:${round(opacity)}"` : '';
  return (
    `<g class="chart-pt"><title>${esc(tip)}</title>` +
    `<path class="chart-hit" d="${d}" stroke="transparent" stroke-width="24" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `<path class="chart-ring" d="${d}" stroke="Canvas" stroke-width="13" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `<path class="chart-dot" d="${d}"${style} stroke="currentColor" stroke-width="9" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `</g>`
  );
}

function linePath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join('');
  return `<path class="chart-line" d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
}

function emptyPlot(height: number, message: string): string {
  return `<div class="chart-plot chart-empty" style="height:${height}px"><p>${esc(message)}</p></div>`;
}

function signed(n: number): string {
  const r = round(n, 1);
  return r > 0 ? `+${r}` : r < 0 ? `−${Math.abs(r)}` : '0';
}

// ---------------------------------------------------------------------------
// Affect: valence and arousal as two small multiples sharing a time axis.

export function affectChart(points: AffectPoint[], emptyMessage: string): string {
  const VH = 132;
  const AH = 96;
  const PAD = 10;
  if (points.length === 0) {
    return `<figure class="chart chart-affect"><div class="chart-frame">${emptyPlot(96, emptyMessage)}</div></figure>`;
  }

  const t0 = points[0]!.t.getTime();
  const t1 = points[points.length - 1]!.t.getTime();
  const span = t1 - t0;
  const lo = span === 0 ? t0 - 43_200_000 : t0;
  const hi = span === 0 ? t1 + 43_200_000 : t1;
  const toX = (t: number): number => 14 + ((t - lo) / (hi - lo)) * (W - 28);

  const vY = (v: number): number => PAD + ((5 - v) / 10) * (VH - 2 * PAD);
  const aY = (v: number): number => PAD + ((10 - v) / 10) * (AH - 2 * PAD);

  const tip = (p: AffectPoint): string => {
    const parts = [`${fmtLong(p.t)}`, `valence ${signed(p.valence)}`];
    if (p.arousal !== undefined) parts.push(`arousal ${round(p.arousal, 1)}`);
    if (p.feelings.length) parts.push(p.feelings.join(', '));
    if (p.confidence !== undefined) parts.push(`confidence ${Math.round(p.confidence * 100)}%`);
    return parts.join('; ');
  };
  const opacity = (p: AffectPoint): number => (p.confidence === undefined ? 1 : 0.28 + 0.72 * p.confidence);

  const vPts = points.map((p) => ({ x: toX(p.t.getTime()), y: vY(p.valence), p }));
  const aPts = points.filter((p) => p.arousal !== undefined).map((p) => ({ x: toX(p.t.getTime()), y: aY(p.arousal!), p }));

  const vTicks: Tick[] = [
    { value: 5, label: '+5' },
    { value: 0, label: '0' },
    { value: -5, label: '−5' },
  ];
  const aTicks: Tick[] = [
    { value: 10, label: '10' },
    { value: 5, label: '5' },
    { value: 0, label: '0' },
  ];

  const xLabels =
    span === 0
      ? [{ x: toX(t0), text: fmtShort(points[0]!.t) }]
      : [
          { x: toX(t0), text: fmtShort(points[0]!.t) },
          { x: toX(t1), text: fmtShort(points[points.length - 1]!.t) },
        ];

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const label = `Self-reported valence and arousal across ${points.length} check-ins from ${fmtLong(first.t)} to ${fmtLong(last.t)}. Most recent: valence ${signed(last.valence)}${last.arousal !== undefined ? `, arousal ${round(last.arousal, 1)}` : ''}.`;

  const valencePanel = `<p class="chart-label">Valence, from −5 to +5</p>
<div class="chart-frame">${yAxis(vTicks, vY)}<div class="chart-plot" style="height:${VH}px"><svg viewBox="0 0 ${W} ${VH}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${gridLines(vTicks, vY, 0)}${linePath(vPts)}${vPts.map((v) => dot(v.x, v.y, opacity(v.p), tip(v.p))).join('')}</svg></div></div>`;

  const arousalPanel = aPts.length
    ? `<p class="chart-label">Arousal, from 0 to 10</p>
<div class="chart-frame">${yAxis(aTicks, aY)}<div class="chart-plot" style="height:${AH}px"><svg viewBox="0 0 ${W} ${AH}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${gridLines(aTicks, aY)}${linePath(aPts)}${aPts.map((v) => dot(v.x, v.y, opacity(v.p), tip(v.p))).join('')}</svg></div></div>`
    : '';

  return `<figure class="chart chart-affect">
${valencePanel}
${arousalPanel}
<div class="chart-frame chart-frame-axis">${xAxis(xLabels)}</div>
</figure>`;
}

// ---------------------------------------------------------------------------
// Daily API-equivalent cost as columns.

export const COST_WINDOW_DAYS = 90;

/** Fill gaps so days without wakings show as zero, newest COST_WINDOW_DAYS only. */
export function continuousDays(days: LedgerDay[]): LedgerDay[] {
  if (days.length === 0) return [];
  const byDay = new Map(days.map((d) => [d.day, d]));
  const out: LedgerDay[] = [];
  const start = days[0]!.date.getTime();
  const end = days[days.length - 1]!.date.getTime();
  for (let t = start; t <= end; t += 86_400_000) {
    const date = new Date(t);
    const key = date.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, date, cost: 0, wakings: 0 });
  }
  return out.slice(-COST_WINDOW_DAYS);
}

function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(n));
  const f = n / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function usdTick(n: number): string {
  if (n === 0) return '$0';
  return Number.isInteger(n) ? `$${n}` : fmtUsd(n);
}

export function costChart(days: LedgerDay[], emptyMessage: string): string {
  const H = 150;
  const TOP = 14;
  const series = continuousDays(days);
  if (series.length === 0 || series.every((d) => d.cost === 0)) {
    return `<figure class="chart chart-cost"><div class="chart-frame">${emptyPlot(96, emptyMessage)}</div></figure>`;
  }

  const max = Math.max(...series.map((d) => d.cost));
  const top = niceCeil(max);
  const BASE = H - 1;
  const toY = (v: number): number => TOP + (1 - v / top) * (BASE - TOP);
  const n = series.length;
  const slot = W / n;
  // Column width in screen pixels: thin, capped, and never wider than the slot on a phone.
  const barPx = round(Math.min(14, Math.max(1.5, (330 / n) * 0.6)), 1);
  const r = barPx / 2;

  const ticks: Tick[] = [
    { value: top, label: usdTick(top) },
    { value: top / 2, label: usdTick(top / 2) },
    { value: 0, label: '$0' },
  ];

  let peakIndex = 0;
  series.forEach((d, i) => {
    if (d.cost > series[peakIndex]!.cost) peakIndex = i;
  });

  const bars = series
    .map((d, i) => {
      const cx = round(slot * i + slot / 2);
      const tip = `${fmtLong(d.date)}: ${fmtUsd(d.cost)}${d.wakings ? ` over ${d.wakings} waking${d.wakings === 1 ? '' : 's'}` : ', no wakings'}`;
      const hit = `<rect class="chart-hit" x="${round(slot * i)}" y="0" width="${round(slot)}" height="${H}" fill="transparent"/>`;
      if (d.cost <= 0) return `<g class="chart-bar"><title>${esc(tip)}</title>${hit}</g>`;
      // The round cap adds r pixels above the end point; start r lower so the top lands on the value.
      const yTop = round(Math.min(BASE, toY(d.cost) + r));
      return `<g class="chart-bar"><title>${esc(tip)}</title>${hit}<path class="chart-col" d="M${cx} ${H + r}V${yTop}" stroke="currentColor" stroke-width="${barPx}" stroke-linecap="round" vector-effect="non-scaling-stroke" clip-path="url(#cost-clip)"/></g>`;
    })
    .join('');

  const peak = series[peakIndex]!;
  const peakX = slot * peakIndex + slot / 2;
  const peakEdge = peakX < W * 0.12 ? ' near-start' : peakX > W * 0.88 ? ' near-end' : '';
  const peakLabel = `<span class="chart-peak${peakEdge}" style="left:${pct(peakX)};top:${round(toY(peak.cost))}px">${esc(fmtUsd(peak.cost))}</span>`;

  const xLabels =
    n === 1
      ? [{ x: slot / 2, text: fmtShort(series[0]!.date) }]
      : [
          { x: slot / 2, text: fmtShort(series[0]!.date) },
          { x: W - slot / 2, text: fmtShort(series[n - 1]!.date) },
        ];

  const label = `Daily API-equivalent cost for ${n} day${n === 1 ? '' : 's'} from ${fmtLong(series[0]!.date)} to ${fmtLong(series[n - 1]!.date)}. Highest: ${fmtUsd(peak.cost)} on ${fmtDayMonth(peak.date)}.`;

  return `<figure class="chart chart-cost">
<div class="chart-frame">${yAxis(ticks, toY)}<div class="chart-plot" style="height:${H}px"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><defs><clipPath id="cost-clip"><rect x="-20" y="-20" width="${W + 40}" height="${BASE + 20}"/></clipPath></defs>${gridLines(ticks, toY, 0)}${bars}</svg>${peakLabel}</div></div>
<div class="chart-frame chart-frame-axis">${xAxis(xLabels)}</div>
</figure>`;
}

/** Most-used feeling words, e.g. "curious (4), calm (2)". */
export function topFeelings(points: AffectPoint[], limit = 12): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of points) {
    for (const f of p.feelings) {
      const word = f.trim().toLowerCase();
      if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit);
}

export function describeFeelings(points: AffectPoint[]): string {
  const top = topFeelings(points);
  return joinList(top.map((t) => `${esc(t.word)}${t.count > 1 ? `&nbsp;(${t.count})` : ''}`));
}

export { signed };
