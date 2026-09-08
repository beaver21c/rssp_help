/**
 * 첨부파일 → 텍스트·표 추출.
 *
 * 외부 라이브러리를 쓰지 않는다. zip 해제는 ./zip.js, XML 훑기는 ./xml.js,
 * hwpx 되읽기는 ./docread.js를 쓴다 — 본문 구역만 읽어야 표지·제출문·목차가 섞이지 않는다.
 * 브라우저에서 뽑을 수 없는 형식(pdf·이미지)은 파싱하지 않고 base64로 담아
 * 원본 그대로 Gemini에 보낸다.
 */
"use strict";

import { unzip } from './zip.js';
import { attr } from './xml.js';
import { readBodyText } from './docread.js';

export const SUPPORTED = ['hwpx', 'xlsx', 'xlsm', 'csv', 'pptx', 'txt', 'md',
  'html', 'htm', 'pdf', 'png', 'jpg', 'jpeg'];

/** 20MB. 이 위로는 브라우저 메모리도 Gemini 요청도 감당이 안 된다. */
export const MAX_BYTES = 20 * 1024 * 1024;

/** 한 파일에서 표로 담을 칸 수 상한. 넘으면 뒤를 잘라 내고 사유를 적는다. */
export const MAX_CELLS = 40000;

/** 표 한 행이 벌릴 수 있는 칸 수 상한. 망가진 `colspan="5000000"`에 메모리를 다 쓰지 않는다. */
export const MAX_COLS = 4096;

/** 엑셀이 허용하는 열 수(XFD). 이보다 먼 칸 이름은 망가진 파일이다. */
const SHEET_COLS = 16384;

const INLINE_MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

// ──────────────────────────────────────────────────────────────
// 공용 도구
// ──────────────────────────────────────────────────────────────
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const REF_RE = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * 숫자 문자 참조(`&#10;` `&#x1F600;`)를 글자로. 범위 밖이면 null.
 * String.fromCodePoint는 유니코드 범위를 넘으면 RangeError를 던진다 —
 * 망가진 문서 하나에 추출 전체가 뻗으면 안 되니 여기서 걸러 낸다.
 */
function charRef(body) {
  const code = /^#x/i.test(body)
    ? Number.parseInt(body.slice(2), 16)
    : Number.parseInt(body.slice(1), 10);
  if (!Number.isInteger(code) || code < 0 || code > 0x10FFFF) return null;
  if (code >= 0xD800 && code <= 0xDFFF) return null;      // 짝 없는 서러게이트는 글자가 아니다
  return String.fromCodePoint(code);
}

const XML_NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/**
 * OOXML 글자 되살리기. `xml.js`의 unescapeXml과 달리 숫자 참조도 푼다 —
 * 엑셀은 셀 안 줄바꿈을 `&#10;`으로 적는다. 한 번만 훑으므로 `&amp;#10;`은
 * `&#10;` 글자 그대로 남는다(두 번 풀면 없는 줄바꿈이 생긴다).
 */
export function unxml(text) {
  return String(text == null ? '' : text).replace(REF_RE, (whole, body) => {
    if (hasOwn(XML_NAMED, body)) return XML_NAMED[body];
    if (body.startsWith('#')) return charRef(body) ?? whole;
    return whole;
  });
}

export function extOf(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot < 0 ? '' : String(name).slice(dot + 1).toLowerCase();
}

async function readBytes(file) {
  if (!file) throw new Error('첨부할 파일이 없다.');
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  if (file.bytes instanceof Uint8Array) return file.bytes;
  if (file.data instanceof Uint8Array) return file.data;
  throw new Error('읽을 수 없는 파일 객체다. File 또는 {name, bytes}를 넘겨라.');
}

const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

/** UTF-8로 먼저 읽고, 깨지면 EUC-KR(옛 한글 문서)로 다시 읽는다. BOM은 뗀다. */
export function decodeText(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder('euc-kr').decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes);
    }
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** 바이트 → base64(패딩 포함, 접두어 없음). 브라우저·Node 양쪽에서 돈다. */
export function toBase64(bytes) {
  if (typeof btoa === 'function') {
    let binary = '';
    const step = 0x8000;                       // 한 번에 다 넘기면 인자 수 한계에 걸린다
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  throw new Error('base64로 바꿀 방법이 없는 실행 환경이다.');
}

/** 행마다 열 수가 다르면 짧은 쪽을 빈 칸으로 채운다. 빈 행은 버린다. */
function squareUp(rows) {
  const kept = rows.filter((row) => row.some((cell) => cell !== ''));
  if (!kept.length) return [];
  const width = Math.max(...kept.map((row) => row.length));
  return kept.map((row) => {
    const out = row.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
}

const cellCount = (table) => table.reduce((sum, row) => sum + row.length, 0);

/** 표 목록에 상한까지만 담는다. @returns {{tables, dropped}} */
function capTables(candidates) {
  const tables = [];
  let used = 0;
  let dropped = 0;
  for (const table of candidates) {
    if (!table.length) continue;
    if (used >= MAX_CELLS) { dropped += 1; continue; }
    const width = table[0].length;
    const room = Math.max(1, Math.floor((MAX_CELLS - used) / Math.max(1, width)));
    const cut = table.slice(0, room);
    tables.push(cut);
    used += cellCount(cut);
    if (cut.length < table.length) dropped += 1;
  }
  return { tables, dropped };
}

// ──────────────────────────────────────────────────────────────
// xlsx / xlsm
// ──────────────────────────────────────────────────────────────
/** "BC12" → 열 인덱스 54(0부터). 열 글자가 없으면 -1. */
export function colIndex(ref) {
  let value = 0;
  let seen = 0;
  for (const ch of String(ref || '')) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) { value = value * 26 + (code - 64); seen += 1; }
    else if (code >= 97 && code <= 122) { value = value * 26 + (code - 96); seen += 1; }
    else break;
  }
  return seen ? value - 1 : -1;
}

/** zip 경로 정규화. Target이 "/xl/..."이거나 "../"를 품을 수 있다. */
function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${base}/${target}`.split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

function sharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  for (const m of xml.matchAll(/<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    const inner = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');   // 후리가나는 본문이 아니다
    let text = '';
    for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += unxml(t[1]);
    out.push(text);
  }
  return out;
}

function cellValue(attrs, inner, shared) {
  const kind = attr(attrs, 't', 'n');
  if (kind === 'inlineStr') {
    let text = '';
    for (const t of (inner || '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += unxml(t[1]);
    return text;
  }
  const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner || '');
  if (!v) return '';
  const raw = unxml(v[1]);
  if (kind === 's') {
    const index = Number.parseInt(raw, 10);
    return Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : '';
  }
  if (kind === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;                                   // 숫자·수식 결과(str)·오류(e) 모두 글자 그대로
}

/** 시트 XML → 행 배열. 열은 r 속성으로 자리를 맞춰 빈 칸을 채운다. */
export function sheetRows(xml, shared) {
  const rows = [];
  const data = /<sheetData(?:\s[^>]*)?>([\s\S]*?)<\/sheetData>/.exec(xml || '');
  if (!data) return rows;
  for (const rm of data[1].matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const body = rm[2] || '';
    const cells = [];
    let auto = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = colIndex(attr(cm[1], 'r'));
      //: 엑셀 열 수를 넘는 칸 이름은 망가진 파일이다. 그대로 믿으면 배열 길이가
      //  수억이 되어 RangeError로 뻗는다. 앞 칸 다음 자리에 놓고 넘어간다.
      const index = at >= 0 && at < SHEET_COLS ? at : auto;
      auto = index + 1;
      while (cells.length < index) cells.push('');
      cells[index] = cellValue(cm[1], cm[2], shared);
    }
    rows.push(cells);
  }
  return rows;
}

/** 통합문서 차례대로 [{name, rows}]. rels가 없으면 파일 이름 번호순으로 민다. */
async function readWorkbook(parts) {
  const text = (name) => (parts.has(name) ? new TextDecoder().decode(parts.get(name)) : '');
  const shared = sharedStrings(text('xl/sharedStrings.xml'));
  const rels = new Map();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = attr(m[1], 'Id');
    const target = unxml(attr(m[1], 'Target'));
    if (id && target) rels.set(id, resolvePath('xl', target));
  }

  const order = [];
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/>/g)) {
    const path = rels.get(attr(m[1], 'r:id'));
    if (!path || !parts.has(path)) continue;
    order.push({ name: unxml(attr(m[1], 'name')) || `시트${order.length + 1}`, path });
  }
  if (!order.length) {
    const names = [...parts.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number.parseInt(a.match(/\d+/)[0], 10) - Number.parseInt(b.match(/\d+/)[0], 10));
    names.forEach((path, i) => order.push({ name: `시트${i + 1}`, path }));
  }
  if (!order.length) throw new Error('엑셀 안에 시트가 없다.');

  return order.map(({ name, path }) => ({ name, rows: squareUp(sheetRows(text(path), shared)) }));
}

async function fromXlsx(bytes) {
  const sheets = await readWorkbook(await unzip(bytes));
  const filled = sheets.filter((s) => s.rows.length);
  const { tables, dropped } = capTables(filled.map((s) => s.rows));

  //: 잘림은 늘 뒤쪽에서만 일어나니 tables와 filled의 앞자리는 서로 맞는다.
  const lines = [`시트 ${sheets.length}개 가운데 내용이 있는 것 ${filled.length}개.`];
  tables.forEach((table, i) => {
    lines.push(`${i + 1}. ${filled[i].name} — ${table.length}행 × ${table[0].length}열`);
  });
  if (dropped) lines.push(`※ 표가 커서 ${MAX_CELLS}칸까지만 담았다. 시트 ${dropped}개가 잘렸다.`);

  return {
    text: lines.join('\n'),
    tables,
    //: 191개 시트 가운데 14개만 담고서 "191개에서 뽑았다"고 하면 거짓말이 된다
    note: dropped
      ? `엑셀 시트 ${filled.length}개 가운데 ${tables.length}개만 표로 담았다(${MAX_CELLS}칸 상한)`
      : `엑셀 시트 ${filled.length}개에서 표를 뽑았다`,
  };
}

// ──────────────────────────────────────────────────────────────
// pptx
// ──────────────────────────────────────────────────────────────
function slideParagraphs(xml) {
  const out = [];
  for (const pm of xml.matchAll(/<a:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/a:p>)/g)) {
    let line = '';
    for (const piece of (pm[1] || '').matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br(?:\s[^>]*)?\/>/g)) {
      line += piece[1] === undefined ? '\n' : unxml(piece[1]);   // 같은 문단의 런은 이어 붙인다
    }
    const trimmed = line.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function slideTables(xml) {
  const out = [];
  for (const tm of xml.matchAll(/<a:tbl(?:\s[^>]*)?>([\s\S]*?)<\/a:tbl>/g)) {
    const rows = [];
    for (const rm of tm[1].matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<a:tc\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:tc>)/g)) {
        cells.push(slideParagraphs(cm[2] || '').join('<br>'));
      }
      if (cells.length) rows.push(cells);
    }
    const table = squareUp(rows);
    if (table.length) out.push(table);
  }
  return out;
}

async function fromPptx(bytes) {
  const parts = await unzip(bytes);
  const slides = [...parts.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number.parseInt(a.match(/\d+/)[0], 10) - Number.parseInt(b.match(/\d+/)[0], 10));
  if (!slides.length) throw new Error('파워포인트 안에 슬라이드가 없다.');

  const chunks = [];
  const candidates = [];
  slides.forEach((name, i) => {
    const xml = new TextDecoder().decode(parts.get(name));
    const body = slideParagraphs(xml).join('\n');
    chunks.push(`--- 슬라이드 ${i + 1} ---\n${body}`.trim());
    candidates.push(...slideTables(xml));
  });
  const { tables, dropped } = capTables(candidates);

  return {
    text: chunks.join('\n\n'),
    tables,
    note: `슬라이드 ${slides.length}장, 표 ${tables.length}개를 뽑았다`
      + (dropped ? ` (표 ${dropped}개는 잘렸다)` : ''),
  };
}

// ──────────────────────────────────────────────────────────────
// csv
// ──────────────────────────────────────────────────────────────
/** RFC 4180. 따옴표 안의 구분자·개행·이스케이프("")를 그대로 살린다. */
export function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (text[i + 1] === '"') { field += '"'; i += 1; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = ''; rows.push(row); row = [];
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 앞뒤 두 열쇠를 사전식으로 견준다. 앞자리가 클수록 좋은 후보다. */
function ranksAbove(key, other) {
  for (let i = 0; i < key.length; i += 1) {
    if (key[i] !== other[i]) return key[i] > other[i];
  }
  return false;
}

/**
 * 첫 5행의 열 수가 가장 고른 구분자를 고른다.
 * 열쇠는 [열이 둘 이상인가, 흩어짐이 작은가, 열이 많은가] 차례.
 */
export function pickDelimiter(sample) {
  let best = ',';
  let bestKey = null;
  for (const delimiter of [',', '\t', ';']) {
    const rows = parseCsv(sample, delimiter).slice(0, 5).filter((r) => r.length);
    if (!rows.length) continue;
    const counts = rows.map((r) => r.length);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const spread = counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length;
    const key = [mean > 1 ? 1 : 0, -spread, mean];
    if (!bestKey || ranksAbove(key, bestKey)) { bestKey = key; best = delimiter; }
  }
  return best;
}

function fromCsv(bytes) {
  const text = decodeText(bytes);
  const delimiter = pickDelimiter(text.slice(0, 65536));
  const rows = squareUp(parseCsv(text, delimiter).map((r) => r.map((c) => c.trim())));
  const { tables, dropped } = capTables(rows.length ? [rows] : []);
  if (!tables.length) return { text: '', tables: [], note: '' };   // 바깥문이 빈 파일로 걷어낸다
  const label = delimiter === '\t' ? '탭' : `'${delimiter}'`;
  const width = tables[0][0].length;
  return {
    text: `구분자 ${label}. ${tables[0].length}행 × ${width}열.`
      + (dropped ? `\n※ 표가 커서 ${MAX_CELLS}칸까지만 담았다.` : ''),
    tables,
    note: `CSV ${tables[0].length}행을 표로 읽었다`,
  };
}

// ──────────────────────────────────────────────────────────────
// html
// ──────────────────────────────────────────────────────────────
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", middot: '·',
};

function decodeEntities(text) {
  return text.replace(REF_RE, (whole, body) => {
    if (hasOwn(ENTITIES, body)) return ENTITIES[body];
    // 범위 밖 숫자 참조(`&#999999999;`)는 글자로 바꿀 수 없다. 원문 그대로 둔다
    if (body.startsWith('#')) return charRef(body) ?? whole;
    return whole;
  });
}

const BLOCK_TAGS = ['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr',
  'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'table', 'td', 'th'];
const BLOCK_END = new RegExp(`</(${BLOCK_TAGS.join('|')})\\s*>`, 'gi');

function tidyText(text) {
  return text.split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** `colspan` 값 → 벌릴 칸 수. 빈 값·글자·음수·터무니없는 수를 모두 걷어 낸다. */
function spanOf(raw) {
  const n = Number.parseInt(raw || '1', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_COLS);
}

/** DOMParser가 없는 자리(Node 시험)에서 쓰는 정규식 갈래. */
export function htmlByRegex(source) {
  let html = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, '');

  const tables = [];
  html = html.replace(/<table\b[\s\S]*?<\/table\s*>/gi, (block) => {
    const rows = [];
    for (const rm of block.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
        if (cells.length >= MAX_COLS) break;
        const span = spanOf(attr(cm[2], 'colspan'));
        cells.push(tidyText(decodeEntities(cm[3].replace(/<[^>]+>/g, ' '))).replace(/\n+/g, ' '));
        // 합친 칸만큼 자리를 벌린다. 망가진 colspan은 MAX_COLS에서 끊는다
        for (let k = 1; k < span && cells.length < MAX_COLS; k += 1) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    const table = squareUp(rows);
    if (table.length) tables.push(table);
    return '\n';                                                // 표는 tables로만 담는다
  });

  const text = tidyText(decodeEntities(html
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]+>/g, ' ')));
  return { text, tables };
}

function htmlByDom(source) {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach((node) => node.remove());

  const tables = [];
  for (const node of doc.querySelectorAll('table')) {
    //: 표 안의 표는 바깥 표를 담을 때 이미 걷혔다. 두 번 담지 않는다.
    if (!doc.contains(node)) continue;
    const rows = [];
    for (const tr of node.querySelectorAll('tr')) {
      const cells = [];
      for (const td of tr.querySelectorAll('td, th')) {
        if (cells.length >= MAX_COLS) break;
        const span = spanOf(td.getAttribute('colspan'));
        cells.push(tidyText(td.textContent || '').replace(/\n+/g, ' '));
        for (let k = 1; k < span && cells.length < MAX_COLS; k += 1) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    const table = squareUp(rows);
    if (table.length) tables.push(table);
    node.remove();                                              // 표는 tables로만 담는다
  }

  const walk = (node) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') { out += '\n'; continue; }
      out += walk(child);
      if (BLOCK_TAGS.includes(tag)) out += '\n';
    }
    return out;
  };
  return { text: tidyText(walk(doc.body || doc)), tables };
}

function fromHtml(bytes) {
  const source = decodeText(bytes);
  const picked = typeof DOMParser !== 'undefined' ? htmlByDom(source) : htmlByRegex(source);
  const { tables, dropped } = capTables(picked.tables);
  return {
    text: picked.text,
    tables,
    note: `HTML 본문 ${picked.text.length}자, 표 ${tables.length}개를 뽑았다`
      + (dropped ? ` (표 ${dropped}개는 잘렸다)` : ''),
  };
}

// ──────────────────────────────────────────────────────────────
// hwpx
// ──────────────────────────────────────────────────────────────
/** 마커 원고에서 파이프 표를 뽑는다. docread가 표를 파이프 표기로 내놓는다. */
function pipeTables(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split('\n')) {
    const s = raw.trim();
    const isRow = s.startsWith('|') && s.endsWith('|') && s.length > 2;
    if (isRow) {
      const body = s.slice(1, -1);
      if (/^[\s:|-]+$/.test(body)) continue;              // 머리행 아래 구분선
      const cells = body.split('|').map((c) => c.trim());
      if (!cur) { cur = [cells]; out.push(cur); } else cur.push(cells);
    } else if (s) {
      cur = null;
    }
  }
  return out.map(squareUp);
}

async function fromHwpx(bytes, form) {
  const rb = await readBodyText(bytes, form || null);
  const { tables, dropped } = capTables(pipeTables(rb.text));
  const where = rb.skipped && rb.skipped.length
    ? ` (본문 구역 ${rb.section}만 읽었고 표지·제출문 구역은 건너뛰었다)` : '';
  return {
    text: rb.text,
    tables,
    note: `한글 문서에서 문단과 표 ${tables.length}개를 읽었다`
      + (dropped ? ` (표 ${dropped}개는 잘렸다)` : '') + where,
  };
}

// ──────────────────────────────────────────────────────────────
// 바깥문
// ──────────────────────────────────────────────────────────────
/**
 * 첨부파일 하나를 Attachment로 바꾼다.
 * @param {File|{name:string,bytes:Uint8Array}} file
 * @returns {Promise<{name,ext,mode,text,tables,inline,bytes,note}>}
 */
export async function extractAttachment(file, opts = {}) {
  const name = (file && file.name) || '';
  const ext = extOf(name);
  if (!SUPPORTED.includes(ext)) {
    throw new Error(`지원하지 않는 형식이다(.${ext || '확장자 없음'}). `
      + `쓸 수 있는 것: ${SUPPORTED.join(', ')}`);
  }
  if (typeof file.size === 'number' && file.size > MAX_BYTES) {
    throw new Error(`${mb(file.size)}짜리 파일이다. ${mb(MAX_BYTES)}까지만 올릴 수 있다.`);
  }

  const bytes = await readBytes(file);
  if (bytes.length > MAX_BYTES) {
    throw new Error(`${mb(bytes.length)}짜리 파일이다. ${mb(MAX_BYTES)}까지만 올릴 수 있다.`);
  }
  if (!bytes.length) throw new Error('빈 파일이다.');

  const base = {
    name, ext, mode: 'text', text: '', tables: [], inline: null, bytes: bytes.length, note: '',
  };

  if (INLINE_MIME[ext]) {
    return {
      ...base,
      mode: 'inline',
      inline: { mimeType: INLINE_MIME[ext], data: toBase64(bytes) },
      note: `${ext.toUpperCase()} 원본을 그대로 보낸다(브라우저에서 안 뜯음)`,
    };
  }

  let picked;
  if (ext === 'hwpx') picked = await fromHwpx(bytes, opts.form);
  else if (ext === 'xlsx' || ext === 'xlsm') picked = await fromXlsx(bytes);
  else if (ext === 'pptx') picked = await fromPptx(bytes);
  else if (ext === 'csv') picked = fromCsv(bytes);
  else if (ext === 'html' || ext === 'htm') picked = fromHtml(bytes);
  else {
    const text = decodeText(bytes).trim();
    picked = { text, tables: [], note: `글자 ${text.length}자를 그대로 읽었다` };
  }

  if (!picked.text && !picked.tables.length) throw new Error('뽑아낼 글자도 표도 없다.');
  return { ...base, ...picked };
}
