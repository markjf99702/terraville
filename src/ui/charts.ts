// Small canvas line charts for the history window. One y-axis per chart,
// thin lines, a recessive grid, a legend plus end labels, and a hover
// crosshair with a tooltip.
import { MONTHS, START_YEAR } from '../defs';

export interface Series {
  name: string;
  color: string;
  values: number[];
}

export interface ChartOpts {
  /** Month index of values[0]. */
  startMonth: number;
  /** A value in full, for the hover tooltip. */
  format: (v: number) => string;
  /** Force the y-axis to include zero. */
  zero?: boolean;
  /** Dollars, so the axis labels carry a $. */
  money?: boolean;
  /** Whole numbers (people, jobs, dollars, an index): no axis step under 1. */
  whole?: boolean;
  /** A value to mark with a faint dashed line across the chart, such as 60% approval. */
  line?: number;
}

export interface Axis {
  lo: number;
  hi: number;
  step: number;
  ticks: number[];
}

const INK = '#eaf0ea';
const MUTED = '#9dada5';
const GRID = 'rgba(157,173,165,0.14)';

function niceStep(range: number, ticks: number): number {
  const raw = range / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

/**
 * The y-axis for values from min to max: about four steps of a round size, every tick a different number. A flat
 * series gets a little room around its value rather than five ticks that all read the same.
 */
export function chartAxis(min: number, max: number, o: { zero?: boolean; whole?: boolean } = {}): Axis {
  let lo = o.zero ? Math.min(0, min) : min;
  let hi = o.zero ? Math.max(0, max) : max;
  if (hi === lo) {
    const room = Math.max(o.whole ? 2 : 0.5, Math.abs(lo) * 0.05);
    if (lo === 0 && o.zero) hi = o.whole ? 4 : 1;
    else {
      lo -= room;
      hi += room;
    }
  }
  let step = niceStep(hi - lo, 4);
  if (o.whole) step = Math.max(1, step);
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  if (hi <= lo) hi = lo + step;
  const ticks: number[] = [];
  for (let k = 0; lo + k * step <= hi + step / 2; k++) ticks.push(Number((lo + k * step).toPrecision(12)));
  return { lo, hi, step, ticks };
}

/**
 * A tick's label, as precise as the step between ticks: '$26.5k' between $26k and $27k. Once the biggest tick reaches
 * 10,000, every tick is in thousands.
 */
export function tickLabel(v: number, axis: Axis, money = false): string {
  const top = Math.max(...axis.ticks.map(Math.abs));
  const sign = v < 0 ? '−' : '';
  const cur = money ? '$' : '';
  const a = Math.abs(v);
  if (a === 0) return `${cur}0`;
  if (top >= 10000) {
    const k = a / 1000;
    return `${sign}${cur}${trim(k, decimals(axis.step / 1000))}k`;
  }
  return `${sign}${cur}${Number(a.toFixed(decimals(axis.step))).toLocaleString('en-US', { maximumFractionDigits: 3 })}`;
}

/** How many decimals a step needs to be written exactly (up to 3). */
function decimals(step: number): number {
  let d = 0;
  while (d < 3 && Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-6) d++;
  return d;
}

function trim(v: number, d: number): string {
  return Number(v.toFixed(d)).toLocaleString('en-US', { maximumFractionDigits: d });
}

/**
 * Place labels at heights `ys` (in the same order) at least `gap` apart, between top and bottom: pushed down where they
 * crowd, then, where that runs past the bottom, pushed back up rather than piled on it.
 */
export function spreadLabels(ys: number[], top: number, bottom: number, gap: number): number[] {
  const order = ys.map((y, k) => ({ y: Math.max(top, Math.min(bottom, y)), k })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) order[k].y = Math.max(order[k].y, order[k - 1].y + gap);
  if (order.length) order[order.length - 1].y = Math.min(order[order.length - 1].y, bottom);
  for (let k = order.length - 2; k >= 0; k--) order[k].y = Math.min(order[k].y, order[k + 1].y - gap);
  const out = new Array<number>(ys.length);
  for (const l of order) out[l.k] = l.y;
  return out;
}

/**
 * Draw `series` in `wrap`'s canvas. A series shorter than the longest began later (one a city's history gained after
 * it was founded), so it ends at the right with the others; one with no values yet is left out.
 */
export function lineChart(wrap: HTMLElement, all: Series[], o: ChartOpts): void {
  const series = all.filter((s) => s.values.length);
  const canvas = wrap.querySelector('canvas')!;
  const tip = wrap.querySelector<HTMLElement>('.charttip')!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 160;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const n = Math.max(...series.map((s) => s.values.length), 0);
  // A screen reader has no picture: it hears the chart's title and where each line ends.
  const title = wrap.querySelector('h4')?.textContent ?? 'Chart';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', n < 2 ? `${title}: history starts after the first month.`
    : `${title}, latest: ${series.map((s) => `${s.name} ${o.format(s.values[s.values.length - 1])}`).join(', ')}`);
  ctx.font = '11px Overpass, system-ui, sans-serif';
  const padL = 46;
  // Room for the longest name at the line ends.
  const padR = series.length > 1 ? Math.ceil(Math.max(...series.map((s) => ctx.measureText(s.name).width))) + 14 : 14;
  const padT = 8;
  const padB = 20;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  if (n < 2) {
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.fillText('History starts after the first month.', W / 2, H / 2);
    tip.hidden = true;
    return;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) for (const v of s.values) { min = Math.min(min, v); max = Math.max(max, v); }
  if (o.line !== undefined) { min = Math.min(min, o.line); max = Math.max(max, o.line); }
  const axis = chartAxis(min, max, o);
  const { lo, hi } = axis;
  const X = (i: number) => padL + (i / (n - 1)) * pw;
  const Y = (v: number) => padT + ph - ((v - lo) / (hi - lo)) * ph;
  /** Where a series' first value sits along the months. */
  const off = (s: Series) => n - s.values.length;

  // Grid and y labels.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of axis.ticks) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + pw, y);
    ctx.stroke();
    ctx.fillText(tickLabel(v, axis, o.money), padL - 6, y);
  }
  // Year labels.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const years = n / 12;
  const yStep = years <= 12 ? 2 : years <= 30 ? 5 : years <= 60 ? 10 : 20;
  for (let i = 0; i < n; i++) {
    const m = o.startMonth + i;
    if (m % 12 !== 0) continue;
    const yr = START_YEAR + m / 12;
    if (yr % yStep !== 0) continue;
    ctx.fillText(String(yr), X(i), padT + ph + 5);
  }

  if (o.line !== undefined) {
    const y = Math.round(Y(o.line)) + 0.5;
    ctx.save();
    ctx.strokeStyle = 'rgba(234,240,234,0.32)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + pw, y);
    ctx.stroke();
    ctx.restore();
  }

  // Lines.
  for (const s of series) {
    const k = off(s);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.values.forEach((v, i) => (i ? ctx.lineTo(X(i + k), Y(v)) : ctx.moveTo(X(i + k), Y(v))));
    ctx.stroke();
    const last = s.values[s.values.length - 1];
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(X(n - 1), Y(last), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // End labels, nudged apart so they do not collide.
  if (series.length > 1) {
    const ys = spreadLabels(series.map((s) => Y(s.values[s.values.length - 1])), padT, padT + ph, 13);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    series.forEach((s, k) => ctx.fillText(s.name, padL + pw + 8, ys[k]));
  }

  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const i = Math.round(((x - padL) / pw) * (n - 1));
    if (i < 0 || i >= n) {
      tip.hidden = true;
      lineChart(wrap, series, o);
      return;
    }
    // Redraw with a crosshair.
    lineChart(wrap, series, o);
    const at = (s: Series) => s.values[i - off(s)];
    const c2 = canvas.getContext('2d')!;
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.strokeStyle = 'rgba(234,240,234,0.35)';
    c2.lineWidth = 1;
    c2.beginPath();
    c2.moveTo(Math.round(X(i)) + 0.5, padT);
    c2.lineTo(Math.round(X(i)) + 0.5, padT + ph);
    c2.stroke();
    for (const s of series) {
      if (at(s) === undefined) continue;
      c2.fillStyle = '#151e1b';
      c2.beginPath();
      c2.arc(X(i), Y(at(s)), 5, 0, Math.PI * 2);
      c2.fill();
      c2.fillStyle = s.color;
      c2.beginPath();
      c2.arc(X(i), Y(at(s)), 3.5, 0, Math.PI * 2);
      c2.fill();
    }
    const m = o.startMonth + i;
    tip.innerHTML = `<b>${MONTHS[m % 12]} ${START_YEAR + Math.floor(m / 12)}</b>` +
      series.filter((s) => at(s) !== undefined).map((s) => `<span class="num"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${s.color}"></i>${s.name}: ${o.format(at(s))}</span>`).join('');
    tip.hidden = false;
    const tx = X(i) + 12;
    tip.style.left = `${Math.min(tx, W - tip.offsetWidth - 4)}px`;
    tip.style.top = `${padT + 4}px`;
  };
  canvas.onpointermove = onMove;
  canvas.onpointerleave = () => {
    tip.hidden = true;
    lineChart(wrap, series, o);
  };
}
