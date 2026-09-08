/* 지표 비교 그래프 — Canvas 2D로 직접 그린다. 외부 차트 라이브러리를 쓰지 않는다.
   docs/CONTRACTS.md 5장 계약 구현.

   도형 구성은 대시보드(kihasa-indicator-new)의 박스플롯 행과 같다.
     위스커(Min~Max 선 + 양끝 캡) + IQR 사각형(Q1~Q3) + 평균 원 + 우리 지역 마름모.

   계산부(layoutChart)와 칠하는 부분(renderComparisonChart)을 갈라 두었다.
   캔버스가 없는 Node에서도 layoutChart()만 돌려 좌표를 검사할 수 있다. */
"use strict";

import { fmtRef, basisLabel } from './indicator.js';

export const COLORS = {
  target: '#c0392b',    // 우리 지역
  avg: '#1a4f8a',       // 비교평균
  iqr: '#a8c5ff',       // IQR 상자
  whisker: '#94a3b8',   // Min~Max 위스커
  caption: '#64748b',   // 설명
  name: '#1e293b',      // 지표명
  dim: '#94a3b8',       // 단위·연도
  rule: '#e2e8f0',      // 구분선
  bg: '#ffffff',
};

export const FONT = '"Malgun Gothic","Apple SD Gothic Neo",sans-serif';

/* 캔버스 없이 글자 폭을 어림잡는다. 겹침 검사·말줄임에 쓰는 값이라 정확할 필요는 없고
   실제보다 넉넉해야 안전하다(한글·전각은 1em, 숫자·영문은 0.55em로 본다) */
export function textWidth(text, size) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (ch === ' ') w += 0.30;
    else if (c < 0x0080) w += /[iIl.,:;'`|!]/.test(ch) ? 0.30 : 0.56;
    else if (c >= 0x2000 && c < 0x2100) w += 0.62;   // 대시·따옴표·기호
    else w += 1.0;                                    // 한글·한자·전각 기호
  }
  return w * size;
}

/* 칸 폭에 맞춰 뒤를 잘라내고 말줄임표를 붙인다 */
export function ellipsize(text, size, maxWidth) {
  const s = String(text);
  if (textWidth(s, size) <= maxWidth) return s;
  const chars = Array.from(s);
  let out = '';
  for (const ch of chars) {
    if (textWidth(out + ch + '…', size) > maxWidth) break;
    out += ch;
  }
  return (out || chars[0] || '') + '…';
}

/* 글상자의 좌우 끝. align 을 반영한다 */
export function textBox(t) {
  const w = t.w != null ? t.w : textWidth(t.text, t.size);
  const x0 = t.align === 'center' ? t.x - w / 2 : t.align === 'right' ? t.x - w : t.x;
  return { x0, x1: x0 + w, y: t.y, w };
}

/* 배치 상수 — 논리 픽셀(scale 을 곱하기 전) */
const W = 980;
const MIN_W = 560;        // 범례·머리글이 겹치지 않는 최소 너비
const PAD = 20;
const HEAD = 78;          // 제목 영역 높이
const ROW = 104;          // 지표 한 줄 높이
const FOOT = 34;          // 표주 문장 자리
const NAME_X = PAD;
const VAL_X = 396;        // 우리 값·평균을 오른쪽 정렬하는 기준선
const PLOT_X0 = 436;
const PLOT_X1 = W - PAD;

/* 한 장(그림 한 개)에 넣는 지표 줄 수 상한.
   그림은 한글에서 폭 120mm로 들어가므로 세로가 길어질수록 쪽을 넘긴다.
   ROW 104 기준 12줄이면 980×1360(세로 약 167mm)이라 한 쪽에 머문다. */
export const PER_SHEET = 12;

/* 지표 줄을 장 단위로 자른다. 마지막 장만 짧게 남기지 않고 고르게 나눈다
   — 22개를 12개 상한으로 자르면 12+10이 아니라 11+11이 된다. */
export function chunkRows(rows, per) {
  const list = Array.isArray(rows) ? rows : [];
  const cap = Math.max(1, per || PER_SHEET);
  if (list.length <= cap) return [list];
  const sheets = Math.ceil(list.length / cap);
  const size = Math.ceil(list.length / sheets);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/* layoutChart(rows, opts) — 그리기 명령 목록과 검사용 기하 정보를 만든다.
   opts = { title, subtitle, basis, year, scale, width, part }
   part = {index, total} 이면 머리글에 「1/2쪽」을 덧붙인다
   돌려주는 것
     { width, height, scale, background, font, ops:[…], rows:[…] }
   ops 원소
     {op:'text', x, y, text, size, color, align, weight, w, row, line}
     {op:'line', x0, y0, x1, y1, color, width}
     {op:'rect', x, y, w, h, fill}
     {op:'circle', x, y, r, fill, stroke}
     {op:'diamond', x, y, r, fill, stroke} */
export function layoutChart(rows, opts) {
  const o = opts || {};
  if (!Array.isArray(rows) || !rows.length) throw new Error('그릴 지표 결과가 없다');
  const width = o.width || W;
  /* 이보다 좁으면 범례·머리글이 서로 밀려 그림 밖으로 나간다. 말없이 망가뜨리지 않는다 */
  if (!Number.isFinite(width) || width < MIN_W) throw new Error(`그림 너비는 ${MIN_W} 이상이어야 한다`);
  const scale = o.scale || 2;
  const plotX0 = Math.round(width * (PLOT_X0 / W));
  const plotX1 = width - PAD;
  const valX = Math.round(width * (VAL_X / W));
  const height = HEAD + rows.length * ROW + FOOT;

  const ops = [];
  const geo = [];
  const T = (x, y, text, size, color, align, extra) => {
    const t = {
      op: 'text', x, y, text: String(text), size, color,
      align: align || 'left', weight: (extra && extra.weight) || 'normal',
      row: (extra && extra.row != null) ? extra.row : -1,
      line: (extra && extra.line) || 'etc',
    };
    t.w = textWidth(t.text, t.size);
    ops.push(t);
    return t;
  };
  const line = (x0, y0, x1, y1, color, w) => ops.push({ op: 'line', x0, y0, x1, y1, color, width: w || 1 });

  /* 범례 — 오른쪽 위. 제목 칸을 정하려면 범례 폭을 먼저 잡아야 한다 */
  const legend = [
    ['diamond', COLORS.target, '우리 지역'],
    ['circle', COLORS.avg, '비교평균'],
    ['rect', COLORS.iqr, 'IQR(Q1~Q3)'],
    ['line', COLORS.whisker, 'Min~Max'],
  ];
  let lx = width - PAD;
  for (let i = legend.length - 1; i >= 0; i--) {
    const [kind, color, label] = legend[i];
    const w = textWidth(label, 9.5);
    T(lx, 40, label, 9.5, COLORS.caption, 'right', { line: 'legend' });
    const mx = lx - w - 12;
    if (kind === 'diamond') ops.push({ op: 'diamond', x: mx, y: 36.5, r: 4.5, fill: color, stroke: '#fff' });
    else if (kind === 'circle') ops.push({ op: 'circle', x: mx, y: 36.5, r: 4.5, fill: color, stroke: '#fff' });
    else if (kind === 'rect') ops.push({ op: 'rect', x: mx - 5, y: 33, w: 10, h: 7, fill: color });
    else line(mx - 5, 36.5, mx + 5, 36.5, color, 2);
    lx = mx - 14;
  }
  const headRoom = Math.max(120, lx - 12 - PAD);   // 범례 왼쪽 끝까지가 머리글 자리

  /* 머리말 */
  const title = o.title ? `지역사회보장지표 — ${o.title}` : '지역사회보장지표 비교';
  T(PAD, 34, ellipsize(title, 17, headRoom), 17, COLORS.avg, 'left', { weight: 'bold', line: 'title' });
  const part = o.part && o.part.total > 1 ? o.part : null;
  const sub = o.subtitle || [
    o.basis ? `${basisLabel(o.basis)} 비교` : null,
    o.year ? `${o.year}년 기준` : '지표별 최신연도 기준',
    `지표 ${rows.length}개` + (part ? ` (${part.index}/${part.total}쪽)` : ''),
  ].filter(Boolean).join(' · ');
  T(PAD, 55, ellipsize(sub, 11, width - PAD * 2), 11, COLORS.caption, 'left', { line: 'subtitle' });
  line(PAD, 66, width - PAD, 66, COLORS.rule, 1);

  /* 지표 줄 */
  rows.forEach((r, i) => {
    const top = HEAD + i * ROW;
    const axisY = top + 40;
    /* 유한한 수가 아니면(NaN·Infinity·문자열) 좌표가 통째로 NaN이 되어 그림이 깨진다.
       그런 줄은 값이 없는 줄과 똑같이 안내 문구로 대신한다 */
    const fin = (v) => typeof v === 'number' && Number.isFinite(v);
    const has = r.n > 0 && fin(r.min) && fin(r.max) && fin(r.q1) && fin(r.q3) && fin(r.avg);

    /* 가운데 칸(우리 값·평균)의 실제 폭만큼 왼쪽 칸을 줄여 글자가 부딪히지 않게 한다 */
    const mineText = fmtRef(r.mine);
    const avgText = `평균 ${fmtRef(r.avg)}`;
    const nameRoom = Math.max(80, valX - Math.max(textWidth(mineText, 16), textWidth(avgText, 10)) - 16 - NAME_X);

    T(NAME_X, top + 24, ellipsize(r.name, 13, nameRoom), 13, COLORS.name, 'left',
      { weight: 'bold', row: i, line: 'name' });
    const meta = `단위: ${r.unit || '–'} · ${r.year}년` + (r.areaName ? ` · ${r.area}. ${r.areaName}` : '');
    T(NAME_X, top + 45, ellipsize(meta, 10, nameRoom), 10, COLORS.dim, 'left',
      { row: i, line: 'meta' });

    T(valX, top + 27, mineText, 16, COLORS.target, 'right', { weight: 'bold', row: i, line: 'mine' });
    T(valX, top + 46, avgText, 10, COLORS.caption, 'right', { row: i, line: 'avgtext' });

    const g = { code: r.code, top, axisY, x0: plotX0, x1: plotX1, has };
    if (!has) {
      T(plotX0, axisY + 4, `${r.year}년 비교집단 자료 없음`, 10.5, COLORS.dim, 'left',
        { row: i, line: 'empty' });
      geo.push(g);
    } else {
      const pad = (r.max - r.min) * 0.08 || Math.abs(r.max) * 0.08 || 1;
      const lo = r.min - pad, hi = r.max + pad;
      const sx = (v) => {
        if (v == null) return null;
        const t = (v - lo) / (hi - lo);
        return plotX0 + Math.min(1, Math.max(0, t)) * (plotX1 - plotX0);
      };
      g.lo = lo; g.hi = hi; g.sx = sx;

      const xMin = sx(r.min), xMax = sx(r.max), xQ1 = sx(r.q1), xQ3 = sx(r.q3);
      line(xMin, axisY, xMax, axisY, COLORS.whisker, 2);                    // Min~Max
      line(xMin, axisY - 8, xMin, axisY + 8, COLORS.whisker, 2);            // 왼쪽 캡
      line(xMax, axisY - 8, xMax, axisY + 8, COLORS.whisker, 2);            // 오른쪽 캡
      ops.push({ op: 'rect', x: Math.min(xQ1, xQ3), y: axisY - 11, w: Math.max(1, Math.abs(xQ3 - xQ1)), h: 22, fill: COLORS.iqr });
      line(xMin, axisY, xMax, axisY, COLORS.whisker, 2);                    // 상자 위에 다시 그어 선을 살린다
      ops.push({ op: 'circle', x: sx(r.avg), y: axisY, r: 6, fill: COLORS.avg, stroke: '#fff' });
      if (fin(r.mine)) ops.push({ op: 'diamond', x: sx(r.mine), y: axisY, r: 7.5, fill: COLORS.target, stroke: '#fff' });

      /* 분포 요약 — 여섯 칸으로 나눠 칸 가운데에 놓아 겹치지 않게 한다 */
      const cells = [['Min', fmtRef(r.min)], ['Q1', fmtRef(r.q1)], ['평균', fmtRef(r.avg)],
        ['Q3', fmtRef(r.q3)], ['Max', fmtRef(r.max)], ['N', String(r.n)]];
      const slot = (plotX1 - plotX0) / cells.length;
      let size = 9;
      const fits = (s) => cells.every(([k, v]) => textWidth(`${k} ${v}`, s) <= slot - 6);
      while (size > 6 && !fits(size)) size -= 0.5;
      cells.forEach(([k, v], j) => {
        const label = fits(size) ? `${k} ${v}` : ellipsize(`${k} ${v}`, size, slot - 6);
        T(plotX0 + slot * (j + 0.5), top + 78, label, size, COLORS.dim, 'center',
          { row: i, line: 'dist' });
      });
      geo.push(g);
    }
    if (i < rows.length - 1) line(PAD, top + ROW - 4, width - PAD, top + ROW - 4, COLORS.rule, 1);
  });

  /* 표주 — 계약에 못박힌 문장. 말줄임을 하면 안 되는 자리라, 좁으면 글자를 줄여 통째로 넣는다 */
  line(PAD, height - FOOT + 6, width - PAD, height - FOOT + 6, COLORS.rule, 1);
  const note = '※ 자료：보건복지부·한국보건사회연구원, 「지역사회보장지표」. ' +
    '값은 지표별 최신연도 기준이며, 평균은 시·군·구 단순평균임.';
  const noteSize = Math.min(9.5, (width - PAD * 2) / textWidth(note, 1));
  T(PAD, height - 12, note, noteSize, COLORS.caption, 'left', { line: 'note' });

  return { width, height, scale, background: COLORS.bg, font: FONT, ops, rows: geo };
}

/* 캔버스 하나 만들기. OffscreenCanvas 우선, 없으면 <canvas> */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  throw new Error('캔버스를 쓸 수 없는 환경이다 — 브라우저에서 불러야 한다');
}

/* 배치 결과를 캔버스에 칠한다. 계산은 하지 않는다 */
export function paintLayout(ctx, layout) {
  ctx.save();
  ctx.fillStyle = layout.background;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.lineCap = 'butt';
  for (const it of layout.ops) {
    if (it.op === 'text') {
      ctx.font = `${it.weight === 'bold' ? 'bold ' : ''}${it.size}px ${layout.font}`;
      ctx.fillStyle = it.color;
      ctx.textAlign = it.align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(it.text, it.x, it.y);
    } else if (it.op === 'line') {
      ctx.beginPath();
      ctx.strokeStyle = it.color;
      ctx.lineWidth = it.width;
      ctx.moveTo(it.x0, it.y0);
      ctx.lineTo(it.x1, it.y1);
      ctx.stroke();
    } else if (it.op === 'rect') {
      ctx.fillStyle = it.fill;
      ctx.fillRect(it.x, it.y, it.w, it.h);
    } else if (it.op === 'circle') {
      ctx.beginPath();
      ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
      ctx.fillStyle = it.fill;
      ctx.fill();
      if (it.stroke) { ctx.strokeStyle = it.stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
    } else if (it.op === 'diamond') {
      ctx.beginPath();
      ctx.moveTo(it.x, it.y - it.r);
      ctx.lineTo(it.x + it.r, it.y);
      ctx.lineTo(it.x, it.y + it.r);
      ctx.lineTo(it.x - it.r, it.y);
      ctx.closePath();
      ctx.fillStyle = it.fill;
      ctx.fill();
      if (it.stroke) { ctx.strokeStyle = it.stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
  }
  ctx.restore();
}

async function canvasToPng(canvas) {
  if (typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof canvas.toBlob === 'function') {
    const blob = await new Promise((res, rej) => canvas.toBlob(
      (b) => b ? res(b) : rej(new Error('캔버스를 PNG로 바꾸지 못했다')), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error('이 환경의 캔버스는 PNG 내보내기를 못 한다');
}

/* renderComparisonChart(rows, opts) → PNG 바이트.
   배경은 흰색 고정(인쇄용), devicePixelRatio 는 보지 않고 opts.scale(기본 2)만 쓴다 */
export async function renderComparisonChart(rows, opts) {
  const layout = layoutChart(rows, opts);
  const s = layout.scale;
  const canvas = makeCanvas(Math.round(layout.width * s), Math.round(layout.height * s));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 그리기 맥락을 얻지 못했다');
  ctx.scale(s, s);
  paintLayout(ctx, layout);
  return canvasToPng(canvas);
}
