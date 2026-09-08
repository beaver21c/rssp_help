/**
 * 앞서 작성한 절의 **결정 사항**을 요약 카드로 남기고, 다음 절을 쓸 때 필요한 것만 골라
 * 지시문에 넣는다.
 *
 * 왜 전문이 아니라 카드인가 —
 * 계획서는 마디가 65개다. 앞 절 전문을 매번 실어 보내면 뒤로 갈수록 요청이 선형으로 커져
 * 무료 등급의 분당 토큰 한도에 먼저 걸리고, 관계없는 문장이 섞여 원고 품질도 떨어진다.
 * 그래서 절을 낼 때마다 **비전·전략 이름·사업명·표 골격·핵심 수치**만 규칙으로 뽑아
 * 수백 자짜리 카드로 남긴다. 뽑는 데 AI를 부르지 않으므로 하루 몫을 축내지 않는다.
 *
 * 이 파일은 순수 함수만 둔다. DOM·저장소·그물을 건드리지 않아 시험에서 바로 부를 수 있다.
 */
"use strict";

/** 작업 폴더에 쌓이는 맥락 장부 파일 이름. */
export const CARD_FILE = '_맥락.json';

/** 지시문에 넣을 맥락 글의 최대 길이. 무료 등급 분당 토큰을 지키려는 상한이다. */
export const DEFAULT_BUDGET = 6000;

/**
 * 카드 하나의 상한. 원고가 아무리 길어도 카드는 이 크기를 넘지 않는다.
 * 상한이 없으면 긴 절 하나가 예산을 통째로 먹어 다른 절의 결정 사항이 밀려난다.
 */
export const MAX_CARD = 700;

const HEAD_RE = /^(#{1,4})\s+(.+)$/;
const BULLET_RE = /^([○▪◆◎▶·]|-)\s+(.+)$/;
const NOTE_RE = /^※\s*(.+)$/;
const ROW_RE = /^\|(.+)\|$/;
const SEP_RE = /^\|[\s|:-]+\|$/;
const COLS_RE = /^\{cols=[\d,.\s]+\}$/;
const LAYOUT_RE = /^\[\[도식:[^\]]+\]\]$/;

/** 계획서에서 뒤 절을 구속하는 말들. 이 낱말이 들어간 줄은 이름으로 따로 뽑는다. */
const NAME_RE = /(비전|목표|추진전략|전략|중점|세부사업|사업명|사업|과제|지표)/;

/** 수치 — 뒤 절이 앞 절과 어긋나면 곧바로 드러나는 값들. */
const NUM_RE = /(\d[\d,]*(?:\.\d+)?)\s*(%|퍼센트|명|가구|개소|개|건|곳|억원|백만원|천원|원|년|세|회)/g;

const clip = (s, n) => {
  const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const uniq = (a) => [...new Set(a.filter(Boolean))];

/** 파이프 표 한 줄을 칸으로 가른다. */
const cells = (line) => String(line).replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** 마디 id에서 장 번호를 뽑는다(`03-나-1` → `03`). */
export const chapterOf = (id) => String(id || '').split('-')[0];

/**
 * 마커 원고에서 카드를 뽑는다. AI를 부르지 않는다.
 * node는 카탈로그 마디(id·no·title). text는 그 절의 마커 원고.
 */
export function cardFrom(node, text, at) {
  const n = node || {};
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const card = {
    id: n.id || '',
    no: n.no || '',
    title: n.title || '',
    at: (at instanceof Date ? at : new Date()).toISOString(),
    heads: [],
    points: [],
    names: [],
    tables: [],
    numbers: [],
  };

  let table = null;   // 표를 모으는 중이면 {header, first[]}
  const closeTable = () => {
    if (table && table.header.length) {
      card.tables.push({
        header: table.header.map((h) => clip(h, 24)).filter(Boolean),
        cols: table.header.length,
        first: uniq(table.first).slice(0, 6).map((v) => clip(v, 20)),
      });
    }
    table = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (COLS_RE.test(line) || LAYOUT_RE.test(line)) continue;

    if (ROW_RE.test(line)) {
      if (SEP_RE.test(line)) continue;                   // |---|---| 구분선
      const c = cells(line);
      if (!table) table = { header: c, first: [] };      // 첫 줄이 머리행
      else table.first.push(c[0]);
      continue;
    }
    closeTable();

    const h = line.match(HEAD_RE);
    if (h) {
      card.heads.push(clip(h[2], 60));
      if (NAME_RE.test(h[2])) card.names.push(clip(h[2], 60));
      continue;
    }
    if (NOTE_RE.test(line)) continue;                    // 표 주는 출처 문구라 뺀다

    const b = line.match(BULLET_RE);
    const body = b ? b[2] : line;
    if (b && (b[1] === '○' || b[1] === '◆')) card.points.push(clip(body, 110));
    if (NAME_RE.test(body)) card.names.push(clip(body, 60));
  }
  closeTable();

  // 표 안 글자에도 이름이 들어 있다(전략명·사업명이 표로 들어가는 절이 많다)
  for (const t of card.tables) for (const v of t.first) if (NAME_RE.test(v)) card.names.push(v);

  for (const m of String(text || '').matchAll(NUM_RE)) card.numbers.push(`${m[1]}${m[2]}`);

  card.heads = uniq(card.heads).slice(0, 10);
  card.points = uniq(card.points).slice(0, 8);
  card.names = uniq(card.names).slice(0, 12);
  card.tables = card.tables.slice(0, 4);
  card.numbers = uniq(card.numbers).slice(0, 12);
  return trimCard(card, MAX_CARD);
}

/**
 * 카드를 상한 안으로 줄인다. 뒤 절을 더 세게 구속하는 것부터 남긴다 —
 * **이름(전략·사업명) > 표 골격 > 요지 > 수치** 차례로 지키고 나머지를 덜어 낸다.
 */
function trimCard(card, cap) {
  const steps = [
    () => { card.numbers = card.numbers.slice(0, 6); },
    () => { card.points = card.points.slice(0, 5); },
    () => { card.numbers = card.numbers.slice(0, 3); },
    () => { card.tables = card.tables.slice(0, 2); },
    () => { card.points = card.points.slice(0, 3); },
    () => { card.names = card.names.slice(0, 8); },
    () => { card.tables = card.tables.slice(0, 1); },
    () => { card.points = card.points.slice(0, 1); },
    () => { card.numbers = []; },
    () => { card.names = card.names.slice(0, 5); },
    () => { card.points = []; },
  ];
  for (const step of steps) {
    if (sizeOf(card) <= cap) return card;
    step();
  }
  // 이름만 남기고도 넘치면 이름을 줄인다(그래도 절 제목 줄은 지킨다)
  while (sizeOf(card) > cap && card.names.length > 1) card.names.pop();
  return card;
}

/** 같은 절 카드는 갈아 끼우고, 새 절이면 뒤에 붙인다. 문서 차례를 흐트러뜨리지 않는다. */
export function mergeCard(cards, card) {
  const list = Array.isArray(cards) ? cards.slice() : [];
  const at = list.findIndex((c) => c && c.id === card.id);
  if (at >= 0) list[at] = card;
  else list.push(card);
  return list;
}

/**
 * 이 절을 쓸 때 그 카드가 얼마나 쓸모 있는가. 안내서의 실제 절 관계에서 나온 규칙이다.
 * 0이면 넣지 않는다.
 */
export function scoreCard(target, card, catalog) {
  const t = target || {};
  const c = card || {};
  if (!c.id || c.id === t.id) return 0;

  const nodes = (catalog && catalog.nodes) || [];
  const at = (id) => nodes.findIndex((n) => n.id === id);
  const ti = at(t.id);
  const ci = at(c.id);
  // 아직 안 쓴 뒤쪽 절은 맥락이 아니다(차례를 모르면 그냥 넣는다)
  if (ti >= 0 && ci >= 0 && ci > ti) return 0;

  let s = 10;
  // ① 준용 원본 — [전략 2~4]는 전략 1의 구조를 되풀이한다. 이름이 흔들리면 문서가 깨진다
  if (t.mirrors && t.mirrors === c.id) s += 100;
  // ② 제1절(목표·추진전략) — 뒤의 모든 절이 여기서 정한 전략에 매달린다
  if (chapterOf(c.id) === '01') s += 60;
  // ③ 같은 장 — 가까울수록 세게
  if (chapterOf(c.id) === chapterOf(t.id)) s += 40;
  // ④ 바로 앞 절
  if (ti >= 0 && ci === ti - 1) s += 30;
  // ⑤ 문서 차례상 가까울수록 가산(최대 20)
  if (ti >= 0 && ci >= 0) s += Math.max(0, 20 - (ti - ci));
  return s;
}

/** 한 카드를 지시문 글로 눕혔을 때의 길이. */
export function sizeOf(card) {
  return cardText(card).length;
}

function cardText(card) {
  const c = card || {};
  const out = [`◆ ${[c.no, c.title].filter(Boolean).join(' ')} (${c.id})`];
  if (c.names.length) out.push(`  - 확정된 이름: ${c.names.join(' / ')}`);
  if (c.points.length) out.push(...c.points.map((p) => `  - ${p}`));
  for (const t of (c.tables || [])) {
    const head = t.header.join(' | ');
    const first = t.first.length ? ` (첫 칸: ${t.first.join(', ')})` : '';
    out.push(`  - 표 ${t.cols}열: ${head}${first}`);
  }
  if (c.numbers.length) out.push(`  - 수치: ${c.numbers.join(', ')}`);
  return out.join('\n');
}

/**
 * 점수 높은 카드부터 예산 안에서 고른다. 고른 것은 **문서 차례대로** 돌려준다
 * (읽는 쪽이 계획서 흐름대로 보게 하려는 것이다).
 */
export function pickCards(target, cards, catalog, budget) {
  const cap = typeof budget === 'number' ? budget : DEFAULT_BUDGET;
  const nodes = (catalog && catalog.nodes) || [];
  const order = (id) => {
    const i = nodes.findIndex((n) => n.id === id);
    return i < 0 ? 9999 : i;
  };
  const scored = (Array.isArray(cards) ? cards : [])
    .map((c) => ({ c, s: scoreCard(target, c, catalog) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || order(a.c.id) - order(b.c.id));

  const taken = [];
  // 머리말도 지시문에 함께 들어간다. 그만큼 미리 빼 두지 않으면 실제 글이 상한을 넘는다.
  let used = HEADER_SIZE;
  for (const { c } of scored) {
    const n = sizeOf(c) + 1;
    if (used + n > cap) continue;      // 큰 카드 하나 때문에 작은 것들을 잃지 않는다
    taken.push(c);
    used += n;
  }
  return taken.sort((a, b) => order(a.id) - order(b.id));
}

/** 맥락 글 머리말. 예산을 잴 때 이 길이도 함께 세야 실제 지시문이 상한을 넘지 않는다. */
const HEADER = [
  '[앞서 작성한 절의 결정 사항]',
  '※ 이 계획서의 앞선 절에서 이미 확정한 내용이다. 비전·전략 이름·사업명·수치를 여기에',
  '   맞춰 쓴다. 달리 써야 할 이유가 있으면 그 이유를 본문에 밝힌다. 아래 내용을 그대로',
  '   옮겨 적지는 말고, 이 절이 맡은 몫만 쓴다.',
  '',
];

/** 머리말이 차지하는 길이. */
export const HEADER_SIZE = HEADER.join('\n').length + 1;

/** 고른 카드를 지시문에 넣을 한 덩어리 글로 만든다. 빈 배열이면 빈 문자열. */
export function contextBlock(cards) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  if (!list.length) return '';
  return [...HEADER, ...list.map(cardText)].join('\n');
}
