/* 절 카탈로그 — docs/CONTRACTS.md 2장 계약 구현.
 *
 * app/data/sections.json(스키마는 docs/SECTIONS_SCHEMA.md)을 읽어 화면과 AI가 쓰기 좋게
 * 감싼다. 카탈로그 자체는 tools/build_catalog.py가 기계로 뽑은 산출물이므로 여기서는
 * 내용을 고치지 않고 **읽고 조립하는 일만** 한다.
 *
 * 외부 라이브러리를 쓰지 않고 브라우저와 Node 22에서 똑같이 돈다.
 */
"use strict";

const DATA_DIR = new URL('../data/', import.meta.url);
const DEFAULT_SRC = 'sections.json';

/* 마커 체계 — 안내서 원고에서 쓰는 줄머리. 앞쪽이 위 단계다 */
export const HEADINGS = ['#', '##', '###', '####'];
export const BULLETS = ['○', '▪', '-', '·'];
/* 항목이 아니라 주석인 줄머리. 세지도 않고 묶음을 끊지도 않는다 */
const NOTE_MARKS = ['※', '주)', '자료:', '자료：'];

const _cache = { def: null };

/* ───────── 적재 ───────── */

/* 브라우저면 fetch, Node면 fs. window 유무로 갈린다(fetch는 Node 22에도 있어 기준이 못 된다) */
async function readJSON(url) {
  if (typeof window !== 'undefined') {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} 을(를) 읽지 못했다 — HTTP ${r.status}`);
    return r.json();
  }
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    import('node:fs/promises'), import('node:url'),
  ]);
  let text;
  try {
    text = await readFile(fileURLToPath(url), 'utf8');
  } catch (e) {
    throw new Error(`${url} 을(를) 읽지 못했다 — ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${url} 이(가) 올바른 JSON이 아니다 — ${e.message}`);
  }
}

function toUrl(src) {
  if (src instanceof URL) return src;
  if (typeof src !== 'string' || !src) throw new Error('카탈로그 경로가 비었다');
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return new URL(src);
  if (src.startsWith('/') && typeof window === 'undefined') return new URL('file://' + src);
  return new URL(src, DATA_DIR);
}

/**
 * 카탈로그를 읽는다.
 *   loadCatalog()                    → app/data/sections.json (결과를 캐시한다)
 *   loadCatalog(URL|경로)            → 다른 파일(시험용 고정 데이터 따위)
 *   loadCatalog({source, nodes:[…]}) → 이미 손에 든 객체를 색인만 한다
 */
export async function loadCatalog(src) {
  if (src && typeof src === 'object' && !(src instanceof URL)) return indexCatalog(src);
  if (src === undefined && _cache.def) return _cache.def;
  const cat = indexCatalog(await readJSON(toUrl(src === undefined ? DEFAULT_SRC : src)));
  if (src === undefined) _cache.def = cat;
  return cat;
}

/**
 * 마디 목록에 색인·경로를 달아 준다. 덧붙이는 값은 전부 열거 불가라
 * `JSON.stringify(catalog)`는 원본과 같다(카탈로그를 다시 저장해도 오염되지 않는다).
 */
export function indexCatalog(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('카탈로그가 객체가 아니다');
  const nodes = raw.nodes;
  if (!Array.isArray(nodes)) throw new Error('카탈로그에 nodes 배열이 없다');

  const byId = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') throw new Error('마디가 객체가 아니다');
    if (typeof n.id !== 'string' || !n.id) throw new Error('id 없는 마디가 있다');
    if (byId.has(n.id)) throw new Error(`마디 id가 겹친다 — ${n.id}`);
    byId.set(n.id, n);
  }
  /* 뿌리부터 내려오는 이름표 줄기. 지시문 첫머리의 <경로>가 이것이다 */
  for (const n of nodes) {
    const trail = [];
    const seen = new Set();
    for (let cur = n; cur && !seen.has(cur.id); cur = cur.parent ? byId.get(cur.parent) : null) {
      seen.add(cur.id);
      trail.unshift(labelOf(cur));
    }
    hide(n, 'trail', trail);
  }
  hide(raw, 'byId', byId);
  return raw;
}

function hide(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: false, configurable: true, writable: true });
}

const labelOf = (n) => `${n.no ? n.no + ' ' : ''}${n.title || ''}`.trim() || n.id;

/* ───────── 조회 ───────── */

/** id로 마디 하나. 없으면 null(찾지 못한 것은 실패가 아니다) */
export function findSection(catalog, id) {
  if (!catalog || !Array.isArray(catalog.nodes)) throw new Error('카탈로그가 아니다');
  if (!id) return null;
  if (catalog.byId instanceof Map) return catalog.byId.get(id) || null;
  return catalog.nodes.find((n) => n.id === id) || null;
}

/** 어떤 마디의 뿌리부터의 경로 문자열. 없으면 빈 문자열 */
export function pathOf(catalog, id) {
  const n = findSection(catalog, id);
  return n ? trailOf(n).join(' › ') : '';
}

function trailOf(section) {
  if (Array.isArray(section.trail) && section.trail.length) return section.trail;
  return [labelOf(section)];
}

/**
 * 화면 선택용 평면 목록. 뿌리 → 자식 차례(전위 순회)라 depth가 한 번에 두 단계
 * 이상 깊어지지 않는다. children이 끊긴 마디는 원래 배열 차례로 뒤에 붙인다.
 */
export function sectionList(catalog) {
  if (!catalog || !Array.isArray(catalog.nodes)) throw new Error('카탈로그가 아니다');
  const nodes = catalog.nodes;
  const byId = catalog.byId instanceof Map
    ? catalog.byId : new Map(nodes.map((n) => [n.id, n]));
  const out = [];
  const done = new Set();

  const walk = (node, depth) => {
    if (!node || done.has(node.id)) return;
    done.add(node.id);
    out.push({ id: node.id, label: labelOf(node), depth: typeof node.depth === 'number' ? node.depth : depth });
    for (const cid of (node.children || [])) walk(byId.get(cid), depth + 1);
  };

  for (const n of nodes) if (!n.parent) walk(n, 0);
  for (const n of nodes) if (!done.has(n.id)) walk(n, typeof n.depth === 'number' ? n.depth : 0);
  return out;
}

/** kind==='blank'인 표만 idx 차례로. 원본 객체를 그대로 준다(복사하지 않는다) */
export function blankForms(section) {
  const forms = formsOf(section);
  return forms.filter((f) => f && f.kind === 'blank')
    .slice()
    .sort((a, b) => (a.idx || 0) - (b.idx || 0));
}

function formsOf(section) {
  if (!section || typeof section !== 'object') throw new Error('절 마디가 없다');
  const forms = section.forms;
  if (forms === undefined || forms === null) return [];
  if (!Array.isArray(forms)) throw new Error(`${section.id || '이 마디'}의 forms가 배열이 아니다`);
  return forms;
}

/* ───────── AI 지시문 조립 ───────── */

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/* 같은 문장이 두 번 나오지 않게 한다. 안내서 원문에서 뽑은 제약은 '전략'과 '추진전략'처럼
 * 대상만 다르고 결과 문장은 똑같은 짝이 섞여 있어 그대로 두면 화면에 겹쳐 보인다 */
const dedupe = (arr) => Array.from(new Set(arr));

/** 표 머리행 한 줄. 칸 안 줄바꿈은 한 칸 띄어쓰기로 눕힌다 */
function headerLine(form) {
  const cells = (form.header || []).map((c) => squash(c));
  if (!cells.length || cells.every((c) => !c)) return null;
  return cells.join(' | ');
}

/** limits 한 항목을 사람이 읽는 문장으로 */
export function limitSentence(lim) {
  if (!lim || typeof lim !== 'object') throw new Error('수량 제약이 객체가 아니다');
  const scope = squash(lim.scope) || '항목';
  const unit = lim.unit || '개';
  const n = typeof lim.n === 'number' && Number.isFinite(lim.n) ? String(lim.n) : '몇';
  const body = lim.op === 'min'
    ? `${scope}: ${n}${unit} 이상 쓴다`
    : `${scope}: ${n}${unit} 이내로 쓴다`;
  const src = squash(lim.text);
  return src ? `${body}. 안내서 원문 — “${src}”` : body;
}

/**
 * 절 하나를 쓰게 하는 시스템 지시문. 차례는 고정이다.
 *   1 역할 → 2 지시 → 3 양식 → 4 수량 제약 → 5 문체 → 6 금지
 * 2번 지시는 안내서 원문(howto.raw)을 **한 글자도 자르지 않고** 넣는다.
 */
export function promptFor(section) {
  if (!section || typeof section !== 'object') throw new Error('절 마디가 없다');
  const B = [];

  /* 1. 역할 */
  const path = trailOf(section).join(' › ');
  B.push('[역할]\n' +
    `제6기 지역사회보장계획 ${path} 집필 보조. 산출물은 한글 보고서 본문 원고.`);

  /* 2. 지시 — 안내서 「◆ 작성 취지 및 방법 ◆」 원문 그대로 */
  const h = section.howto;
  let howto;
  if (h && typeof h === 'object') {
    howto = h.raw && String(h.raw).trim()
      ? String(h.raw)
      : [h.purpose ? `작성취지\n${h.purpose}` : '', h.method ? `작성방법\n${h.method}` : '']
        .filter(Boolean).join('\n');
  }
  B.push('[지시]\n' + (howto && howto.trim()
    ? howto
    : '이 마디에는 안내서의 「작성 취지 및 방법」 박스가 없다. 상위 마디 지침과 절 제목이 요구하는 내용만 쓴다.'));

  /* 3. 양식 — 빈 표만, 안내서에 나온 차례대로 */
  const forms = blankForms(section);
  if (forms.length) {
    const L = [`이 절에는 안내서가 정한 표 ${forms.length}개가 들어간다. 행·열 수와 머리행을 그대로 지킨다.`];
    forms.forEach((f, i) => {
      const head = headerLine(f);
      const size = (typeof f.rows === 'number' && typeof f.cols === 'number')
        ? `${f.rows}행 ${f.cols}열` : '행·열 수가 안내서에 적히지 않았다';
      L.push(`표 ${i + 1}: ${size}, ` +
        (head ? `머리행: ${head}` : '머리행 없음 — 안내서의 도표(빈 칸 그림)라 칸 구조만 맞춘다'));
    });
    B.push('[양식]\n' + L.join('\n'));
  } else {
    B.push('[양식]\n이 절에 딸린 빈 표 양식은 없다. 표를 새로 만들지 않는다.');
  }

  /* 4. 수량 제약 — 꼴이 깨진 항목은 버린다(같은 문장은 한 번만 적는다) */
  const limits = (Array.isArray(section.limits) ? section.limits : [])
    .filter((l) => l && typeof l === 'object');
  const limLines = dedupe(limits.map((l) => '- ' + limitSentence(l)));
  B.push('[수량 제약]\n' + (limLines.length
    ? limLines.join('\n')
    : '- 안내서가 못박은 개수 제한은 없다. 그렇다고 늘어놓지 말고 절 분량에 맞춘다.'));

  /* 5. 문체 */
  B.push('[문체]\n' + [
    '- 개조식으로 쓴다. 줄글 서술을 늘어놓지 않는다.',
    '- 보고서 반말체(“~한다”, “~이다”)로 맺는다. 존대·구어 금지.',
    '- 줄머리 마커 체계는 다음을 쓴다.',
    '  # ## ### #### — 제목 단계(위에서 아래로)',
    '  ○ ▪ - · — 본문 항목 단계(위에서 아래로)',
    '  ※ — 주석·참조',
    '- 표는 파이프 표기로 쓴다. `| 항목 | 값 |` 꼴로 머리행을 먼저 놓고,',
    '  바로 다음 줄에 `|---|---|` 구분선을 둔 뒤 자료 행을 잇는다.',
    '- 표 바로 아래 줄에 “※ 자료：…” 형식으로 표 주를 단다.',
    '- 숫자는 천 단위 쉼표를 찍고 단위를 표기한다.',
  ].join('\n'));

  /* 6. 금지 */
  B.push('[금지]\n' + [
    '- 지시에 없는 표를 만들지 않는다. 위 [양식]에 적힌 표만 쓴다.',
    '- 확인되지 않은 통계·법조문·사업명·연도를 지어내지 않는다.',
    '- 빈칸은 ○○로 두고 임의로 채우지 않는다.',
  ].join('\n'));

  return B.join('\n\n');
}

/* ───────── 수량 제약 검사 ───────── */

const TABLE_RE = /^\|.*\|?\s*$/;
const SEP_RE = /^\|[\s:|\-─]+\|?\s*$/;

/** 원고 한 줄을 갈래·단계로 나눈다. 단계는 작을수록 위다 */
function classifyLine(line) {
  const t = line.replace(/^\s+/, '').replace(/\s+$/, '');
  if (!t) return { kind: 'blank' };
  if (TABLE_RE.test(t)) return { kind: SEP_RE.test(t) ? 'sep' : 'table', text: t };
  for (const p of NOTE_MARKS) if (t.startsWith(p)) return { kind: 'note', text: t };
  const m = /^(#{1,4})\s+(.*)$/.exec(t);
  if (m) return { kind: 'item', level: m[1].length, text: m[2] };
  const b = BULLETS.indexOf(t[0]);
  if (b >= 0 && (t.length === 1 || /\s/.test(t[1]))) {
    return { kind: 'item', level: 4 + b + 1, text: t.slice(1).trim() };
  }
  return { kind: 'text', text: t };
}

export function outline(markerText) {
  return String(markerText).split(/\r?\n/).map(classifyLine);
}

/** 머리말 줄 아래에 붙은 같은 단계 항목 수를 센다. 셀 수 없으면 null */
function countUnder(items, at) {
  const anchor = items[at];
  let childLevel = null, count = 0, tableRows = null;
  for (let j = at + 1; j < items.length; j++) {
    const it = items[j];
    if (it.kind === 'blank' || it.kind === 'note' || it.kind === 'sep' || it.kind === 'text') continue;
    if (it.kind === 'table') {
      /* 항목을 이미 세고 있으면 표는 항목에 딸린 자료로 보고 지나친다 */
      if (childLevel !== null || tableRows !== null) continue;
      let rows = 0, head = true;
      for (let k = j; k < items.length; k++) {
        const t = items[k];
        if (t.kind === 'sep') continue;
        if (t.kind !== 'table') break;
        if (head) { head = false; continue; }  /* 머리행은 항목이 아니다 */
        rows++;
      }
      tableRows = rows;
      continue;
    }
    /* kind === 'item' */
    if (it.level <= anchor.level) break;
    if (childLevel === null) childLevel = it.level;
    if (it.level === childLevel) count++;
  }
  if (count > 0) return count;
  if (tableRows) return tableRows;
  return null;
}

/**
 * 산출 원고에서 항목 수를 세어 limits 위반을 잡는다.
 * 돌려주는 값은 위반 사유 문자열 배열이고, 세지 못한 제약은 위반이 아니라
 * `.unknown`(같은 꼴의 문자열 배열)에 따로 담는다.
 */
export function checkLimits(section, markerText) {
  if (!section || typeof section !== 'object') throw new Error('절 마디가 없다');
  if (markerText == null) throw new Error('검사할 원고가 없다');
  const limits = Array.isArray(section.limits) ? section.limits : [];
  const violations = [];
  const unknown = [];
  const items = outline(markerText);

  for (const lim of limits) {
    if (!lim || typeof lim !== 'object') {
      unknown.push('수량 제약 꼴이 깨져 세지 못했다');
      continue;
    }
    const scope = squash(lim.scope);
    /* 개수가 숫자가 아니면 견줄 수가 없다. 조용히 버리지 않고 확인 불가로 남긴다 */
    if (typeof lim.n !== 'number' || !Number.isFinite(lim.n)) {
      unknown.push(`${limitSentence(lim)} — 제한 개수(${lim.n === undefined ? '없음' : String(lim.n)})가 숫자가 아니라 세지 못했다`);
      continue;
    }
    const key = scope.replace(/\s+/g, '');
    if (key.length < 2) { unknown.push(`${limitSentence(lim)} — 셀 대상(${scope || '?'})이 뚜렷하지 않아 세지 못했다`); continue; }

    /* 머리말이 여러 군데면 실제로 목록을 거느린 쪽(가장 많이 센 쪽)을 본다 */
    let best = null, where = null, seenHead = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== 'item') continue;
      if (!it.text.replace(/\s+/g, '').includes(key)) continue;
      seenHead = true;
      const c = countUnder(items, i);
      if (c !== null && (best === null || c > best)) { best = c; where = it.text; }
    }

    if (best === null) {
      unknown.push(seenHead
        ? `${limitSentence(lim)} — 원고의 “${scope}” 머리말 아래에 셀 항목이 없어 세지 못했다`
        : `${limitSentence(lim)} — 원고에서 “${scope}” 항목을 찾지 못해 세지 못했다`);
      continue;
    }
    const unit = lim.unit || '개';
    if (lim.op === 'min' && best < lim.n) {
      violations.push(`“${squash(where)}” 아래 항목이 ${best}${unit}뿐이다 — 안내서는 ${lim.n}${unit} 이상을 요구한다`);
    } else if (lim.op !== 'min' && best > lim.n) {
      violations.push(`“${squash(where)}” 아래 항목이 ${best}${unit}다 — 안내서는 ${lim.n}${unit} 이내로 못박았다`);
    }
  }

  /* 같은 사유가 두 번 나오지 않게 한다('전략'과 '추진전략'처럼 대상이 겹치는 제약이 있다) */
  const out = dedupe(violations);
  hide(out, 'unknown', dedupe(unknown));
  return out;
}
