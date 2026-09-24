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
  format: (v: number) => string;
  /** Force the y-axis to include zero. */
  zero?: boolean;
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

export function lineChart(wrap: HTMLElement, series: Series[], o: ChartOpts): void {
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
  const padL = 46;
  const padR = series.length > 1 ? 74 : 14;
  const padT = 8;
  const padB = 20;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  ctx.font = '11px Overpass, system-ui, sans-serif';
  if (n < 2) {
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.fillText('History starts after the first month.', W / 2, H / 2);
    tip.hidden = true;
    return;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) for (const v of s.values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (o.zero) lo = Math.min(0, lo);
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const X = (i: number) => padL + (i / (n - 1)) * pw;
  const Y = (v: number) => padT + ph - ((v - lo) / (hi - lo)) * ph;

  // Grid and y labels.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = lo; v <= hi + step / 2; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + pw, y);
    ctx.stroke();
    ctx.fillText(o.format(v), padL - 6, y);
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

  // Lines.
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.stroke();
    const last = s.values[s.values.length - 1];
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(X(s.values.length - 1), Y(last), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // End labels, nudged apart so they do not collide.
  if (series.length > 1) {
    const labels = series.map((s) => ({ s, y: Y(s.values[s.values.length - 1]) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < labels.length; k++) if (labels[k].y - labels[k - 1].y < 13) labels[k].y = labels[k - 1].y + 13;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    for (const l of labels) ctx.fillText(l.s.name, padL + pw + 8, Math.min(padT + ph, l.y));
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
    const c2 = canvas.getContext('2d')!;
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.strokeStyle = 'rgba(234,240,234,0.35)';
    c2.lineWidth = 1;
    c2.beginPath();
    c2.moveTo(Math.round(X(i)) + 0.5, padT);
    c2.lineTo(Math.round(X(i)) + 0.5, padT + ph);
    c2.stroke();
    for (const s of series) {
      if (i >= s.values.length) continue;
      c2.fillStyle = '#151e1b';
      c2.beginPath();
      c2.arc(X(i), Y(s.values[i]), 5, 0, Math.PI * 2);
      c2.fill();
      c2.fillStyle = s.color;
      c2.beginPath();
      c2.arc(X(i), Y(s.values[i]), 3.5, 0, Math.PI * 2);
      c2.fill();
    }
    const m = o.startMonth + i;
    tip.innerHTML = `<b>${MONTHS[m % 12]} ${START_YEAR + Math.floor(m / 12)}</b>` +
      series.map((s) => `<span class="num"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${s.color}"></i>${s.name}: ${o.format(s.values[i] ?? 0)}</span>`).join('');
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
