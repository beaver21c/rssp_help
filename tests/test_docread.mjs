/* 되돌리기(docread.js) 시험 — 본문 구역만 읽는가, 마커가 왕복하는가.
   실행: node tests/test_docread.mjs */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const { readBodyText, spanOf } = await import(path.join(ROOT, 'app/assets/docread.js'));
const { buildForm } = await import(path.join(ROOT, 'app/assets/hwpx-form.js'));

const form = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/form.json'), 'utf8'));
const tpl = new Uint8Array(fs.readFileSync(path.join(ROOT, 'app/data/template.hwpx')));

let fails = 0, checks = 0;
const ok = (c, m, e) => { checks++; if (!c) { fails++; console.error(`  ✗ ${m}${e ? `\n      ${String(e).slice(0, 300)}` : ''}`); } return c; };
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`);

const textsOf = async (bytes) => {
  const { unzip } = await import(path.join(ROOT, 'app/assets/zip.js'));
  const e = await unzip(bytes);
  const xml = new TextDecoder().decode(e.get(form.section));
  return Array.from(xml.matchAll(/<hp:t>([^<]+)<\/hp:t>/g)).map((m) => m[1]);
};

/* ───────── 1. 중첩을 견디는 주사기 ───────── */
head('1층 XML 주사기');
{
  const x = '<a><b>1</b><a><b>2</b></a><b>3</b></a>tail';
  const sp = spanOf(x, 'a', 0);
  ok(sp && sp.inner === '<b>1</b><a><b>2</b></a><b>3</b>', '중첩된 같은 태그를 건너뛴다', sp && sp.inner);
  ok(spanOf('<hp:tbl rowCnt="2"/>', 'hp:tbl', 0).inner === '', '자기닫힘 태그를 다룬다');
  ok(spanOf('<hp:t>x</hp:t>', 'hp:tbl', 0) === null, '없는 태그는 null');
  // 접두가 겹치는 태그에 걸리지 않아야 한다
  ok(spanOf('<hp:tblX>a</hp:tblX><hp:tbl>b</hp:tbl>', 'hp:tbl', 0).inner === 'b',
    '이름이 더 긴 태그를 잘못 물지 않는다');
}

/* ───────── 2. 왕복 ───────── */
head('2층 왕복 — 마커·표·열너비·표주');
const SRC = `# 제1장 지역사회보장계획 정책 방향 및 체계
## 가. 목표 및 추진전략
### 1) 목표 및 추진전략별 세부사업
#### (1) 세부사업 구성
○ 제6기 계획의 목표는 「모두가 누리는 지역사회보장」으로 설정
- 추진전략 4개, 중점추진사업 2개, 세부사업 6개로 구성
· 세부사업은 자체사업으로만 구성하며 국고보조사업은 제외

{cols=20,30,25,25}
| 구분 | 사회보장 전략 | 중점추진사업 | 세부사업 수 |
|---|---|---|---|
| 전략 1 | 노인 돌봄 확충 | 주간보호 확대 | 3 |
| 전략 2 | 아동 돌봄 강화 | 다함께돌봄센터 | 3 |
※ 자료：○○시 내부자료(2026).
`;
{
  const first = await buildForm(tpl, form, SRC, { images: new Map() });
  fs.writeFileSync(path.join(OUT, 'docread_1.hwpx'), Buffer.from(first.bytes));
  ok(first.issues.length === 0, '1차 조판 지적 없음', first.issues.join(' / '));

  const rb = await readBodyText(first.bytes, form);
  ok(rb.mode === 'style', '양식 스타일로 되짚었다', rb.mode);
  ok(rb.section === form.section, `본문 구역만 읽었다(${form.section})`, rb.section);
  ok(rb.skipped.length >= 2, '표지·제출문 구역을 건너뛰었다', JSON.stringify(rb.skipped));
  ok(rb.matched === rb.total, `문단 전부를 되짚었다(${rb.matched}/${rb.total})`);
  ok(!/<[a-z]/i.test(rb.text), '원고에 원시 XML 태그가 새지 않았다',
    (rb.text.match(/<[^>]{1,40}>/g) || []).slice(0, 3).join(' '));

  for (const mk of ['# ', '## 가.', '### 1)', '#### (1)', '○ ', '- ', '· ', '※ ']) {
    ok(rb.text.includes(mk), `마커 ${mk.trim()} 복원`);
  }
  ok(rb.text.includes('{cols=20,30,25,25}'), '열 너비 비율 복원',
    (rb.text.match(/\{cols=[^}]*\}/) || [])[0]);
  ok(rb.text.includes('| 전략 1 | 노인 돌봄 확충 | 주간보호 확대 | 3 |'), '표 내용 복원');

  const second = await buildForm(tpl, form, rb.text, { images: new Map() });
  fs.writeFileSync(path.join(OUT, 'docread_2.hwpx'), Buffer.from(second.bytes));
  const a = await textsOf(first.bytes), b = await textsOf(second.bytes);
  ok(JSON.stringify(a) === JSON.stringify(b), '왕복 후 본문 글자가 완전히 같다',
    `${a.length} vs ${b.length}`);
  ok(second.issues.length === 0, '재조판 지적 없음', second.issues.join(' / '));
}

/* ───────── 3. 남의 서식 ───────── */
head('3층 남의 서식 — 추정 경로로 넘어가는가');
{
  const guide = path.join(ROOT, 'source/제6기_지역사회보장계획_수립안내_시군구.hwpx');
  if (fs.existsSync(guide)) {
    const rb = await readBodyText(new Uint8Array(fs.readFileSync(guide)), form);
    ok(rb.section === form.section, '안내서 원본도 본문 구역만 읽는다', rb.section);
    ok(rb.text.length > 1000, '안내서 본문을 읽어 냈다', `${rb.text.length}자`);
    ok(!rb.text.includes('제  출  문'), '제출문(다른 구역)이 섞이지 않았다');
    console.log(`  안내서: 모드 ${rb.mode} · 되짚음 ${rb.matched}/${rb.total} · ${rb.text.length}자`);
  } else {
    console.log('  (안내서 원본이 없어 건너뜀)');
  }
}

/* ───────── 4. 잘못된 입력 ───────── */
head('4층 잘못된 입력');
{
  let threw = false;
  try { await readBodyText(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), form); }
  catch (e) { threw = /hwp|한글|바이너리/i.test(e.message); }
  ok(threw, '한글 바이너리(.hwp)를 거부한다');

  threw = false;
  try { await readBodyText(new Uint8Array([1, 2, 3, 4, 5]), form); } catch { threw = true; }
  ok(threw, '깨진 파일을 거부한다');
}

console.log(`\n단언 ${checks}건 중 실패 ${fails}건`);
if (fails) { console.error('시험 실패'); process.exitCode = 1; }
else console.log('모두 통과');
