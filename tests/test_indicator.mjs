/* 지표 분석 엔진·Canvas 차트 시험 — node tests/test_indicator.mjs
   시험 틀을 쓰지 않는다. 어긋나면 사유를 찍고 process.exitCode = 1로 끝낸다.

   보는 것
     1. quantile/mean/fmt 가 기존 대시보드(app.js)와 같은 값을 내는가
     2. groupCodes()의 세 기준별 개수가 맞는가(전국 229 / 광역 / 유형)
     3. 시·도·유형이 서로 다른 시·군·구 5곳에서 핵심지표 22개가 모두 산출되는가
     4. 대구 군위군(27720)은 유형 비교가 빠지는가
     5. narrate() 원고가 비어 있지 않고 표주 문장을 물고 있는가
     6. layoutChart() 좌표가 캔버스 안에 들어오고 라벨이 겹치지 않는가
     7. (playwright 가 있으면) 실제 Chromium 에서 PNG 가 나오는가 — 없으면 건너뛴 사실을 남긴다 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  KEY_CODES, loadIndex, groupCodes, analyze, narrate,
  quantile, mean, fmt, fmtRef, boxStats, latestYearOf, valAt, loadSeries,
} from '../app/assets/indicator.js';
import { layoutChart, textBox, textWidth } from '../app/assets/chart.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, 'app');
const REF = '/home/user/kihasa-indicator-new/static/assets/app.js';

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (cond) { console.log(`  통과 — ${msg}`); return true; }
  fails++;
  console.error(`  실패 — ${msg}${extra ? `\n      ${String(extra).slice(0, 400)}` : ''}`);
  return false;
};
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`);
const near = (a, b) => a == null && b == null ? true
  : (a != null && b != null && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)));

/* ───────── 1. 대시보드 원본과 수치 대조 ───────── */
head('기존 대시보드와 수치 대조');
const require_ = createRequire(import.meta.url);
let ref = null;
try { ref = require_(REF); } catch (e) { ok(false, '대시보드 app.js 를 읽었다', e.message); }

if (ref) {
  const samples = [
    [1, 2, 3, 4],
    [0.5, 1.25, 3.5, 7, 9, 11.5],
    [-4, -1, 0, 2, 8, 13, 21],
    [5],
    [2, 2, 2, 2, 2],
    Array.from({ length: 229 }, (_, i) => Math.sin(i) * 100 + i * 0.37).sort((a, b) => a - b),
  ];
  const ps = [0, 0.05, 0.25, 0.3333, 0.5, 0.75, 0.9, 1];
  let bad = null;
  for (const s of samples) {
    for (const p of ps) {
      const a = quantile(s, p), b = ref.quantile(s, p);
      if (!near(a, b)) { bad = `n=${s.length} p=${p} → 우리 ${a} / 대시보드 ${b}`; break; }
    }
    if (bad) break;
  }
  ok(!bad, `quantile()이 대시보드와 같다(표본 ${samples.length}개 × 분위 ${ps.length}개)`, bad);
  ok(quantile([], 0.5) === null && ref.quantile([], 0.5) === null, '빈 배열이면 둘 다 null');
  ok(samples.every((s) => near(mean(s), ref.mean(s))), 'mean()이 대시보드와 같다');
  ok([0.123456, 12.5, 250.4, 1234.5, 3.4e8, 5.1e12].every((v) => fmt(v, '%') === ref.fmt(v, '%')),
    'fmt()가 대시보드와 같다');
}

/* boxStats 도 원본 정의대로인지 직접 확인 */
{
  const s = [1, 2, 3, 4, 5, 6, 7, 8];
  const st = boxStats(s);
  ok(st.n === 8 && st.min === 1 && st.max === 8 && near(st.q1, ref ? ref.quantile(s, 0.25) : 2.75)
    && near(st.q3, ref ? ref.quantile(s, 0.75) : 6.25) && near(st.avg, 4.5),
  'boxStats()가 min·max·평균·Q1·Q3·n 을 원본 정의대로 낸다', JSON.stringify(st));
  ok(boxStats([]) === null, '값이 없으면 boxStats()는 null');
  ok(fmtRef(1234.56) === '1,235' && fmtRef(250.44) === '250.4' && fmtRef(1.239) === '1.24'
    && fmtRef(null) === '–', 'fmtRef() 표기 규칙(1000↑ 정수 / 100↑ 소수1 / 그 미만 소수2)');
}

/* ───────── 2. 색인·비교집단 ───────── */
head('색인 적재와 비교집단');
const { catalog, regions } = await loadIndex();
const sgg = regions.filter((r) => r.level === '시군구');
ok(sgg.length === 229, `시·군·구 ${sgg.length}곳을 읽었다(229여야 한다)`);
ok(KEY_CODES.length === 22, `핵심지표 ${KEY_CODES.length}개(22여야 한다)`);
ok(KEY_CODES.every((c) => catalog.items.some((i) => i.code === c)), '핵심지표가 모두 카탈로그에 있다');

const nationCodes = groupCodes(regions, '전국', '11110');
ok(nationCodes.length === 229, `전국 비교집단 ${nationCodes.length}곳`);
{
  let bad = null;
  for (const code of ['11110', '26350', '41110', '47110', '48250']) {
    const me = regions.find((r) => r.code === code);
    const wide = groupCodes(regions, '광역', code);
    const want = sgg.filter((r) => r.sido === me.sido).length;
    if (wide.length !== want) { bad = `${me.sido} ${me.sigungu}: ${wide.length} ≠ ${want}`; break; }
    const type = groupCodes(regions, '유형', code);
    const wantT = sgg.filter((r) => r.type7 != null && r.type7 === me.type7).length;
    if (type.length !== wantT) { bad = `${me.sido} ${me.sigungu} 유형: ${type.length} ≠ ${wantT}`; break; }
    if (!wide.includes(code) || !type.includes(code)) { bad = `${code}가 제 비교집단에 없다`; break; }
  }
  ok(!bad, '광역·유형 비교집단 개수가 지역 목록과 맞는다', bad);
}
ok(groupCodes(regions, '유형', '27720').length === 0,
  '군위군(27720)은 유형이 없어 유형 비교집단이 비어 있다');

/* ───────── 3. 시·도·유형이 다른 5곳 분석 ───────── */
head('시·군·구 5곳 핵심지표 산출');
const PICKS = [
  { code: '11110', basis: '전국' },   // 서울 종로구
  { code: '26350', basis: '광역' },   // 부산 해운대구
  { code: '41110', basis: '유형' },   // 경기 수원시(계약 예시)
  { code: '47110', basis: '광역' },   // 경북 포항시
  { code: '48250', basis: '유형' },   // 경남 김해시 등
];
{
  const seenSido = new Set(), seenType = new Set();
  let bad = null;
  for (const p of PICKS) {
    const me = regions.find((r) => r.code === p.code);
    if (!me) { bad = `${p.code} 지역을 찾지 못했다`; break; }
    seenSido.add(me.sido); seenType.add(me.type7);
    const rows = await analyze({ region: p.code, basis: p.basis, codes: KEY_CODES, year: null });
    if (rows.length !== 22) { bad = `${me.sido} ${me.sigungu}: ${rows.length}/22 산출`; break; }
    const grpN = groupCodes(regions, p.basis, p.code).length;
    for (const r of rows) {
      const why = (m) => `${me.sido} ${me.sigungu} · ${r.code} ${m}`;
      if (!Number.isFinite(r.year)) { bad = why('연도가 없다'); break; }
      if (!(r.n > 0 && r.n <= grpN)) { bad = why(`n=${r.n} 이 비교집단 ${grpN}곳을 벗어난다`); break; }
      if (!(r.min <= r.q1 && r.q1 <= r.q3 && r.q3 <= r.max)) { bad = why('min≤Q1≤Q3≤max 가 깨졌다'); break; }
      if (!(r.avg >= r.min && r.avg <= r.max)) { bad = why('평균이 min~max 밖이다'); break; }
      if (r.mine != null && !(r.rank >= 1 && r.rank <= r.n)) { bad = why(`순위 ${r.rank}가 1~${r.n} 밖이다`); break; }
      if (!r.nation || r.nation.n <= 0) { bad = why('전국 평균이 비었다'); break; }
      if (me.type7 != null && (!r.peerType || r.peerType.n <= 0)) { bad = why('유형 평균이 비었다'); break; }
      if (!r.name || typeof r.unit !== 'string') { bad = why('지표명·단위가 없다'); break; }
    }
    if (bad) break;
    /* 표본 한 줄을 대시보드 계산 순서로 다시 밟아 값이 같은지 본다 */
    const sr = await loadSeries(rows[0].code);
    const grp = groupCodes(regions, p.basis, p.code);
    const yr = latestYearOf(sr, grp);
    const vals = grp.map((c) => valAt(sr, c, yr)).filter((v) => v != null).sort((a, b) => a - b);
    const st = boxStats(vals);
    if (rows[0].year !== yr || !near(rows[0].avg, st.avg) || !near(rows[0].q1, st.q1)
      || !near(rows[0].q3, st.q3) || rows[0].n !== st.n || !near(rows[0].mine, valAt(sr, p.code, yr))) {
      bad = `${me.sido} ${me.sigungu} · ${rows[0].code} 재계산 값이 다르다`;
      break;
    }
    console.log(`    ${me.sido} ${me.sigungu}(유형 ${me.type7}) · ${p.basis} 비교 · ` +
      `22/22 · ${rows[0].name} ${fmtRef(rows[0].mine)} (${rows[0].year}년, n=${rows[0].n})`);
  }
  ok(!bad, '5곳 모두 핵심지표 22/22 산출 + 통계량 정합', bad);
  ok(seenSido.size === 5, `시·도가 서로 다른 5곳을 골랐다(${[...seenSido].join(', ')})`);
  ok(seenType.size >= 3, `시·군·구 유형이 ${seenType.size}가지로 갈린다`);
}

/* 화면의 '전체 지표' 경로 — 계열 파일이 없는 코드가 섞여도 버티는가 */
{
  const all = catalog.items.filter((i) => i.kind === '지표').map((i) => i.code);
  const rows = await analyze({ region: '11110', basis: '전국', codes: all, year: null });
  ok(rows.length > 60 && rows.length <= all.length,
    `전체 지표 ${all.length}개 요청 → ${rows.length}개 산출(계열이 없는 코드는 건너뛴다)`);
}

/* 연도 지정 산출도 되는지 */
{
  const rows = await analyze({ region: '11110', basis: '전국', codes: ['A1'], year: 2020 });
  ok(rows.length === 1 && rows[0].year === 2020 && rows[0].n > 200,
    '연도를 지정하면 그 연도로 산출한다', JSON.stringify(rows[0] || {}));
}

/* ───────── 4. 군위군 ───────── */
head('대구 군위군(유형 없음)');
const gunwi = await analyze({ region: '27720', basis: '광역', codes: KEY_CODES, year: null });
ok(gunwi.length === 22, `군위군 ${gunwi.length}/22 산출`);
ok(gunwi.every((r) => r.peerType === null), '모든 줄에서 peerType 이 null 이다');
ok(gunwi.every((r) => r.nation && r.nation.n > 0), '전국 비교는 그대로 붙는다');
{
  let threw = '';
  try { await analyze({ region: '27720', basis: '유형', codes: ['A1'], year: null }); }
  catch (e) { threw = e.message; }
  ok(/유형/.test(threw), '유형 비교를 요구하면 한국어 사유로 막는다', threw || '오류가 나지 않았다');
}

/* ───────── 5. 원고 ───────── */
head('narrate() 원고');
const NOTE = '※ 자료：보건복지부·한국보건사회연구원, 「지역사회보장지표」.';
const NOTE2 = '값은 지표별 최신연도 기준이며, 평균은 시·군·구 단순평균임.';
{
  const rows = await analyze({ region: '41110', basis: '광역', codes: KEY_CODES, year: null });
  const txt = narrate(rows, { region: '41110', basis: '광역', regions, catalog });
  ok(txt.trim().length > 200, `원고가 비어 있지 않다(${txt.length}자)`);
  ok(txt.includes(NOTE) && txt.includes(NOTE2), '표주 문장이 고정 문구 그대로 들어 있다');
  ok(/○ /.test(txt) && /\n- /.test(txt), '개조식 마커(○ · -)를 쓴다');
  ok(/비교집단 \d+곳 중 \d+위/.test(txt), '비교집단 규모(n)와 순위를 병기한다');
  ok(/\(\d{4}년\)/.test(txt), '지표별 연도를 병기한다');
  ok(/상위 \d+%/.test(txt) && /하위 \d+%/.test(txt), '강점·취약 쪽을 상위·하위 표기로 갈라 쓴다');
  ok(!/습니다|합니다|입니다/.test(txt), '존댓말이 섞이지 않았다');

  const gTxt = narrate(gunwi, { region: '27720', basis: '광역', regions, catalog });
  ok(gTxt.includes(NOTE) && /유형/.test(gTxt) && /넣지 않았다|빠져/.test(gTxt),
    '군위군 원고는 유형별 비교를 빼고 그 사실을 적는다');
  ok(!/같은 유형/.test(gTxt), '군위군 원고에 유형 평균 문장이 없다');
  console.log('    ── 원고 앞부분 ──');
  console.log(txt.split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'));

  let threw = '';
  try { narrate([], {}); } catch (e) { threw = e.message; }
  ok(threw.length > 0, '결과가 없으면 조용히 넘기지 않고 오류를 던진다', threw);
}

/* ───────── 6. 차트 배치 ───────── */
head('layoutChart() 좌표·라벨');
const chartRows = await analyze({ region: '41110', basis: '광역', codes: KEY_CODES, year: null });
{
  const lay = layoutChart(chartRows, { title: '경기도 수원시', basis: '광역', scale: 2 });
  ok(lay.width > 0 && lay.height > 0 && lay.rows.length === 22,
    `캔버스 ${lay.width}×${lay.height}, 지표 줄 ${lay.rows.length}개`);

  let bad = null;
  for (const it of lay.ops) {
    if (it.op === 'text') {
      const b = textBox(it);
      if (b.x0 < -0.5 || b.x1 > lay.width + 0.5 || b.y < 0 || b.y > lay.height) {
        bad = `글자 "${it.text}" 상자 ${b.x0.toFixed(1)}~${b.x1.toFixed(1)} (y=${b.y})`; break;
      }
    } else if (it.op === 'line') {
      if (Math.min(it.x0, it.x1) < 0 || Math.max(it.x0, it.x1) > lay.width
        || Math.min(it.y0, it.y1) < 0 || Math.max(it.y0, it.y1) > lay.height) {
        bad = `선 (${it.x0},${it.y0})-(${it.x1},${it.y1})`; break;
      }
    } else if (it.op === 'rect') {
      if (it.x < 0 || it.x + it.w > lay.width || it.y < 0 || it.y + it.h > lay.height) {
        bad = `사각형 x=${it.x} w=${it.w} y=${it.y}`; break;
      }
    } else {
      if (it.x - it.r < 0 || it.x + it.r > lay.width || it.y - it.r < 0 || it.y + it.r > lay.height) {
        bad = `${it.op} x=${it.x} y=${it.y} r=${it.r}`; break;
      }
    }
  }
  ok(!bad, '모든 도형·글자가 캔버스 경계 안에 있다', bad);

  /* 같은 줄에 놓인 글자끼리 겹치지 않아야 한다 */
  const lanes = new Map();
  for (const it of lay.ops) {
    if (it.op !== 'text') continue;
    const key = `${it.row}|${Math.round(it.y)}`;
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(textBox(it));
  }
  let clash = null;
  for (const [key, boxes] of lanes) {
    boxes.sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < boxes.length; i++) {
      if (boxes[i].x0 < boxes[i - 1].x1 - 0.01) {
        clash = `줄 ${key}: ${boxes[i - 1].x1.toFixed(1)} 뒤에 ${boxes[i].x0.toFixed(1)} 이 겹친다`;
        break;
      }
    }
    if (clash) break;
  }
  ok(!clash, `한 줄 안의 글자 ${lanes.size}묶음이 서로 겹치지 않는다`, clash);

  /* 우리 값 마름모·평균 원이 제 분포 구간 안에 찍히는가 */
  let mark = null;
  lay.rows.forEach((g, i) => {
    if (mark || !g.has) return;
    const r = chartRows[i];
    const dia = lay.ops.find((it) => it.op === 'diamond' && Math.abs(it.y - g.axisY) < 0.01);
    const cir = lay.ops.find((it) => it.op === 'circle' && Math.abs(it.y - g.axisY) < 0.01);
    if (!cir) { mark = `${r.code}: 평균 원이 없다`; return; }
    if (cir.x < g.x0 || cir.x > g.x1) { mark = `${r.code}: 평균 원이 그림 밖(${cir.x})`; return; }
    if (r.mine != null) {
      if (!dia) { mark = `${r.code}: 우리 지역 마름모가 없다`; return; }
      const want = g.sx(r.mine);
      if (Math.abs(dia.x - want) > 0.01) mark = `${r.code}: 마름모 x=${dia.x} ≠ ${want}`;
    }
  });
  ok(!mark, '평균 원·우리 지역 마름모가 값 위치에 놓인다', mark);

  ok(lay.ops.some((it) => it.op === 'text' && it.text.includes(NOTE)), '그림에도 표주 문장이 들어간다');

  /* 자료가 없는 줄도 배치가 되는지 — 비어 있는 가짜 행 하나로 확인 */
  const empty = layoutChart([{ code: 'X1', name: '자료 없는 지표', unit: '%', year: 2025, mine: null,
    avg: null, q1: null, q3: null, min: null, max: null, n: 0, rank: null, peerType: null,
    nation: { avg: null, n: 0 } }], { title: '시험', basis: '전국' });
  ok(empty.rows.length === 1 && empty.rows[0].has === false
    && empty.ops.some((it) => it.op === 'text' && /자료 없음/.test(it.text)),
  '비교집단 자료가 없는 줄은 안내 문구로 대신한다');

  let threw = '';
  try { layoutChart([], {}); } catch (e) { threw = e.message; }
  ok(threw.length > 0, '행이 없으면 오류를 던진다', threw);

  ok(textWidth('가나다', 10) > textWidth('abc', 10), '한글 폭을 영문보다 넓게 잡는다');
}

/* ───────── 7. 실제 렌더(있을 때만) ───────── */
head('Chromium 렌더 확인');
async function getChromium() {
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright'];
  for (const t of tries) {
    try { return require_(t).chromium; } catch { /* 다음 후보 */ }
  }
  return null;
}
const chromium = await getChromium();
if (!chromium) {
  console.log('  건너뜀 — playwright 를 찾지 못했다(설치를 시도하지 않는다). ' +
    'Canvas 실렌더 검사는 하지 않았고, 배치 계산만 검증했다.');
} else {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  /* 다른 모듈 상태에 얽매이지 않도록 빈 문서를 따로 내준다(index.html 은 쓰지 않는다) */
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    if (rel === 'blank.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>차트 렌더 시험</title>');
      return;
    }
    const f = path.join(APP, rel);
    if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/blank.html`, { waitUntil: 'domcontentloaded' });
    const got = await page.evaluate(async () => {
      const ind = await import('./assets/indicator.js');
      const ch = await import('./assets/chart.js');
      const rows = await ind.analyze({ region: '41110', basis: '광역', codes: ind.KEY_CODES, year: null });
      const png = await ch.renderComparisonChart(rows, { title: '경기도 수원시', basis: '광역', scale: 2 });
      const lay = ch.layoutChart(rows, { title: '경기도 수원시', basis: '광역', scale: 2 });
      const sig = Array.from(png.slice(0, 8)).join(',');
      const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      let bin = '';
      for (const b of png) bin += String.fromCharCode(b);
      return { len: png.length, sig, w: bmp.width, h: bmp.height, lw: lay.width, lh: lay.height,
        rows: rows.length, b64: btoa(bin) };
    });
    ok(got.sig === '137,80,78,71,13,10,26,10', 'PNG 서명(‰PNG)이 맞는다', got.sig);
    ok(got.w === got.lw * 2 && got.h === got.lh * 2,
      `PNG 크기가 배치×scale 과 같다(${got.w}×${got.h})`, JSON.stringify(got));
    ok(got.len > 20000, `PNG 용량 ${Math.round(got.len / 1024)}KB — 빈 그림이 아니다`);
    ok(errs.length === 0, '브라우저 콘솔 오류 없음', errs.join(' | '));
    fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
    const png = path.join(HERE, 'out', 'chart_sample.png');
    fs.writeFileSync(png, Buffer.from(got.b64, 'base64'));
    console.log(`  그림 저장 — ${png} (눈으로 확인할 것)`);
  } finally {
    await browser.close();
    srv.close();
  }
}

/* ───────── 마무리 ───────── */
console.log(`\n검사 ${checks}건 중 실패 ${fails}건`);
if (fails) {
  console.error('시험 실패 — 위 사유를 보고 고칠 것');
  process.exitCode = 1;
} else {
  console.log('모두 통과');
}
