/**
 * 연도별 추이 그림.
 *
 * 그림 구성은 `kihasa-indicator-new`의 「연도별 추이 분석」 탭을 그대로 따른다.
 *   · 우리 지역   — 굵은 빨강 실선 + 점
 *   · 비교집단 평균 — 남색 파선
 *   · Q1~Q3 밴드  — 옅은 남색 채움
 *   · 전국 평균   — 회색 점선
 * 다만 그쪽은 Plotly를 쓴다. 이 도구는 외부 라이브러리를 쓰지 않으므로 Canvas에 직접
 * 그린다. 색·선 종류·범례 구성만 같게 맞췄다.
 *
 * `chart.js`와 같은 규칙 — 배치(layout)와 칠하기(paint)를 갈라 두어 배치를 캔버스 없이
 * 시험할 수 있게 한다.
 */
"use strict";

import { COLORS, FONT, textWidth, ellipsize } from './chart.js';
import {
  quantile, mean, valAt, fmtRef, basisLabel,
  loadIndex, loadSeries, groupCodes, regionOf, KEY_CODES,
} from './indicator.js';

/** 칸 하나의 기본 크기. 한 장에 여러 지표를 격자로 앉힌다. */
export const CELL_W = 460;
export const CELL_H = 260;
const PAD = 16;
const HEAD = 44;          // 그림 제목 + 범례
const CAP = 26;           // 아래 표주

/** 한 장에 넣을 칸 수. 넘으면 장을 나눈다(한글 한 쪽에 들어가는 양). */
export const PER_SHEET = 4;

const M = { l: 62, r: 14, t: 30, b: 30 };   // 칸 안 그래프 여백

/**
 * 한 지표의 연도별 값 묶음을 만든다.
 *   mine  — 우리 지역
 *   avg   — 비교집단 단순평균
 *   q1/q3 — 비교집단 사분위
 *   nation— 전국 평균(비교 기준이 전국이 아닐 때만)
 */
export function trendSeries(sr, opts) {
  const o = opts || {};
  const years = (sr.years || []).filter((y) => (!o.from || y >= o.from) && (!o.to || y <= o.to));
  const grp = Array.isArray(o.group) ? o.group : [];
  const all = Array.isArray(o.nation) ? o.nation : [];
  const mine = years.map((y) => valAt(sr, o.region, y));
  const per = years.map((y) => grp.map((c) => valAt(sr, c, y)).filter((v) => v != null)
    .sort((a, b) => a - b));
  return {
    code: sr.code,
    name: sr.name,
    unit: sr.unit || '',
    years,
    mine,
    avg: per.map((a) => (a.length ? mean(a) : null)),
    q1: per.map((a) => (a.length >= 4 ? quantile(a, 0.25) : null)),
    q3: per.map((a) => (a.length >= 4 ? quantile(a, 0.75) : null)),
    n: per.map((a) => a.length),
    nation: all.length
      ? years.map((y) => {
        const v = all.map((c) => valAt(sr, c, y)).filter((x) => x != null);
        return v.length ? mean(v) : null;
      })
      : null,
  };
}

const finite = (a) => a.filter((v) => v != null && Number.isFinite(v));

/**
 * 계열 하나가 얼마나 눈에 띄는가. 자동 선정에 쓴다.
 * 마지막 연도의 우리 값이 비교집단 Q1~Q3에서 벗어난 정도를 IQR 폭으로 나눈 값.
 * 구간 안이면 0. 사분위를 못 구한 계열은 자격이 없다(-1).
 */
export function noteworthy(s) {
  for (let k = s.years.length - 1; k >= 0; k -= 1) {
    const v = s.mine[k];
    const q1 = s.q1[k];
    const q3 = s.q3[k];
    if (v == null || q1 == null || q3 == null) continue;
    const iqr = Math.abs(q3 - q1) || Math.abs(q3) || 1;
    if (v < q1) return (q1 - v) / iqr;
    if (v > q3) return (v - q3) / iqr;
    return 0;
  }
  return -1;
}

/**
 * 추이 계열을 실제 자료에서 만들어 온다.
 * opts = { region, basis, codes, from, to, limit }
 *   codes — 후보 지표. 비우면 핵심지표 22개
 *   limit — 이 수만큼 **비교집단과 가장 크게 다른 지표**를 골라 낸다.
 *           0이나 null이면 고르지 않고 codes 차례 그대로 모두 돌려준다.
 * 자동 선정 기준은 「의미 있는 차이가 나는 지표를 앞세운다」는 작성 지시와 같다.
 */
export async function analyzeTrend(opts) {
  const o = opts || {};
  const { regions } = await loadIndex();
  const region = regionOf(regions, o.region);
  if (!region) throw new Error(`지역 코드 ${o.region} 을(를) 찾지 못했다`);
  const basis = o.basis || '전국';
  const group = groupCodes(regions, basis, region.code);
  if (!group.length) throw new Error('비교집단이 비어 있다');
  /* 전국 비교면 비교집단이 곧 전국이라 같은 선을 두 번 그리게 된다. 그때는 전국 선을 뺀다 */
  const nation = basis === '전국' ? null : groupCodes(regions, '전국', region.code);

  const pool = (o.codes && o.codes.length) ? o.codes.slice() : KEY_CODES.slice();
  const settled = await Promise.all(pool.map((c) => loadSeries(c).then(
    (sr) => ({ code: c, sr }), () => ({ code: c, sr: null }))));

  const built = settled.filter((s) => s.sr).map(({ sr }) => trendSeries(sr, {
    region: region.code, group, nation, from: o.from, to: o.to,
  })).filter((s) => finite(s.mine).length >= 2);
  if (!built.length) throw new Error('연도별 값이 두 해 이상 있는 지표가 없다');

  const limit = Number(o.limit) || 0;
  if (limit <= 0 || built.length <= limit) return built;
  const ranked = built.map((s) => ({ s, w: noteworthy(s) }))
    .sort((a, b) => b.w - a.w).slice(0, limit).map((x) => x.s);
  /* 고른 뒤에는 원래 차례로 되돌린다 — 골라 낸 순서가 곧 중요도 순서로 읽히면
     「이 지표가 저 지표보다 심각하다」는 없는 뜻이 생긴다 */
  return built.filter((s) => ranked.includes(s));
}

/** 눈금 값 — 사람이 읽기 좋은 간격으로 4~6칸.
    간격은 위로 반올림하므로 나누는 수를 4로 두면 실제로는 두세 줄밖에 안 서는 구간이
    생긴다(예: -3.2~1.8 → -2, 0 두 줄). 5로 나눠 잡아야 대체로 네댓 줄이 선다. */
export function ticksOf(lo, hi) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out.length ? out : [lo, hi];
}

/**
 * 배치를 만든다. 칸마다 좌표를 잡아 두면 칠하기는 그대로 옮기기만 하면 된다.
 * 돌려주는 값 { width, height, scale, ops } — ops는 chart.js와 같은 모양의 그리기 지시.
 */
export function layoutTrend(series, opts) {
  const o = opts || {};
  const list = (Array.isArray(series) ? series : []).filter(Boolean);
  if (!list.length) throw new Error('그릴 추이 계열이 없다');
  const cols = list.length === 1 ? 1 : 2;
  const rows = Math.ceil(list.length / cols);
  const cw = o.cellWidth || CELL_W;
  const ch = o.cellHeight || CELL_H;
  const width = PAD * 2 + cols * cw;
  const height = HEAD + rows * ch + CAP;
  const ops = [];

  const T = (x, y, text, size, color, align, weight) => ops.push({
    op: 'text', x, y, text: String(text), size, color, align: align || 'left', weight: weight || 'normal',
  });
  const L = (x0, y0, x1, y1, color, w, dash) => ops.push({
    op: 'line', x0, y0, x1, y1, color, width: w || 1, dash: dash || null,
  });

  /* 머리글 */
  T(PAD, 22, o.title || '연도별 추이', 15, COLORS.name, 'left', 'bold');
  const span = list[0].years.length
    ? `${list[0].years[0]}~${list[0].years[list[0].years.length - 1]}년` : '';
  T(PAD, 38, `${span}${o.basis ? ` · ${basisLabel(o.basis)} 비교` : ''}`, 11, COLORS.caption);

  /* 범례 — 오른쪽 위 */
  const legend = [
    { label: o.regionName || '우리 지역', color: COLORS.target, kind: 'solid' },
    { label: '비교집단 평균', color: COLORS.avg, kind: 'dash' },
    { label: 'Q1~Q3', color: COLORS.iqr, kind: 'band' },
  ];
  if (list.some((s) => s.nation)) legend.push({ label: '전국 평균', color: COLORS.whisker, kind: 'dot' });
  let lx = width - PAD;
  for (const it of legend.slice().reverse()) {
    const w = textWidth(it.label, 10.5);
    T(lx, 22, it.label, 10.5, COLORS.caption, 'right');
    lx -= w + 8;
    if (it.kind === 'band') ops.push({ op: 'rect', x: lx - 16, y: 15, w: 16, h: 8, fill: it.color });
    else L(lx - 16, 19, lx, 19, it.color, it.kind === 'solid' ? 2.4 : 1.8,
      it.kind === 'dash' ? [5, 3] : it.kind === 'dot' ? [2, 3] : null);
    lx -= 16 + 14;
  }

  /* 칸마다 */
  list.forEach((s, i) => {
    const cx = PAD + (i % cols) * cw;
    const cy = HEAD + Math.floor(i / cols) * ch;
    const x0 = cx + M.l;
    const x1 = cx + cw - M.r;
    const y0 = cy + M.t;
    const y1 = cy + ch - M.b;

    T(cx + 4, cy + 14, ellipsize(`${s.name}${s.unit ? ` (${s.unit})` : ''}`, 11.5, cw - 8),
      11.5, COLORS.name, 'left', 'bold');

    const vals = finite([...s.mine, ...s.avg, ...s.q1, ...s.q3, ...(s.nation || [])]);
    if (!vals.length || s.years.length < 2) {
      T(cx + cw / 2, cy + ch / 2, '연도별 값이 모자라 추이를 그리지 못했다', 11, COLORS.caption, 'center');
      return;
    }
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi === lo) { hi = lo + Math.abs(lo || 1) * 0.1; lo -= Math.abs(lo || 1) * 0.1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;

    const X = (k) => x0 + (s.years.length === 1 ? 0 : (x1 - x0) * k / (s.years.length - 1));
    const Y = (v) => y1 - (y1 - y0) * (v - lo) / (hi - lo);

    /* 가로 눈금선과 값 */
    for (const t of ticksOf(lo + pad, hi - pad)) {
      const y = Y(t);
      if (y < y0 - 0.5 || y > y1 + 0.5) continue;
      L(x0, y, x1, y, COLORS.rule, 1);
      T(x0 - 6, y + 3.5, fmtRef(t), 9.5, COLORS.dim, 'right');
    }
    /* 연도 — 칸이 좁으면 걸러 찍는다 */
    const every = Math.max(1, Math.ceil(s.years.length / Math.floor((x1 - x0) / 34)));
    s.years.forEach((y, k) => {
      if (k % every && k !== s.years.length - 1) return;
      T(X(k), y1 + 14, String(y), 9.5, COLORS.dim, 'center');
    });
    L(x0, y1, x1, y1, COLORS.whisker, 1);

    /* Q1~Q3 밴드 */
    const band = [];
    s.years.forEach((_, k) => {
      if (s.q1[k] == null || s.q3[k] == null) return;
      band.push({ x: X(k), lo: Y(s.q1[k]), hi: Y(s.q3[k]) });
    });
    if (band.length >= 2) ops.push({ op: 'band', pts: band, fill: COLORS.iqr, alpha: 0.45 });

    const path = (arr, color, w, dash) => {
      const pts = [];
      arr.forEach((v, k) => { if (v != null && Number.isFinite(v)) pts.push({ x: X(k), y: Y(v) }); });
      if (pts.length >= 2) ops.push({ op: 'path', pts, color, width: w, dash: dash || null });
      return pts;
    };
    if (s.nation) path(s.nation, COLORS.whisker, 1.6, [2, 3]);
    path(s.avg, COLORS.avg, 2, [5, 3]);
    const mine = path(s.mine, COLORS.target, 2.6);
    for (const p of mine) ops.push({ op: 'dot', x: p.x, y: p.y, r: 3.2, fill: COLORS.target });
  });

  T(PAD, height - 10,
    '※ 자료：보건복지부·한국보건사회연구원, 「지역사회보장지표」. 평균은 시·군·구 단순평균임.',
    9.5, COLORS.caption);

  return { width, height, scale: o.scale || 2, ops };
}

/** 배치를 캔버스에 옮긴다. */
export function paintTrend(ctx, layout) {
  const s = layout.scale;
  ctx.save();
  ctx.scale(s, s);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const op of layout.ops) {
    if (op.op === 'text') {
      ctx.font = `${op.weight === 'bold' ? '700 ' : ''}${op.size}px ${FONT}`;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align;
      ctx.fillText(op.text, op.x, op.y);
    } else if (op.op === 'line' || op.op === 'path') {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.setLineDash(op.dash || []);
      ctx.beginPath();
      if (op.op === 'line') { ctx.moveTo(op.x0, op.y0); ctx.lineTo(op.x1, op.y1); }
      else op.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (op.op === 'band') {
      ctx.fillStyle = op.fill;
      ctx.globalAlpha = op.alpha;
      ctx.beginPath();
      op.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.hi) : ctx.moveTo(p.x, p.hi)));
      for (let i = op.pts.length - 1; i >= 0; i -= 1) ctx.lineTo(op.pts[i].x, op.pts[i].lo);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (op.op === 'rect') {
      ctx.fillStyle = op.fill;
      ctx.fillRect(op.x, op.y, op.w, op.h);
    } else if (op.op === 'dot') {
      ctx.fillStyle = op.fill;
      ctx.beginPath();
      ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** 추이 그림 한 장을 PNG 바이트로 만든다. */
export async function renderTrendChart(series, opts) {
  const lay = layoutTrend(series, opts);
  const w = Math.round(lay.width * lay.scale);
  const h = Math.round(lay.height * lay.scale);
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('캔버스를 쓸 수 없다.');
  paintTrend(ctx, lay);
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((done) => canvas.toBlob(done, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 추이 원고. 값의 방향과 폭만 사실대로 적는다.
 * **함의는 쓰지 않는다** — 정책 방향은 담당자와 AI가 채울 자리로 남긴다.
 */
export function narrateTrend(series, opts) {
  const o = opts || {};
  const list = (Array.isArray(series) ? series : []).filter((s) => s && s.years.length >= 2);
  if (!list.length) throw new Error('추이 원고를 만들 계열이 없다');
  const L = ['#### 연도별 추이', ''];
  const y0 = list[0].years[0];
  const y1 = list[0].years[list[0].years.length - 1];
  L.push(`○ 기간 — ${y0}~${y1}년, 대상 지표 ${list.length}개, ${basisLabel(o.basis || '전국')} 비교`);
  L.push('');

  for (const s of list) {
    const idx = s.mine.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
    if (idx.length < 2) { L.push(`○ ${s.name} — 연도별 값이 모자라 추이를 판단하지 못했다`); continue; }
    const a = idx[0];
    const b = idx[idx.length - 1];
    const from = s.mine[a];
    const to = s.mine[b];
    const diff = to - from;
    const way = Math.abs(diff) < Math.abs(from || 1) * 0.02 ? '큰 변화 없음'
      : diff > 0 ? '증가' : '감소';
    const u = s.unit ? ` ${s.unit}` : '';
    L.push(`○ ${s.name}`);
    L.push(`- ${s.years[a]}년 ${fmtRef(from)}${u} → ${s.years[b]}년 ${fmtRef(to)}${u} (${way}`
      + (way === '큰 변화 없음' ? ')' : `, ${diff > 0 ? '+' : ''}${fmtRef(diff)}${u})`));
    if (s.avg[b] != null) {
      const gap = to - s.avg[b];
      L.push(`- ${s.years[b]}년 비교집단 평균 ${fmtRef(s.avg[b])}${u} 대비 `
        + `${gap >= 0 ? '높음' : '낮음'}(차이 ${fmtRef(Math.abs(gap))}${u})`);
    }
    if (s.q1[b] != null && s.q3[b] != null) {
      const inBand = to >= s.q1[b] && to <= s.q3[b];
      L.push(`- ${s.years[b]}년 비교집단 Q1~Q3 구간(${fmtRef(s.q1[b])}~${fmtRef(s.q3[b])}${u}) `
        + `${inBand ? '안에 있어 비슷한 수준' : '밖에 있어 뚜렷이 다름'}`);
    }
    L.push('');
  }

  /* 빈칸 표시(○○○○)는 줄 끝에 둔다 — 줄머리에 두면 한글이 붙이는 글머리표와 겹쳐
     [이중 기호]로 걸려 산출이 막힌다 */
  L.push('○ 추세가 말하는 것 — 담당자 작성');
  L.push('- 늘거나 줄어드는 흐름이 우리 지역에 무엇을 뜻하는지 → ○○○○');
  L.push('- 그래서 어떤 정책·사업을 이어 가거나 새로 넣어야 하는지 → ○○○○');
  L.push('');
  L.push('※ 자료：보건복지부·한국보건사회연구원, 「지역사회보장지표」. '
    + '평균은 시·군·구 단순평균이며, 지표별 결측 연도는 선에서 끊어 표시함.');
  return L.join('\n');
}
