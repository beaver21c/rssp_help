/* 올린 hwpx를 마커 원고로 되돌린다 — 본문 구역만, 양식 카드의 스타일 번호로 되짚어서.
 *
 * readback.js의 readBack()은 두 가지가 이 프로젝트에 맞지 않는다.
 *  1) Contents/ 아래 xml을 전부 읽는다 → 표지·제출문·목차가 원고에 섞이고,
 *     그대로 다시 조판하면 목차가 본문 구역으로 들어가 문서가 망가진다.
 *  2) 스타일과 마커의 대응을 글자 모양으로 추정한다 → '가.' 절이 '#'로, 개조식이
 *     전부 '###'로 돌아온다.
 *
 * 여기서는 본문 구역 하나만 골라, `form.levels[].style`(스타일 번호)로 마커를 되짚는다.
 * hwpx-form.js가 마커→스타일로 조판하므로 이쪽은 그 역함수이고 왕복이 맞아떨어진다.
 * 우리 양식으로 만들지 않은 문서(스타일 번호가 안 맞는 문서)는 readback.js로 넘긴다.
 */
"use strict";

import { unzip } from './zip.js';
import { readBlocks, classify, toMarkerText, renderReadbackReport } from './readback.js';
import { refuseBinaryHwp } from './xml.js';

const DEC = new TextDecoder();
const SECTION_RE = /^Contents\/section\d+\.xml$/;

/* ───────── XML 훑기 (중첩을 견디는 최소 주사기) ───────── */

/** 여는 태그 자리에서 짝이 맞는 닫는 태그까지를 돌려준다. 없으면 null. */
export function spanOf(xml, tag, from = 0) {
  const open = new RegExp(`<${tag}(?=[\\s/>])[^>]*?(/?)>`, 'g');
  open.lastIndex = from;
  const first = open.exec(xml);
  if (!first) return null;
  if (first[1] === '/') {
    return { start: first.index, inner: '', end: open.lastIndex, attr: first[0] };
  }
  const innerStart = open.lastIndex;
  const scan = new RegExp(`<${tag}(?=[\\s/>])[^>]*?(/?)>|</${tag}>`, 'g');
  scan.lastIndex = innerStart;
  let depth = 1, m;
  while ((m = scan.exec(xml))) {
    if (m[0].startsWith('</')) {
      if (--depth === 0) {
        return { start: first.index, inner: xml.slice(innerStart, m.index), end: scan.lastIndex, attr: first[0] };
      }
    } else if (m[1] !== '/') depth++;
  }
  return null;
}

/** 같은 깊이의 태그를 차례로 돌려준다. */
export function* eachSpan(xml, tag) {
  let at = 0;
  for (;;) {
    const sp = spanOf(xml, tag, at);
    if (!sp) return;
    yield sp;
    at = sp.end;
  }
}

const attrOf = (attr, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attr || '');
  return m ? m[1] : null;
};
const unesc = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** 표를 뺀 문단 글자. 탭은 공백으로, 줄바꿈 개체는 지운다. */
function paraText(inner) {
  let rest = inner;
  for (;;) {                                    // 셀 안 글자는 문단 글자가 아니다
    const t = spanOf(rest, 'hp:tbl', 0);
    if (!t) break;
    rest = rest.slice(0, t.start) + rest.slice(t.end);
  }
  const out = [];
  for (const m of rest.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>|<hp:tab\b[^>]*\/?>/g)) {
    out.push(m[1] === undefined ? ' ' : unesc(m[1]));
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** 표 하나를 행×열 문자열로 편다. 병합 칸은 빈 칸으로 채운다. */
function tableGrid(sp) {
  const rows = Number(attrOf(sp.attr, 'rowCnt') || 0);
  const cols = Number(attrOf(sp.attr, 'colCnt') || 0);
  const grid = Array.from({ length: rows }, () => Array(cols).fill(''));
  const width = Array(cols).fill(0);
  let r = 0;
  for (const tr of eachSpan(sp.inner, 'hp:tr')) {
    for (const tc of eachSpan(tr.inner, 'hp:tc')) {
      const span = spanOf(tc.inner, 'hp:cellSpan', 0);
      const addr = spanOf(tc.inner, 'hp:cellAddr', 0);
      const sz = spanOf(tc.inner, 'hp:cellSz', 0);
      const cs = Number(attrOf(span && span.attr, 'colSpan') || 1);
      const rs = Number(attrOf(span && span.attr, 'rowSpan') || 1);
      let col = Number(attrOf(addr && addr.attr, 'colAddr') ?? NaN);
      let row = Number(attrOf(addr && addr.attr, 'rowAddr') ?? NaN);
      if (!Number.isFinite(row)) row = r;
      if (!Number.isFinite(col)) { col = grid[row] ? grid[row].findIndex((v) => v === '') : 0; }
      const text = [...eachSpan(tc.inner, 'hp:p')].map((p) => paraText(p.inner)).filter(Boolean).join(' ');
      if (grid[row] && col >= 0 && col < cols) grid[row][col] = text;
      const w = Number(attrOf(sz && sz.attr, 'width') || 0);
      if (w && col >= 0 && col < cols && cs === 1) width[col] = Math.max(width[col], w);
    }
    r++;
  }
  const total = width.reduce((a, b) => a + b, 0);
  const pct = total ? width.map((w) => Math.max(1, Math.round(w / total * 100))) : null;
  return { rows, cols, grid, colWidths: pct };
}

/* ───────── 되돌리기 ───────── */

function markerMap(form) {
  const m = new Map();
  for (const lv of (form.levels || [])) {
    if (lv.style != null) m.set(Number(lv.style), lv.marker || '');
  }
  const tn = form.table_note;
  if (tn && tn.style != null) m.set(Number(tn.style), tn.marker || '※');
  return m;
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes 올린 hwpx
 * @param {object} form 양식 카드
 * @returns {Promise<{text,report,section,skipped,mode,matched,total}>}
 */
export async function readBodyText(bytes, form) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  refuseBinaryHwp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const entries = await unzip(buf);
  const sections = [...entries.keys()].filter((n) => SECTION_RE.test(n)).sort();
  if (!sections.length) throw new Error('hwpx 안에서 본문 구역을 찾지 못했다');

  // 양식이 지목한 구역을 쓰되, 없으면 가장 큰 구역을 본문으로 본다
  let target = form && form.section && entries.has(form.section) ? form.section : null;
  if (!target) target = sections.reduce((a, b) => (entries.get(b).length > entries.get(a).length ? b : a));

  const xml = DEC.decode(entries.get(target));
  const sec = spanOf(xml, 'hs:sec', 0);
  const body = sec ? sec.inner : xml;
  const marks = markerMap(form || {});
  const noteStyle = form && form.table_note ? Number(form.table_note.style) : -1;

  const lines = [];
  let matched = 0, total = 0;
  for (const p of eachSpan(body, 'hp:p')) {
    const style = Number(attrOf(p.attr, 'styleIDRef') || 0);
    const tbl = spanOf(p.inner, 'hp:tbl', 0);
    if (tbl) {
      const { cols, grid, colWidths } = tableGrid(tbl);
      if (!cols || !grid.length) continue;
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      if (colWidths) lines.push(`{cols=${colWidths.join(',')}}`);
      lines.push('| ' + grid[0].map((c) => c || ' ').join(' | ') + ' |');
      lines.push('|' + Array(cols).fill('---').join('|') + '|');
      for (const row of grid.slice(1)) lines.push('| ' + row.map((c) => c || ' ').join(' | ') + ' |');
      continue;
    }
    const text = paraText(p.inner);
    if (!text) { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); continue; }
    total++;
    const mk = marks.get(style);
    if (mk !== undefined) matched++;
    if (style === noteStyle) lines.push(text.startsWith('※') ? text : `※ ${text}`);
    else lines.push(mk ? `${mk} ${text}` : text);
  }

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const ratio = total ? matched / total : 0;

  // 스타일이 우리 양식과 거의 안 맞으면 남의 서식이다 → readback.js의 추정 경로로 넘긴다
  if (ratio < 0.35) {
    const parts = { [target]: xml };
    const blocks = readBlocks(parts);
    if (blocks.length) {
      const markers = ((form || {}).levels || []).map((lv) => lv.marker).filter(Boolean);
      return {
        text: toMarkerText(blocks, markers).replace(/<[^>]+>/g, ''),
        report: renderReadbackReport(blocks, markers, classify(blocks)),
        section: target, skipped: sections.filter((n) => n !== target),
        mode: 'guess', matched, total,
      };
    }
  }
  if (!total) throw new Error(`${target}에 읽을 글이 없다`);

  return {
    text,
    report: `본문 구역 ${target} · 문단 ${total}개 중 ${matched}개를 양식 레벨로 되짚음` +
      (sections.length > 1 ? ` · 건너뛴 구역 ${sections.filter((n) => n !== target).join(', ')}` : ''),
    section: target,
    skipped: sections.filter((n) => n !== target),
    mode: 'style',
    matched, total,
  };
}
