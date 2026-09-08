/* app/assets/catalog.js 검사 — node tests/test_catalog_js.mjs
 *
 * 시험 틀은 안 쓴다. 어긋나면 사유를 찍고 process.exitCode = 1로 끝낸다.
 * 기준 자료는 docs/SECTIONS_SCHEMA.md 스키마대로 손으로 짠 고정 데이터다. tests/fixtures/는
 * 저장소에 담지 않으므로(그쪽 .gitignore) 여기서 매번 sections.sample.json으로 떨군 뒤 읽는다.
 * app/data/sections.json이 있으면 그것으로도 한 번 더 돌리되, 없다고 실패로 보지 않는다.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadCatalog, findSection, sectionList, promptFor, blankForms, checkLimits,
  pathOf, outline, limitSentence,
} from '../app/assets/catalog.js';
const FIXTURE = new URL('./fixtures/sections.sample.json', import.meta.url);
const REAL = new URL('../app/data/sections.json', import.meta.url);

/* ───────── 고정 데이터 — 스키마를 그대로 따른 축소본 ─────────
 * 장(0) 아래 절(1) 둘, 그 아래 항(2)·목(3)까지 넣어 깊이 차례를 볼 수 있게 했다.
 * 표는 네 갈래(howto·blank·example·note)를 다 넣고, 01-나는 idx를 일부러 뒤집어
 * blankForms가 차례를 바로잡는지 본다. 제약은 max·min·원고에 없는 것 셋이다. */
const SAMPLE = {
  source: '제6기(2027~2030) 지역사회보장계획 수립 안내 [시·군·구] (시험용 축소본)',
  scope: '시군구',
  generated_at: '2026-09-08T00:00:00',
  template: 'template.hwpx',
  body_section: 'Contents/section2.xml',
  stats: { chapters: 2, nodes: 6, forms: 6, howtos: 2 },
  nodes: [
    {
      id: '01', depth: 0, no: '제1절', title: '지역사회보장계획 추진체계', page: 12,
      parent: null, children: ['01-가', '01-나'],
      howto: null, forms: [], limits: [], fixed: false, markers: [],
    },
    {
      id: '01-가', depth: 1, no: '가.', title: '목표 및 추진전략', page: 13,
      parent: '01', children: ['01-가-1'],
      howto: {
        purpose: '(법적근거) 「사회보장급여법」 제35조\n지역 복지수요에 대응하는 중장기 전략체계를 자율적으로 세운다.',
        method: '전략체계-추진전략-중점추진사업-세부사업의 구성 체계를 제시한다.\n추진전략(5개 이내), 세부사업(3개 이상)으로 구성할 것을 권장한다.',
        raw: '◆ 작성 취지 및 방법 ◆\n작성취지\n(법적근거) 「사회보장급여법」 제35조\n'
          + '지역 복지수요에 대응하는 중장기 전략체계를 자율적으로 세운다.\n작성방법\n'
          + '전략체계-추진전략-중점추진사업-세부사업의 구성 체계를 제시한다.\n'
          + '추진전략(5개 이내), 세부사업(3개 이상)으로 구성할 것을 권장한다.\n'
          + '※ (참조) 세부사업은 예산사업과 비예산사업을 모두 포함한다.',
        chars: 231,
      },
      forms: [
        {
          idx: 0, kind: 'howto', rows: 3, cols: 3,
          header: ['◆ 작성 취지 및 방법 ◆', '', ''],
          grid: [['◆ 작성 취지 및 방법 ◆', '', ''], ['작성취지', '', ''], ['작성방법', '', '']],
          colWidths: [20, 40, 40], required: false,
        },
        {
          idx: 1, kind: 'blank', rows: 6, cols: 4,
          header: ['추진전략', '중점추진사업', '세부사업', '소관부서'],
          grid: [['추진전략', '중점추진사업', '세부사업', '소관부서'],
            ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', '']],
          colWidths: [25, 30, 30, 15], required: true,
        },
        {
          idx: 2, kind: 'example', rows: 6, cols: 4,
          header: ['추진전략', '중점추진사업', '세부사업', '소관부서'],
          grid: [['추진전략', '중점추진사업', '세부사업', '소관부서'],
            ['돌봄 강화', '통합돌봄 확대', '재가 돌봄 지원', '복지정책과'],
            ['돌봄 강화', '통합돌봄 확대', '주거 개보수', '주택과'],
            ['', '', '', ''], ['', '', '', ''], ['', '', '', '']],
          colWidths: [25, 30, 30, 15], required: false,
        },
        {
          idx: 3, kind: 'note', rows: 1, cols: 1,
          header: ['※ (참조) 세부사업 및 세부과업의 차이'],
          grid: [['※ (참조) 세부사업 및 세부과업의 차이']],
          colWidths: [100], required: false,
        },
      ],
      limits: [
        { text: '추진전략(5개 이내)', scope: '추진전략', op: 'max', n: 5, unit: '개' },
        { text: '세부사업(3개 이상)', scope: '세부사업', op: 'min', n: 3, unit: '개' },
        { text: '협의체 위원 10명 이상', scope: '협의체 위원', op: 'min', n: 10, unit: '명' },
      ],
      fixed: false, markers: ['○', '▪', '-'],
    },
    {
      id: '01-가-1', depth: 2, no: '1', title: '전략체계도', page: 14,
      parent: '01-가', children: ['01-가-1-(1)'],
      howto: null, forms: [], limits: [], fixed: true, markers: ['○'],
    },
    {
      id: '01-가-1-(1)', depth: 3, no: '(1)', title: '전략체계 도표 작성', page: null,
      parent: '01-가-1', children: [],
      howto: null, forms: [], limits: [], fixed: false, markers: [],
    },
    {
      id: '01-나', depth: 1, no: '나.', title: '성과지표 및 목표', page: 20,
      parent: '01', children: [],
      howto: {
        purpose: null, method: null,
        raw: '◆ 작성 취지 및 방법 ◆\n성과지표는 사업별로 한 개 이상 설정하고 연도별 목표치를 함께 제시한다.',
        chars: 56,
      },
      forms: [
        {
          idx: 2, kind: 'blank', rows: 4, cols: 3,
          header: ['성과지표 명\n(단위)', '지표정의', '연도별 목표'],
          grid: [['성과지표 명\n(단위)', '지표정의', '연도별 목표'], ['', '', ''], ['', '', ''], ['', '', '']],
          colWidths: [30, 40, 30], required: true,
        },
        {
          idx: 0, kind: 'blank', rows: 3, cols: 2,
          header: ['구분', '내용'],
          grid: [['구분', '내용'], ['', ''], ['', '']],
          colWidths: [30, 70], required: true,
        },
      ],
      limits: [], fixed: false, markers: ['○'],
    },
    {
      id: '02', depth: 0, no: '제2절', title: '지역사회보장 여건 분석', page: 30,
      parent: null, children: [],
      howto: null, forms: [], limits: [], fixed: false, markers: [],
    },
  ],
};

/* 배열 차례를 일부러 흐트러뜨린다. sectionList가 배열 차례를 그냥 되읊는 게 아니라
 * children 줄기를 타고 도는지 보려면 자식이 부모보다 앞에 놓여 있어야 한다 */
SAMPLE.nodes = ['01-가-1-(1)', '01-나', '01', '01-가-1', '01-가', '02']
  .map((id) => {
    const n = SAMPLE.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`고정 데이터에 ${id}가 없다`);
    return n;
  });

mkdirSync(fileURLToPath(new URL('./fixtures/', import.meta.url)), { recursive: true });
writeFileSync(fileURLToPath(FIXTURE), JSON.stringify(SAMPLE, null, 2) + '\n');

let fails = 0, checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { fails++; console.error('  ✗ ' + msg); }
}
function head(t) { console.log('\n[' + t + ']'); }

/* ───────── 고정 데이터 적재 ───────── */
head('적재');
const cat = await loadCatalog(FIXTURE);
ok(Array.isArray(cat.nodes) && cat.nodes.length === 6, `nodes 6개여야 하는데 ${cat.nodes && cat.nodes.length}개다`);
ok(cat.scope === '시군구', 'scope가 원본 그대로 남아야 한다');
ok(JSON.parse(JSON.stringify(cat)).nodes[0].trail === undefined, '색인용 값(trail)이 JSON에 새면 안 된다');

let threw = '';
try { await loadCatalog({ nodes: [{ id: 'a' }, { id: 'a' }] }); } catch (e) { threw = e.message; }
ok(/겹친다/.test(threw), `id 중복이면 던져야 하는데 — ${threw || '안 던졌다'}`);
threw = '';
try { await loadCatalog({}); } catch (e) { threw = e.message; }
ok(/nodes/.test(threw), 'nodes가 없으면 던져야 한다');

/* ───────── findSection ───────── */
head('findSection');
const s가 = findSection(cat, '01-가');
ok(s가 && s가.title === '목표 및 추진전략', '01-가를 찾아야 한다');
ok(findSection(cat, '없는id') === null, '없는 id는 null이어야 한다');
ok(pathOf(cat, '01-가-1-(1)') === '제1절 지역사회보장계획 추진체계 › 가. 목표 및 추진전략 › 1 전략체계도 › (1) 전략체계 도표 작성',
  `경로가 어긋난다 — ${pathOf(cat, '01-가-1-(1)')}`);

/* ───────── sectionList ───────── */
head('sectionList');
const list = sectionList(cat);
ok(list.length === cat.nodes.length, `목록 ${list.length}개 / 마디 ${cat.nodes.length}개 — 빠진 마디가 있다`);
ok(new Set(list.map((i) => i.id)).size === list.length, 'id가 겹친다');
const order = list.map((i) => i.id).join(',');
ok(order === '01,01-가,01-가-1,01-가-1-(1),01-나,02', `전위 순회 차례가 아니다 — ${order}`);
{
  let prev = -1, seen = new Set(), bad = [];
  for (const it of list) {
    if (it.depth > prev + 1) bad.push(`${it.id}(깊이 ${prev}→${it.depth})`);
    const n = findSection(cat, it.id);
    if (n.parent && !seen.has(n.parent)) bad.push(`${it.id}의 상위 ${n.parent}가 뒤에 나온다`);
    seen.add(it.id); prev = it.depth;
  }
  ok(!bad.length, 'depth 차례가 어긋난다 — ' + bad.join(' / '));
  ok(list[0].depth === 0, '첫 항목은 장(depth 0)이어야 한다');
}
ok(list[1].label === '가. 목표 및 추진전략', `이름표가 어긋난다 — ${list[1].label}`);
ok(cat.nodes[0].id !== list[0].id, '고정 데이터의 배열 차례와 목록 차례가 같으면 순회를 못 본 셈이다');

/* ───────── blankForms ───────── */
head('blankForms');
const bf가 = blankForms(s가);
ok(bf가.length === 1, `01-가의 빈 표는 1개여야 하는데 ${bf가.length}개다`);
ok(bf가.every((f) => f.kind === 'blank'), 'blank가 아닌 표가 섞였다');
const bf나 = blankForms(findSection(cat, '01-나'));
ok(bf나.map((f) => f.idx).join(',') === '0,2', `idx 차례로 줘야 하는데 — ${bf나.map((f) => f.idx).join(',')}`);
ok(blankForms(findSection(cat, '02')).length === 0, '표 없는 마디는 빈 배열이어야 한다');
threw = '';
try { blankForms(null); } catch (e) { threw = e.message; }
ok(!!threw, '마디가 없으면 조용히 null이 아니라 던져야 한다');

/* ───────── promptFor ───────── */
head('promptFor');
const p = promptFor(s가);
{
  const marks = ['[역할]', '[지시]', '[양식]', '[수량 제약]', '[문체]', '[금지]'];
  const at = marks.map((m) => p.indexOf(m));
  ok(at.every((i) => i >= 0), '여섯 토막이 다 있어야 한다 — ' + marks.filter((m, i) => at[i] < 0).join(','));
  ok(at.every((v, i) => i === 0 || v > at[i - 1]), '토막 차례가 고정이어야 한다(역할→지시→양식→수량→문체→금지)');
}
ok(p.startsWith('[역할]\n제6기 지역사회보장계획 제1절 지역사회보장계획 추진체계 › 가. 목표 및 추진전략 집필 보조. 산출물은 한글 보고서 본문 원고.'),
  '역할 첫 줄이 계약과 다르다 — ' + p.slice(0, 120));

/* 지시는 안내서 원문을 자르지 않는다 */
{
  const raw = s가.howto.raw;
  const i = p.indexOf(raw);
  ok(i >= 0, '지시에 howto.raw가 통째로 들어가야 한다');
  ok(p.slice(i, i + raw.length).length === raw.length && p.slice(i, i + raw.length) === raw,
    `원문 길이 ${raw.length}자가 그대로 들어가야 한다`);
  const lines = raw.split('\n');
  ok(p.includes(lines[lines.length - 1]), '원문 마지막 줄까지 들어가야 한다(꼬리가 잘렸다)');
}

/* 양식 — 표 크기와 머리행이 그대로 */
ok(p.includes('표 1: 6행 4열, 머리행: 추진전략 | 중점추진사업 | 세부사업 | 소관부서'),
  '표 머리행이 그대로 나와야 한다');
{
  const p나 = promptFor(findSection(cat, '01-나'));
  ok(p나.includes('표 1: 3행 2열, 머리행: 구분 | 내용'), 'idx 0인 표가 표 1이어야 한다');
  ok(p나.includes('표 2: 4행 3열, 머리행: 성과지표 명 (단위) | 지표정의 | 연도별 목표'),
    '칸 안 줄바꿈은 한 칸 띄어쓰기로 눕혀 한 줄에 담아야 한다 — ' +
    (p나.split('\n').find((l) => l.startsWith('표 2:')) || '표 2 줄이 없다'));
  ok(promptFor(findSection(cat, '02')).includes('빈 표 양식은 없다'), '표 없는 절은 그렇다고 알려야 한다');
}
/* 수량 제약 · 문체 · 금지 */
ok(p.includes('추진전략: 5개 이내로 쓴다'), '수량 제약을 사람 문장으로 풀어야 한다');
ok(p.includes('세부사업: 3개 이상 쓴다'), 'op=min은 “이상”으로 풀어야 한다');
ok(p.includes('추진전략(5개 이내)'), '제약의 안내서 원문도 함께 보여야 한다');
ok(p.includes('개조식') && p.includes('반말체'), '문체 지시가 있어야 한다');
ok(['#', '##', '###', '####', '○', '▪', '-', '·', '※'].every((m) => p.includes(m)), '마커 체계를 다 적어야 한다');
ok(p.includes('※ 자료：'), '표 주 형식을 적어야 한다');
ok(p.includes('|---|'), '표 파이프 표기를 적어야 한다');
ok(p.includes('지시에 없는 표를 만들지 않는다'), '금지에 임의 표 생성 금지가 있어야 한다');
ok(p.includes('지어내지 않는다') && p.includes('○○'), '금지에 날조·빈칸 규칙이 있어야 한다');
ok(promptFor(findSection(cat, '01-가-1')).includes('「작성 취지 및 방법」 박스가 없다'),
  '지침 없는 마디도 지시 토막을 채워야 한다');
/* 꼴이 깨진 자료가 섞여도 조용한 TypeError로 무너지지 않는다(계약 0장) */
{
  const 제약구간 = (s) => s.slice(s.indexOf('[수량 제약]'), s.indexOf('[문체]'));
  for (const 쓰레기 of [null, 1, 'x', []]) {
    let msg = '', got = '';
    try { got = 제약구간(promptFor({ id: 'x', forms: [], limits: [쓰레기] })); }
    catch (e) { msg = e.constructor.name + ': ' + e.message; }
    ok(!msg, `limits에 ${JSON.stringify(쓰레기)}가 섞였다고 던지면 안 된다 — ${msg}`);
    ok(!/undefined|null|NaN|\[object/.test(got), `제약 문장에 날값이 새면 안 된다 — ${got.trim()}`);
  }
  let msg = '';
  try { limitSentence(null); } catch (e) { msg = e.message; }
  ok(/객체가 아니다/.test(msg), `limitSentence(null)은 한국어 Error여야 한다 — ${msg || '안 던졌다'}`);
  const 표없는칸 = promptFor({ id: 'x', forms: [{ idx: 0, kind: 'blank', header: ['가', '나'] }] });
  ok(!/undefined/.test(표없는칸), '표 크기를 모를 때 undefined를 찍으면 안 된다 — ' +
    (표없는칸.split('\n').find((l) => l.startsWith('표 1:')) || ''));
}

/* ───────── checkLimits ───────── */
head('checkLimits');
const 위반원고 = [
  '### 가. 목표 및 추진전략',
  '',
  '○ 추진전략',
  '▪ 전략1. 촘촘한 돌봄',
  '▪ 전략2. 안전한 주거',
  '▪ 전략3. 건강한 노후',
  '▪ 전략4. 일자리 연계',
  '▪ 전략5. 사회참여 확대',
  '▪ 전략6. 통합 사례관리',
  '',
  '○ 세부사업',
  '▪ 재가 돌봄 지원',
  '▪ 주거 개보수',
  '▪ 노인 일자리',
  '▪ 통합 사례관리 강화',
  '',
].join('\n');
{
  const v = checkLimits(s가, 위반원고);
  ok(Array.isArray(v) && v.every((x) => typeof x === 'string'), '돌려주는 값은 문자열 배열이어야 한다');
  ok(v.length === 1, `“5개 이내”를 6개 썼으니 위반 1건이어야 하는데 ${v.length}건이다 — ${v.join(' / ')}`);
  ok(v[0].includes('6개') && v[0].includes('5개 이내'), '위반 사유에 센 개수와 제한이 있어야 한다 — ' + v[0]);
  ok(Array.isArray(v.unknown) && v.unknown.length === 1, `확인 불가는 1건이어야 하는데 ${v.unknown && v.unknown.length}건`);
  ok(v.unknown[0].includes('협의체 위원'), '원고에 없는 대상은 확인 불가로 빠져야 한다 — ' + v.unknown[0]);
}
{
  const 통과원고 = 위반원고.replace('▪ 전략5. 사회참여 확대\n▪ 전략6. 통합 사례관리\n', '');
  const v = checkLimits(s가, 통과원고);
  ok(v.length === 0, `4개면 통과해야 하는데 ${v.length}건 잡혔다 — ${v.join(' / ')}`);
  ok(v.unknown.length === 1, '통과해도 확인 불가는 그대로 남아야 한다');
}
{
  /* 적게 쓴 쪽(op=min) */
  const 모자란원고 = ['○ 추진전략', '▪ 전략1', '', '○ 세부사업', '▪ 사업1', '▪ 사업2'].join('\n');
  const v = checkLimits(s가, 모자란원고);
  ok(v.length === 1 && v[0].includes('3개 이상'), `세부사업 2개는 미달이어야 한다 — ${v.join(' / ')}`);
}
{
  /* 표로 쓴 경우 — 머리행·구분선을 빼고 자료 행만 센다 */
  const 표원고 = [
    '○ 세부사업',
    '| 사업명 | 소관 |',
    '|---|---|',
    '| 재가 돌봄 | 복지과 |',
    '| 주거 개보수 | 주택과 |',
    '※ 자료：자체 조사',
  ].join('\n');
  const v = checkLimits(s가, 표원고);
  ok(v.some((m) => m.includes('세부사업') && m.includes('2개')), `표 자료 행 2개를 세야 한다 — ${v.join(' / ')}`);
  ok(v.unknown.some((m) => m.includes('추진전략')), '원고에 없는 추진전략은 확인 불가여야 한다');
}
{
  const v = checkLimits(findSection(cat, '02'), '○ 아무 말');
  ok(v.length === 0 && v.unknown.length === 0, '제약이 없으면 위반도 확인 불가도 없다');
  threw = '';
  try { checkLimits(s가, null); } catch (e) { threw = e.message; }
  ok(!!threw, '원고가 없으면 던져야 한다');
}
{
  /* 셀 수 없는 제약은 조용히 버리지 않고 확인 불가로 남긴다(계약 0장) */
  const 깨진마디 = { id: 'x', limits: [
    { text: '추진전략(5개 이내)', scope: '추진전략', op: 'max', n: '5', unit: '개' },
    null,
  ] };
  const v = checkLimits(깨진마디, '○ 추진전략\n▪ 하나\n▪ 둘\n');
  ok(v.length === 0, `숫자가 아닌 제한을 위반으로 삼으면 안 된다 — ${v.join(' / ')}`);
  ok(v.unknown.length === 2, `버리지 말고 확인 불가 2건으로 남겨야 하는데 ${v.unknown.length}건 — ${v.unknown.join(' / ')}`);
  ok(v.unknown.some((m) => /숫자가 아니라/.test(m)), '숫자 아닌 제한임을 밝혀야 한다 — ' + v.unknown.join(' / '));
  ok(!v.unknown.some((m) => /undefined|NaN/.test(m)), '확인 불가 사유에 날값이 새면 안 된다 — ' + v.unknown.join(' / '));
}
{
  /* 머리말은 찾았는데 아래가 비었을 때와 머리말 자체가 없을 때를 갈라 적는다 */
  const m = { id: 'x', limits: [{ text: 't', scope: '세부사업', op: 'min', n: 3, unit: '개' }] };
  const 빈머리말 = checkLimits(m, '○ 세부사업\n');
  const 머리말없음 = checkLimits(m, '○ 딴소리\n▪ 하나\n');
  ok(빈머리말.unknown.length === 1 && /셀 항목이 없어/.test(빈머리말.unknown[0]),
    '머리말은 찾았으나 아래가 빈 경우를 갈라 적어야 한다 — ' + 빈머리말.unknown.join(' / '));
  ok(머리말없음.unknown.length === 1 && /찾지 못해/.test(머리말없음.unknown[0]),
    '머리말이 아예 없는 경우와 뭉뚱그리면 안 된다 — ' + 머리말없음.unknown.join(' / '));
}
{
  /* 대상이 겹치는 제약('전략'은 '추진전략'에도 물린다)이 같은 사유를 두 번 찍으면 안 된다 */
  const 겹침 = { id: 'x', limits: [
    { text: '추진전략(5개 이내)', scope: '추진전략', op: 'max', n: 5, unit: '개' },
    { text: '전략5개 이내', scope: '전략', op: 'max', n: 5, unit: '개' },
  ] };
  const v = checkLimits(겹침, ['○ 추진전략', '▪ 1', '▪ 2', '▪ 3', '▪ 4', '▪ 5', '▪ 6'].join('\n'));
  ok(v.length === 1, `같은 사유는 한 번만 적어야 하는데 ${v.length}건 — ${v.join(' / ')}`);
  ok(new Set(v).size === v.length && new Set(v.unknown).size === v.unknown.length, '겹치는 사유가 남았다');
}
{
  const o = outline('# 제목\n○ 항목\n| a | b |\n|---|---|\n※ 자료：x\n');
  ok(o[0].kind === 'item' && o[0].level === 1, '#은 1단계 항목이어야 한다');
  ok(o[1].kind === 'item' && o[1].level === 5, '○은 5단계 항목이어야 한다');
  ok(o[2].kind === 'table' && o[3].kind === 'sep', '표와 구분선을 갈라야 한다');
  ok(o[4].kind === 'note', '※ 줄은 주석이어야 한다');
}

/* ───────── 실제 카탈로그(있을 때만) ───────── */
head('app/data/sections.json');
if (!existsSync(fileURLToPath(REAL))) {
  console.log('  · 아직 없다 — 건너뛴다(다른 에이전트가 만드는 중)');
} else {
  let real = null;
  try { real = await loadCatalog(); } catch (e) { ok(false, '실제 카탈로그를 못 읽었다 — ' + e.message); }
  if (real) {
    const rl = sectionList(real);
    ok(rl.length === real.nodes.length, `목록 ${rl.length}개 / 마디 ${real.nodes.length}개`);
    ok(new Set(rl.map((i) => i.id)).size === rl.length, '실제 카탈로그의 id가 겹친다');
    let prev = -1, seen = new Set(), bad = [];
    for (const it of rl) {
      if (it.depth > prev + 1) bad.push(`${it.id}(${prev}→${it.depth})`);
      const n = findSection(real, it.id);
      if (n.parent && !seen.has(n.parent)) bad.push(`${it.id}의 상위가 뒤에 있다`);
      seen.add(it.id); prev = it.depth;
    }
    ok(!bad.length, 'depth 차례가 어긋난다 — ' + bad.slice(0, 5).join(' / '));

    let bads = [];
    for (const n of real.nodes) {
      try {
        const s = promptFor(n);
        if (n.howto && n.howto.raw && !s.includes(n.howto.raw)) bads.push(`${n.id} 지시문이 잘렸다`);
        for (const f of blankForms(n)) if (f.kind !== 'blank') bads.push(`${n.id} blank 아닌 표`);
        const v = checkLimits(n, '○ 추진전략\n▪ 하나\n');
        if (!Array.isArray(v) || !Array.isArray(v.unknown)) bads.push(`${n.id} checkLimits 반환 꼴`);
      } catch (e) { bads.push(`${n.id} — ${e.message}`); }
    }
    ok(!bads.length, '실제 카탈로그 전 마디 처리 실패 — ' + bads.slice(0, 5).join(' / '));
    const sample = real.nodes.find((n) => blankForms(n).length && n.howto);
    if (sample) {
      const sp = promptFor(sample);
      const h = (blankForms(sample)[0].header || []).map((c) => String(c).replace(/\s+/g, ' ').trim());
      if (h.some(Boolean)) ok(sp.includes(h.join(' | ')), `${sample.id}의 머리행이 그대로 나와야 한다`);
      console.log(`  · 표본 ${sample.id} — 지시문 ${sp.length}자, 빈 표 ${blankForms(sample).length}개`);
    }
  }
}

console.log(`\n검사 ${checks}건 중 ${fails}건 어긋남`);
if (fails) { console.error('실패 — 위 사유를 고칠 것'); process.exitCode = 1; }
else console.log('통과');
