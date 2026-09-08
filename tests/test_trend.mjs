/* 연도별 추이·그림 분할·표지 떼기 시험 — node tests/test_trend.mjs
   시험 틀을 쓰지 않는다. 어긋나면 사유를 찍고 process.exitCode = 1로 끝낸다.

   보는 것
     1. chunkRows() 가 지표를 고르게 가르는가 — 22개는 12+10이 아니라 11+11이어야 한다
     2. 갈라 낸 장의 세로 크기가 한글 한 쪽(약 250mm)에 들어오는가
     3. trendSeries() 가 연도·값·사분위를 계약대로 만드는가
     4. analyzeTrend() 가 실제 자료에서 계열을 만들고, 자동 선정이 차이 큰 지표를 고르는가
     5. layoutTrend() 좌표에 NaN 이 없고 그림 안에 들어오는가
     6. narrateTrend() 원고가 마커 문법을 지키고 표주를 물고 있는가
     7. stripFront() 가 표지 구역을 떼고도 열리는 hwpx 를 내는가 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chunkRows, PER_SHEET } from '../app/assets/chart.js';
import {
  trendSeries, analyzeTrend, layoutTrend, narrateTrend, ticksOf, noteworthy,
  CELL_W, CELL_H, PER_SHEET as TREND_PER_SHEET,
} from '../app/assets/trend.js';
import { loadIndex, loadSeries, groupCodes, KEY_CODES } from '../app/assets/indicator.js';
import { stripFront, hasFront, wantsFront } from '../app/assets/cover.js';
import { unzip } from '../app/assets/zip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let fails = 0; let checks = 0;
const ok = (cond, msg, extra) => {
  checks += 1;
  if (cond) { console.log(`  통과 — ${msg}`); return true; }
  fails += 1;
  console.error(`  실패 — ${msg}${extra ? `\n      ${String(extra).slice(0, 400)}` : ''}`);
  return false;
};
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`);

/* ───────── 1. 그림 장 나누기 ───────── */
head('그림 장 나누기 (chunkRows)');
{
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ code: `X${i}` }));
  const sizes = (n, per) => chunkRows(mk(n), per).map((c) => c.length);

  ok(sizes(22, 12).join('+') === '11+11',
    '핵심지표 22개는 11+11로 갈린다(요청 사항)', sizes(22, 12).join('+'));
  ok(sizes(12, 12).join('+') === '12', '상한과 같으면 한 장 그대로');
  ok(sizes(1, 12).join('+') === '1', '한 개도 한 장');
  ok(sizes(0, 12).length === 1 && sizes(0, 12)[0] === 0, '빈 목록도 장 하나를 준다(그리기 쪽에서 걸러 낸다)');
  ok(sizes(13, 12).join('+') === '7+6', '13개는 12+1이 아니라 7+6으로 고르게 갈린다', sizes(13, 12).join('+'));
  ok(sizes(25, 12).join('+') === '9+9+7', '25개는 세 장으로 고르게', sizes(25, 12).join('+'));
  ok(sizes(187, 12).every((v) => v <= 12), '전체지표 187개도 어느 장이든 상한을 넘지 않는다');
  ok(chunkRows(mk(22), 12).flat().length === 22, '갈라도 지표가 빠지거나 겹치지 않는다');
  ok(PER_SHEET === 12, '한 장 상한은 12줄');

  /* 그림은 폭 120mm 로 들어간다. 한글 A4 본문 세로가 약 250mm 이므로
     세로/가로 비율이 2.08 을 넘으면 한 쪽에 못 들어간다 */
  const HEAD = 78; const ROW = 104; const FOOT = 34; const W = 980;
  const mm = (rows) => (HEAD + rows * ROW + FOOT) / W * 120;
  ok(mm(11) < 200, `11줄 그림 세로 ${mm(11).toFixed(0)}mm — 한 쪽 안`, mm(11));
  ok(mm(12) < 210, `12줄(상한) 그림 세로 ${mm(12).toFixed(0)}mm — 한 쪽 안`, mm(12));
  ok(mm(22) > 250, `22줄을 한 장에 넣으면 ${mm(22).toFixed(0)}mm — 쪽을 넘긴다(가르는 이유)`);
}

/* ───────── 2. 계열 만들기 ───────── */
head('계열 만들기 (trendSeries)');
{
  const sr = {
    code: 'T1',
    name: '시험지표',
    unit: '%',
    years: [2018, 2019, 2020, 2021],
    values: {
      '11110': [10, 12, null, 16],
      a: [1, 2, 3, 4], b: [3, 4, 5, 6], c: [5, 6, 7, 8], d: [7, 8, 9, 10],
    },
  };
  const s = trendSeries(sr, { region: '11110', group: ['a', 'b', 'c', 'd'] });
  ok(s.years.join(',') === '2018,2019,2020,2021', '연도를 그대로 옮긴다');
  ok(s.mine.join(',') === '10,12,,16', '우리 값의 결측은 null 로 남는다(선을 끊는 자리)', JSON.stringify(s.mine));
  ok(s.avg.every((v, i) => v === [4, 5, 6, 7][i]), '비교집단 평균은 단순평균', JSON.stringify(s.avg));
  ok(s.q1[0] === 2.5 && s.q3[0] === 5.5, 'Q1·Q3 는 선형보간 사분위', `${s.q1[0]}/${s.q3[0]}`);
  ok(s.n.every((v) => v === 4), 'n 은 값이 있는 지역 수');
  ok(s.nation === null, '전국 배열을 안 주면 전국 선은 만들지 않는다');

  const cut = trendSeries(sr, { region: '11110', group: ['a', 'b'], from: 2019, to: 2020 });
  ok(cut.years.join(',') === '2019,2020', 'from·to 로 기간을 자른다');

  const few = trendSeries(sr, { region: '11110', group: ['a', 'b'] });
  ok(few.q1.every((v) => v === null), '비교집단이 4곳 미만이면 사분위를 내지 않는다');
}

/* ───────── 3. 눈금 ───────── */
head('눈금 (ticksOf)');
{
  const t = ticksOf(0, 100);
  ok(t.length >= 3 && t.length <= 8, `0~100 눈금 ${t.length}칸`, t.join(','));
  ok(t.every((v) => Number.isFinite(v)), '눈금에 NaN 이 없다');
  ok(ticksOf(5, 5).length === 1, '위아래가 같으면 눈금 한 개');
  const neg = ticksOf(-3.2, 1.8);
  ok(neg.some((v) => v < 0) && neg.some((v) => v > 0), '음수를 걸친 구간은 0 위아래로 눈금이 선다', neg.join(','));
  ok(neg.length >= 4, `음수 구간 눈금 ${neg.length}칸 — 두세 줄로 성기지 않다`, neg.join(','));
  const spans = [[0, 100], [-3.2, 1.8], [12.4, 13.1], [0.001, 0.004], [980, 1240], [-50, -12]];
  const counts = spans.map(([a, b]) => ticksOf(a, b).length);
  ok(counts.every((c) => c >= 3 && c <= 8),
    `구간 ${spans.length}가지 모두 3~8칸 (${counts.join('/')})`, counts.join('/'));
  const tiny = ticksOf(0.001, 0.004);
  ok(tiny.length >= 2 && tiny.every((v) => Number.isFinite(v)), '아주 작은 값 구간도 눈금이 선다', tiny.join(','));
}

/* ───────── 4. 실제 자료로 ───────── */
head('실제 자료로 (analyzeTrend)');
const REGION = '41110';        // 경기도 수원시
{
  const series = await analyzeTrend({
    region: REGION, basis: '광역', codes: KEY_CODES, from: 2018, to: 2025, limit: 0,
  });
  ok(series.length > 0, `핵심지표에서 계열 ${series.length}개를 만들었다`);
  ok(series.every((s) => s.years.length >= 2), '모든 계열이 두 해 이상');
  ok(series.every((s) => s.mine.filter((v) => v != null).length >= 2),
    '모든 계열에 우리 지역 값이 두 해 이상 있다');
  ok(series.every((s) => s.nation && s.nation.length === s.years.length),
    '광역 비교이므로 전국 선을 함께 만든다');

  const auto = await analyzeTrend({
    region: REGION, basis: '광역', codes: KEY_CODES, from: 2018, to: 2025, limit: 4,
  });
  ok(auto.length === 4, `자동 선정은 4개까지 (${auto.length}개)`);
  const rest = series.filter((s) => !auto.some((a) => a.code === s.code));
  const minPicked = Math.min(...auto.map(noteworthy));
  const maxRest = rest.length ? Math.max(...rest.map(noteworthy)) : -Infinity;
  ok(minPicked >= maxRest,
    '고른 지표가 안 고른 지표보다 비교집단과 더 크게 다르다', `${minPicked} vs ${maxRest}`);
  const order = auto.map((a) => a.code);
  const want = series.filter((s) => order.includes(s.code)).map((s) => s.code);
  ok(order.join(',') === want.join(','),
    '고른 뒤에는 원래 차례로 되돌린다(선정 순서가 중요도로 읽히지 않게)', order.join(','));

  const nation = await analyzeTrend({
    region: REGION, basis: '전국', codes: ['A1'], from: 2020, to: 2025, limit: 0,
  });
  ok(nation[0].nation === null, '전국 비교면 전국 선을 겹쳐 그리지 않는다');

  let threw = '';
  try { await analyzeTrend({ region: '99999', basis: '광역', codes: ['A1'] }); } catch (e) { threw = e.message; }
  ok(/찾지 못했다/.test(threw), '없는 지역 코드는 오류로 막는다', threw);

  /* ───────── 5. 배치 ───────── */
  head('배치 (layoutTrend)');
  const sheets = chunkRows(auto, TREND_PER_SHEET);
  ok(sheets.length === 1 && sheets[0].length === 4, `추이 4개는 한 장 (${TREND_PER_SHEET}개 상한)`);
  const lay = layoutTrend(auto, {
    title: '연도별 추이 — 경기도 수원시', basis: '광역', regionName: '경기도 수원시', scale: 2,
  });
  ok(lay.width === 16 * 2 + 2 * CELL_W && lay.height === 44 + 2 * CELL_H + 26,
    `배치 크기 ${lay.width}×${lay.height} (2열 × 2행)`);
  const bad = lay.ops.filter((o) => [o.x, o.y, o.x0, o.y0, o.x1, o.y1]
    .some((v) => v !== undefined && !Number.isFinite(v)));
  ok(bad.length === 0, '좌표에 NaN·Infinity 가 없다', JSON.stringify(bad[0] || {}));
  const outside = lay.ops.filter((o) => o.op === 'text'
    && (o.x < -1 || o.x > lay.width + 1 || o.y < 0 || o.y > lay.height + 1));
  ok(outside.length === 0, '글자가 그림 밖으로 나가지 않는다', JSON.stringify(outside[0] || {}));
  ok(lay.ops.some((o) => o.op === 'band'), 'Q1~Q3 밴드를 그린다');
  ok(lay.ops.some((o) => o.op === 'path' && o.width === 2.6), '우리 지역은 굵은 실선');
  ok(lay.ops.some((o) => o.op === 'path' && String(o.dash) === '5,3'), '비교집단 평균은 파선');
  ok(lay.ops.some((o) => o.op === 'path' && String(o.dash) === '2,3'), '전국 평균은 점선');
  ok(lay.ops.some((o) => o.op === 'dot'), '우리 지역 선에는 연도마다 점');
  ok(lay.ops.some((o) => o.op === 'text' && /※ 자료/.test(o.text)), '표주를 그림 안에 넣는다');

  const one = layoutTrend([auto[0]], { scale: 2 });
  ok(one.width === 16 * 2 + CELL_W, '한 개면 1열로 좁게 그린다');

  let lthrew = '';
  try { layoutTrend([], {}); } catch (e) { lthrew = e.message; }
  ok(/그릴 추이 계열이 없다/.test(lthrew), '빈 목록은 조용히 넘기지 않고 오류', lthrew);

  /* ───────── 6. 원고 ───────── */
  head('원고 (narrateTrend)');
  const text = narrateTrend(auto, { basis: '광역' });
  const lines = text.split('\n');
  ok(lines[0] === '#### 연도별 추이', '넷째 수준 머리글로 시작한다(절 안에 들어가는 마디)', lines[0]);
  ok(/※ 자료：보건복지부·한국보건사회연구원/.test(text), '표주에 원자료를 밝힌다');
  ok(text.includes('담당자 작성'), '함의는 비워 두고 담당자 자리를 남긴다');
  ok(auto.every((s) => text.includes(`○ ${s.name}`)), '고른 지표가 모두 원고에 나온다');
  const marks = lines.filter((l) => l.trim()).every((l) => /^(####|○|-|※)/.test(l.trim()));
  ok(marks, '모든 줄이 마커 문법(####·○·-·※)을 지킨다',
    lines.filter((l) => l.trim() && !/^(####|○|-|※)/.test(l.trim()))[0]);
  ok(!/Q1~Q3 구간.*밖.*때문|따라서|시급/.test(text),
    '사실만 적고 함의를 지어내지 않는다');

  let nthrew = '';
  try { narrateTrend([], {}); } catch (e) { nthrew = e.message; }
  ok(/만들 계열이 없다/.test(nthrew), '빈 목록은 오류', nthrew);
}

/* ───────── 7. 원고가 실제로 hwpx가 되는가 ─────────
   narrate()·narrateTrend()가 낸 원고를 눈으로만 보고 넘기면, 줄머리 기호가
   한글 글머리표와 겹치는 [이중 기호] 같은 것이 빌드에서야 터진다. 실제로 만들어 본다. */
head('자동 원고가 실제로 hwpx가 되는가');
{
  const { analyze, narrate } = await import('../app/assets/indicator.js');
  const { buildForm } = await import('../app/assets/hwpx-form.js');
  const form = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/form.json'), 'utf8'));
  const tpl = new Uint8Array(fs.readFileSync(path.join(ROOT, 'app/data/template.hwpx')));
  const { regions } = await loadIndex();

  const opts = { region: REGION, basis: '광역', codes: KEY_CODES, year: null };
  const rows = await analyze(opts);
  const series = await analyzeTrend({
    region: REGION, basis: '광역', codes: KEY_CODES, from: 2018, to: 2025, limit: 4,
  });
  const text = narrate(rows, { ...opts, regionName: '경기도 수원시', regions })
    + '\n\n' + narrateTrend(series, { basis: '광역' });

  /* 22개 지표 원고에 세 갈래가 다 나오는지 — 요청한 작성 지시 */
  ok(/뚜렷이 다른 지표/.test(text), '차이가 큰 지표를 따로 세운다');
  ok(/비슷한 수준인 지표.*개별 서술 생략/.test(text), '비슷한 지표는 이름만 묶는다');
  ok(/종합 진단과 정책 방향/.test(text), '마지막에 종합 진단 자리를 둔다');

  /* 줄머리 기호 뒤에 또 기호가 오지 않는가 — 빌드가 막히는 자리 */
  const dbl = text.split('\n').filter((l) => /^[○▪\-·]\s+[○□▪◦·※•]/.test(l.trim()));
  ok(dbl.length === 0, '기호 줄이 또 기호로 시작하지 않는다(이중 기호)', dbl[0]);

  let built = null; let why = '';
  try {
    built = await buildForm(tpl, form, text, { images: new Map() });
  } catch (e) { why = e.message; }
  ok(built !== null, '자동 원고가 그대로 hwpx로 나온다', why);
  if (built) {
    ok(built.bytes.length > 40000, `산출 ${Math.round(built.bytes.length / 1024)}KB`);
    const z = await unzip(built.bytes);
    ok(z.has(form.section), '본문 구역이 들어 있다');
    const body = new TextDecoder().decode(z.get(form.section));
    ok(/추이/.test(body), '추이 마디가 본문에 들어갔다');
    ok(!/__IMAGE_PLACEHOLDER/.test(body), '자리표가 본문에 남지 않았다');
  }
}

/* ───────── 8. 표지 떼기 ───────── */
head('표지 떼기 (cover.js)');
{
  const form = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/form.json'), 'utf8'));
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'app/data/template.hwpx')));
  const before = await unzip(bytes);
  ok(hasFront(before), '안내서 원본에는 뗄 표지 구역이 있다');

  const out = await stripFront(bytes, form.section);
  const after = await unzip(out);
  ok(!after.has('Contents/section1.xml'), '표지 구역(section1)이 사라졌다');
  ok(!after.has('Contents/section2.xml'), '본문 구역은 section0 으로 앞당겨졌다');
  ok(after.has('Contents/section0.xml'), 'section0 이 본문 구역이다');
  ok(after.has('Contents/header.xml'), 'header.xml 은 손대지 않는다(글꼴·자동 번호매기기)');

  const headBefore = Buffer.from(before.get('Contents/header.xml'));
  const headAfter = Buffer.from(after.get('Contents/header.xml'));
  ok(headBefore.equals(headAfter), 'header.xml 바이트가 한 글자도 바뀌지 않았다');

  const bodyBefore = Buffer.from(before.get(form.section));
  const bodyAfter = Buffer.from(after.get('Contents/section0.xml'));
  ok(bodyBefore.equals(bodyAfter), '본문 구역 내용은 이름만 바뀌고 그대로다');

  const hpf = new TextDecoder().decode(after.get('Contents/content.hpf'));
  ok(!/href="Contents\/section1\.xml"/.test(hpf), '매니페스트에 뗀 구역이 남지 않았다');
  ok(!/href="Contents\/masterpage[01]\.xml"/.test(hpf), '뗀 구역의 바탕쪽도 매니페스트에서 빠졌다');
  ok(/<opf:item[^>]*href="Contents\/section0\.xml"/.test(hpf), '매니페스트가 새 이름을 가리킨다');
  const refs = (hpf.match(/<opf:itemref\b[^>]*idref="section\d+"/g) || []);
  ok(refs.length === 1 && /section0/.test(refs[0]), `읽기 차례에 구역이 하나만 남았다 (${refs.join(' ')})`);

  const rdf = new TextDecoder().decode(after.get('META-INF/container.rdf'));
  ok(!/section1\.xml|masterpage[01]\.xml/.test(rdf), '메타에도 뗀 구역이 남지 않았다');
  ok(/Contents\/section0\.xml/.test(rdf), '메타가 새 이름을 가리킨다');

  const mime = after.get('mimetype');
  ok(mime && new TextDecoder().decode(mime) === 'application/hwp+zip', 'mimetype 이 그대로다');

  /* 어느 마디에 표지를 붙이는가 */
  ok(wantsFront('1') && wantsFront('01') && wantsFront('1-2') && wantsFront('01_3'),
    '제1장 마디에는 표지를 붙인다');
  ok(!wantsFront('2') && !wantsFront('11') && !wantsFront('3-1') && !wantsFront(''),
    '제1장이 아니거나 마디를 안 고르면(지역여건) 붙이지 않는다');
}

console.log(`\n검사 ${checks}건 · 실패 ${fails}건`);
if (fails) process.exitCode = 1;
