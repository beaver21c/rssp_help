/**
 * app/assets/context.js 시험 — 앞선 절의 결정 사항을 카드로 남기고 골라 넣기.
 *
 * 이 모듈이 지켜야 할 것은 두 가지다.
 *   ① 절 전문을 그대로 나르지 않는다(요청이 커지면 무료 등급 분당 토큰에 걸린다)
 *   ② 뒤 절을 구속하는 것 — 전략 이름·사업명·표 골격·수치 — 을 빠뜨리지 않는다
 * 실제 안내서 카탈로그(app/data/sections.json)를 그대로 써서 관계 규칙을 확인한다.
 *   node tests/test_context.mjs
 */
"use strict";

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CARD_FILE, DEFAULT_BUDGET, chapterOf,
  cardFrom, mergeCard, scoreCard, pickCards, contextBlock, sizeOf, MAX_CARD, HEADER_SIZE,
} from '../app/assets/context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/sections.json'), 'utf8'));

let failed = 0;
let passed = 0;
const check = (name, ok, why) => {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${name}${why ? ` — ${why}` : ''}`);
};
const eq = (name, got, want) => check(name, got === want, `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
const node = (id) => catalog.nodes.find((n) => n.id === id);

/* 실제 원고에 가까운 표본 — 마커·표·표주·도식 자리표가 뒤섞인 꼴 */
const SAMPLE = `# 가 목표 및 추진전략

○ 비전은 「함께 돌보는 ○○시」로 정한다
- 2027년부터 2030년까지 4년간 이어 간다
○ 추진전략은 네 갈래로 둔다
· 전략1 노인 돌봄 확충
· 전략2 아동 돌봄 강화
※ 자료: 보건복지부 「지역사회보장계획 수립 안내」

{cols=30,35,35}
| 성과지표 명 (단위) | 2027 | 2030 |
|---|---|---|
| 노인 주간보호 이용률 (%) | 12.4% | 22.0% |
| 아동 돌봄 시설 (개소) | 18개소 | 25개소 |

[[도식:01-가#0]]

## 세부사업
○ 중점 추진사업은 경로당 지원 사업과 주간보호 확충 사업이다
- 예산은 45억원 규모로 잡는다`;

/* 실제 절 한 편에 가까운 분량(수천 자). 카드가 얼마나 줄여 주는지는 이 크기에서 봐야
   뜻이 있다 — 표본이 짧으면 카드의 머리표가 오히려 더 길어져 견주는 것 자체가 헛되다. */
const LONG = SAMPLE + '\n' + Array.from({ length: 24 }, (_, i) =>
  `○ 세부 추진과제 ${i + 1} — 지역 여건과 수요를 살펴 단계적으로 넓혀 간다. `
  + '읍·면·동 단위 전달체계와 민간 자원을 함께 묶어 빈틈을 줄이고, 해마다 성과를 '
  + `점검해 다음 해 계획에 반영한다 (${i + 1}차 연도 ${10 + i}억원)`).join('\n');

// ──────────────────────────────────────────────────────────────
// 1) 카드 뽑기 — 뒤 절을 구속하는 것만 남긴다
// ──────────────────────────────────────────────────────────────
{
  const c = cardFrom(node('01-가'), SAMPLE, new Date('2026-09-08T13:00:00Z'));
  eq('1 절 id', c.id, '01-가');
  eq('1 절 제목', c.title, '목표 및 추진전략');
  check('1 시각이 적힌다', /^2026-09-08T/.test(c.at), c.at);

  check('1 비전 문구를 잡는다', c.points.some((p) => p.includes('함께 돌보는')), c.points.join(' | '));
  check('1 전략 이름을 잡는다',
    c.names.some((n) => n.includes('노인 돌봄')) && c.names.some((n) => n.includes('아동 돌봄')),
    c.names.join(' | '));
  check('1 중점 사업명을 잡는다', c.names.some((n) => n.includes('경로당')), c.names.join(' | '));

  eq('1 표 하나', c.tables.length, 1);
  eq('1 표 열 수', c.tables[0].cols, 3);
  check('1 표 머리행 보존', c.tables[0].header.join('|').includes('성과지표'), JSON.stringify(c.tables[0]));
  check('1 표 첫 칸 값 보존', c.tables[0].first.some((v) => v.includes('노인 주간보호')),
    JSON.stringify(c.tables[0].first));
  check('1 구분선은 표로 안 센다', !c.tables[0].first.some((v) => /^-+$/.test(v)),
    JSON.stringify(c.tables[0].first));

  check('1 수치를 모은다', c.numbers.includes('22.0%') && c.numbers.includes('45억원'),
    c.numbers.join(', '));
  check('1 표 주(※)는 안 담는다', !JSON.stringify(c).includes('보건복지부 「지역'), '표주가 섞였다');
  check('1 도식 자리표는 안 담는다', !JSON.stringify(c).includes('[[도식'), '자리표가 섞였다');
  check('1 열 너비 지정도 안 담는다', !JSON.stringify(c).includes('cols='), 'cols가 섞였다');

  // ★ 이 모듈의 존재 이유 — 실제 절 분량에서 전문보다 훨씬 작아야 한다
  const big = cardFrom(node('01-가'), LONG);
  check('1 실제 분량에서 원고의 3분의 1 아래', sizeOf(big) < LONG.length / 3,
    `카드 ${sizeOf(big)}자 / 원고 ${LONG.length}자`);
  check('1 카드에 상한이 있다', sizeOf(big) <= MAX_CARD, `${sizeOf(big)}자 / 상한 ${MAX_CARD}자`);
  eq('1 상한값', MAX_CARD, 700);
  // 상한에 걸려 덜어 낼 때도 이름(전략·사업명)은 끝까지 지킨다 — 뒤 절을 가장 세게 구속한다
  check('1 줄여도 전략 이름은 남는다', big.names.some((n) => n.includes('노인 돌봄')),
    big.names.join(' | '));
  check('1 줄여도 표 골격은 남는다', big.tables.length >= 1, JSON.stringify(big.tables));
  // 원고가 10배 길어져도 카드는 상한 안에 머문다
  const huge = cardFrom(node('01-가'), LONG.repeat(10));
  check('1 원고가 10배여도 카드는 상한 안', sizeOf(huge) <= MAX_CARD, `${sizeOf(huge)}자`);
}

// ──────────────────────────────────────────────────────────────
// 2) 이상한 입력에도 죽지 않는다
// ──────────────────────────────────────────────────────────────
{
  const empty = cardFrom(node('01-가'), '');
  eq('2 빈 원고도 카드가 된다', empty.id, '01-가');
  eq('2 빈 원고는 비어 있다', empty.points.length + empty.tables.length + empty.numbers.length, 0);
  const none = cardFrom(null, null);
  eq('2 마디가 없어도 안 죽는다', none.id, '');
  const onlyTable = cardFrom(node('01-나'), '| 가 | 나 |\n|---|---|\n| 값 | 값 |');
  eq('2 표만 있어도 잡는다', onlyTable.tables.length, 1);
  const noClose = cardFrom(node('01-나'), '| 가 | 나 |');
  eq('2 머리행만 있어도 표로 센다', noClose.tables.length, 1);
}

// ──────────────────────────────────────────────────────────────
// 3) 장부 갈아 끼우기 — 같은 절을 다시 내면 덮어쓴다
// ──────────────────────────────────────────────────────────────
{
  const a = cardFrom(node('01-가'), '# 가\n○ 첫 판');
  const b = cardFrom(node('01-나'), '# 나\n○ 다른 절');
  const c2 = cardFrom(node('01-가'), '# 가\n○ 고쳐 쓴 판');
  let list = mergeCard([], a);
  list = mergeCard(list, b);
  eq('3 두 절이면 둘', list.length, 2);
  list = mergeCard(list, c2);
  eq('3 같은 절은 덮어쓴다', list.length, 2);
  eq('3 자리는 그대로', list[0].id, '01-가');
  check('3 내용은 새것', list[0].points.join().includes('고쳐 쓴'), list[0].points.join());
}

// ──────────────────────────────────────────────────────────────
// 4) 관련성 — 안내서의 실제 절 관계에서 나온 규칙
// ──────────────────────────────────────────────────────────────
{
  const mk = (id) => cardFrom(node(id) || { id }, `# ${id}\n○ ${id} 내용`);
  eq('4 장 번호 뽑기', chapterOf('03-나-1'), '03');

  // 준용 원본은 무엇보다 앞선다 — 02-다는 02-나의 구조를 되풀이한다
  const t = node('02-다');
  check('4 준용 대상이 실제로 있다', !!(t && t.mirrors), JSON.stringify(t && t.mirrors));
  const sMirror = scoreCard(t, mk(t.mirrors), catalog);
  const sOther = scoreCard(t, mk('01-나'), catalog);
  check('4 준용 원본이 가장 높다', sMirror > sOther, `${sMirror} vs ${sOther}`);

  // 제1절(목표·추진전략)은 뒤 절 전부를 구속한다
  const far = node('04-가') || node('03-나');
  check('4 제1절 카드는 먼 절에서도 점수를 받는다', scoreCard(far, mk('01-가'), catalog) > 10,
    String(scoreCard(far, mk('01-가'), catalog)));

  // 아직 안 쓴 뒤쪽 절은 맥락이 아니다
  eq('4 뒤쪽 절은 0점', scoreCard(node('01-가'), mk('03-나'), catalog), 0);
  eq('4 자기 자신도 0점', scoreCard(node('01-가'), mk('01-가'), catalog), 0);
  eq('4 id 없는 카드는 0점', scoreCard(node('02-가'), { id: '' }, catalog), 0);
}

// ──────────────────────────────────────────────────────────────
// 5) 고르기 — 예산을 넘지 않고, 중요한 것을 버리지 않는다
// ──────────────────────────────────────────────────────────────
{
  const many = catalog.nodes.slice(0, 40).map((n) => cardFrom(n, `# ${n.title}\n○ ${'가'.repeat(200)}`));
  const target = node('04-가') || catalog.nodes[45];
  const got = pickCards(target, many, catalog, 2000);
  check('5 예산을 넘지 않는다', contextBlock(got).length <= 2000, `${contextBlock(got).length}자`);
  check('5 그래도 몇 장은 골랐다', got.length >= 2, `${got.length}장`);

  // 고른 것은 문서 차례대로
  const idx = got.map((c) => catalog.nodes.findIndex((n) => n.id === c.id));
  check('5 문서 차례대로 준다', idx.every((v, i) => i === 0 || v > idx[i - 1]), idx.join(','));

  // 준용 원본은 예산이 빠듯해도 살아남는다(점수가 가장 높다)
  const mt = node('02-다');
  const cards = catalog.nodes.slice(0, 20).map((n) => cardFrom(n, `# ${n.title}\n○ ${'나'.repeat(300)}`));
  const tight = pickCards(mt, cards, catalog, 600);
  check('5 예산이 빠듯하면 준용 원본부터', tight.some((c) => c.id === mt.mirrors),
    tight.map((c) => c.id).join(','));

  eq('5 예산이 0이면 아무것도 안 고른다', pickCards(target, many, catalog, 0).length, 0);
  eq('5 머리말만 한 예산이면 아무것도 못 고른다',
    pickCards(target, many, catalog, HEADER_SIZE + 10).length, 0);
  eq('5 카드가 없으면 빈 배열', pickCards(target, [], catalog).length, 0);
  eq('5 기본 예산값', DEFAULT_BUDGET, 6000);
}

// ──────────────────────────────────────────────────────────────
// 6) 지시문 글 — 베끼지 말라는 단서가 반드시 붙는다
// ──────────────────────────────────────────────────────────────
{
  eq('6 빈 목록이면 빈 글', contextBlock([]), '');
  eq('6 배열이 아니어도 빈 글', contextBlock(null), '');
  const block = contextBlock([cardFrom(node('01-가'), SAMPLE)]);
  check('6 머리표가 붙는다', block.startsWith('[앞서 작성한 절의 결정 사항]'), block.slice(0, 40));
  check('6 그대로 옮기지 말라는 단서', /그대로\s*\n?\s*옮겨 적지는 말고|옮겨 적지는 말고/.test(block), block);
  check('6 맞춰 쓰라는 지시', /맞춰 쓴다/.test(block), block);
  check('6 절 이름이 들어간다', block.includes('목표 및 추진전략'), block);
  check('6 확정된 이름이 들어간다', block.includes('확정된 이름'), block);
  check('6 표 골격이 들어간다', /표 3열/.test(block), block);
  check('6 수치가 들어간다', block.includes('45억원'), block);
  // 전문을 나르지 않는다
  check('6 원고 문장을 통째로 옮기지 않는다', !block.includes('2027년부터 2030년까지 4년간 이어 간다'),
    '전문이 섞였다');
  eq('6 장부 파일 이름', CARD_FILE, '_맥락.json');
}

// ──────────────────────────────────────────────────────────────
// 7) 65개 마디를 차례로 쌓아도 요청이 부풀지 않는다 — 이 설계의 핵심
// ──────────────────────────────────────────────────────────────
{
  let cards = [];
  let worst = 0;
  for (const n of catalog.nodes) {
    const block = contextBlock(pickCards(n, cards, catalog));
    worst = Math.max(worst, block.length);
    cards = mergeCard(cards, cardFrom(n, LONG));     // 절마다 실제 분량으로 냈다고 치고
  }
  eq('7 마디 전부의 카드가 쌓인다', cards.length, catalog.nodes.length);
  check('7 마지막까지 예산 안에 든다', worst <= DEFAULT_BUDGET, `최대 ${worst}자`);
  // 전문을 날랐다면 이만큼이었을 양과 견준다
  const allText = catalog.nodes.length * LONG.length;
  check('7 전문 누적 대비 훨씬 작다', worst < allText / 20, `${worst}자 vs 전문 누적 ${allText}자`);
  console.log(`  맥락 글 최대 ${worst}자 · 절 전문을 다 실었다면 ${allText}자 `
    + `(${(allText / worst).toFixed(0)}분의 1)`);
}

console.log(`통과 ${passed} / 실패 ${failed}`);
if (failed) {
  console.error(`시험 실패 — 위 ${failed}건을 고칠 것.`);
  process.exitCode = 1;
}
