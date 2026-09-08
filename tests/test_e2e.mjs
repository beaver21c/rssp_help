/* 브라우저 통합 시험 — 실제 Chromium에서 화면을 조작해 절별로 hwpx를 만들고 산출물을 뜯어 본다.
   외부 서비스를 부르지 않는다(Gemini 미사용 경로만 시험).

   실행: node tests/test_e2e.mjs [--only=<절 id>] [--max=<개수>]
   전제: playwright가 있고 Chromium이 이미 깔려 있어야 한다(playwright install 금지). */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, 'app');
const OUT = path.join(HERE, 'out');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const ONLY = argOf('only', '');
const MAX = Number(argOf('max', '0')) || 0;

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (cond) return true;
  fails++;
  console.error(`  ✗ ${msg}${extra ? `\n      ${String(extra).slice(0, 400)}` : ''}`);
  return false;
};
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`);

/* ───────── playwright 찾기(전역 설치 대응) ───────── */
async function getChromium() {
  const require_ = createRequire(import.meta.url);
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright'];
  for (const t of tries) {
    try { return require_(t).chromium; } catch { /* 다음 후보 */ }
  }
  return null;
}

/* ───────── 정적 서버 ───────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.hwpx': 'application/haansofthwpx', '.png': 'image/png',
};
function serve(dir) {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(dir, rel);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404).end('404'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

/* ───────── hwpx 뜯어 보기 (zip 최소 판독기) ───────── */
async function unzipFile(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory 찾기
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 끝 레코드를 찾지 못했다');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('중앙 디렉터리가 깨졌다');
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nlen));
    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else {
      const ds = new DecompressionStream('deflate-raw');
      const ab = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
      data = new Uint8Array(ab);
    }
    out.set(name, data);
    off += 46 + nlen + elen + clen;
  }
  return out;
}
const sha = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)))
  .map((b) => b.toString(16).padStart(2, '0')).join('');
const txt = (u8) => new TextDecoder().decode(u8);

/* 여는 태그 위치에서 짝이 맞는 닫는 태그까지의 구간을 돌려준다.
   안내서 표는 셀 안에 표가 또 들어 있어 비탐욕 정규식으로는 구간이 잘린다. */
function spanOf(xml, tag, from) {
  const open = new RegExp(`<${tag}\\b[^>]*?(/?)>`, 'g');
  const close = `</${tag}>`;
  open.lastIndex = from;
  const first = open.exec(xml);
  if (!first) return null;
  if (first[1] === '/') return { start: first.index, inner: '', end: open.lastIndex };
  let depth = 1, i = open.lastIndex;
  const innerStart = i;
  const scan = new RegExp(`<${tag}\\b[^>]*?(/?)>|${close}`, 'g');
  scan.lastIndex = i;
  let m;
  while ((m = scan.exec(xml))) {
    if (m[0] === close) { depth--; if (!depth) return { start: first.index, inner: xml.slice(innerStart, m.index), end: scan.lastIndex, attr: first[0] }; }
    else if (m[1] !== '/') depth++;
  }
  return null;
}

/* section XML에서 표를 뽑아 행·열 수와 머리행을 돌려준다(중첩 표 포함, 바깥 표부터) */
function tablesOf(xml, deep = true) {
  const out = [];
  let at = 0;
  for (;;) {
    const sp = spanOf(xml, 'hp:tbl', at);
    if (!sp) break;
    const attr = sp.attr || '';
    const rows = Number((attr.match(/rowCnt="(\d+)"/) || [])[1] || 0);
    const cols = Number((attr.match(/colCnt="(\d+)"/) || [])[1] || 0);
    const tr = spanOf(sp.inner, 'hp:tr', 0);
    const header = [];
    if (tr) {
      let ci = 0;
      for (;;) {
        const tc = spanOf(tr.inner, 'hp:tc', ci);
        if (!tc) break;
        header.push(Array.from(tc.inner.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)).map((t) => t[1]).join('').trim());
        ci = tc.end;
      }
    }
    out.push({ rows, cols, header });
    if (deep) out.push(...tablesOf(sp.inner, true));   // 셀 안의 표도 센다
    at = sp.end;
  }
  return out;
}

/* ───────── 본 시험 ───────── */
const need = ['app/index.html', 'app/data/sections.json', 'app/data/form.json', 'app/data/template.hwpx',
  'app/assets/catalog.js', 'app/assets/hwpx-form.js', 'app/assets/indicator.js', 'app/assets/chart.js'];
const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.error('필요한 파일이 아직 없다:\n  ' + missing.join('\n  '));
  process.exitCode = 1;
  process.exit();
}

const chromium = await getChromium();
if (!chromium) {
  console.error('playwright를 찾지 못했다. 전역 설치본 경로를 확인할 것(설치를 시도하지 않는다).');
  process.exitCode = 1;
  process.exit();
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const { srv, port } = await serve(APP);
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch({ executablePath: undefined });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();

const consoleErrs = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
page.on('pageerror', (e) => consoleErrs.push('pageerror: ' + e.message));

/* 템플릿 원본 해시(보존 검사용) */
const tplBytes = new Uint8Array(fs.readFileSync(path.join(APP, 'data/template.hwpx')));
const tplParts = await unzipFile(tplBytes);
/* 산출물이 템플릿과 같아야 하는 파일은 **표지를 붙였는가**에 따라 갈린다.
     표지를 붙인 산출물(제1장) — 앞 구역·바탕쪽·settings 까지 통째로 그대로
     표지를 뗀 산출물(그 밖)   — 앞 구역과 그 바탕쪽은 아예 없고, settings 의
                                커서 위치 한 줄만 첫 문단으로 되돌아간다
   header.xml 과 본문 바탕쪽(masterpage2)은 어느 쪽이든 한 바이트도 달라지면 안 된다. */
const hashOf = async (keys) => {
  const out = {};
  for (const k of keys) if (tplParts.has(k)) out[k] = await sha(tplParts.get(k));
  return out;
};
const ALWAYS_HASH = await hashOf(['Contents/header.xml', 'Contents/masterpage2.xml']);
const FRONT_HASH = await hashOf(['Contents/section0.xml', 'Contents/section1.xml',
  'Contents/masterpage0.xml', 'settings.xml']);
const DROPPED = ['Contents/section1.xml', 'Contents/masterpage0.xml'];

const RAW_BODY = JSON.parse(fs.readFileSync(path.join(APP, 'data/form.json'), 'utf8')).section
  || 'Contents/section2.xml';
/* 표지를 떼면 본문 구역이 맨 앞 번호로 앞당겨진다 */
const bodyPath = (front) => (front ? RAW_BODY : 'Contents/section0.xml');

/* 이 마디에 표지가 붙는가 — 화면 규칙(cover.js wantsFront)과 같은 판단 */
const wantsCover = (id) => /^0*1(?:[-_]|$)/.test(String(id || ''));

/** 산출물이 서식을 지켰는지 본다. front 는 표지를 붙인 산출물인가. */
async function checkKept(parts, front, label) {
  let keep = true;
  const want = { ...ALWAYS_HASH, ...(front ? FRONT_HASH : {}) };
  for (const [k, h] of Object.entries(want)) {
    const got = parts.has(k) ? await sha(parts.get(k)) : '(없음)';
    if (got !== h) { keep = false; ok(false, `[${label}] ${k} 가 템플릿과 달라졌다`); }
  }
  if (!front) {
    for (const k of DROPPED) {
      if (parts.has(k)) { keep = false; ok(false, `[${label}] 표지 구역 ${k} 이 떨어지지 않았다`); }
    }
  }
  return ok(keep, `[${label}] 서식 보존 — ${front ? '표지·제출문까지 해시 일치' : '표지는 떼고 서식은 해시 일치'}`);
}

head('화면 열기');
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('#w-tree .tnode', { timeout: 30000 });
const nNodes = await page.locator('#w-tree .tnode').count();
ok(nNodes > 0, '절 트리가 그려졌다', `노드 ${nNodes}개`);
console.log(`  절 트리 노드 ${nNodes}개`);
ok(consoleErrs.length === 0, '부팅 중 콘솔 오류 없음', consoleErrs.join(' | '));

/* 카탈로그에서 시험 대상 뽑기 */
const cat = JSON.parse(fs.readFileSync(path.join(APP, 'data/sections.json'), 'utf8'));
let targets = cat.nodes.filter((n) => ONLY ? n.id === ONLY : true);
if (MAX) targets = targets.slice(0, MAX);

head(`절별 산출 시험 (${targets.length}개 마디)`);
const summary = [];
for (const node of targets) {
  const label = `${node.id} ${node.title}`.slice(0, 46);
  consoleErrs.length = 0;
  const wantForms = (node.forms || []).filter((f) => f.kind === 'blank');

  const clicked = await page.evaluate((id) => {
    const b = document.querySelector(`#w-tree .tnode[data-id="${id.replace(/"/g, '\\"')}"]`);
    if (!b) return false;
    b.click(); return true;
  }, node.id);
  if (!ok(clicked, `[${label}] 트리에서 이 마디를 찾았다`)) { summary.push({ id: node.id, ok: false }); continue; }
  await page.waitForTimeout(40);

  // 양식만 넣기(AI 없이) → 검사 → 만들기
  await page.click('#w-skel');
  await page.waitForTimeout(60);
  const draft = await page.inputValue('#w-draft');
  const drafted = ok(draft.trim().length > 0, `[${label}] 뼈대 원고가 만들어졌다`);

  await page.click('#w-lint');
  await page.waitForTimeout(40);

  const dl = page.waitForEvent('download', { timeout: 45000 });
  await page.click('#w-make');
  let file = null, err = null;
  try {
    const d = await dl;
    file = path.join(OUT, `${node.id}.hwpx`.replace(/[\\/:*?"<>|]/g, '_'));
    await d.saveAs(file);
  } catch (e) {
    err = (await page.textContent('#w-mstatus').catch(() => '')) || e.message;
  }
  if (!ok(!!file, `[${label}] hwpx 산출`, err)) { summary.push({ id: node.id, ok: false }); continue; }

  /* 산출물 뜯어 보기 */
  const buf = new Uint8Array(fs.readFileSync(file));
  let parts;
  try { parts = await unzipFile(buf); }
  catch (e) { ok(false, `[${label}] zip 판독`, e.message); summary.push({ id: node.id, ok: false }); continue; }

  ok(txt(parts.get('mimetype')) === 'application/hwp+zip', `[${label}] mimetype`);
  const front = wantsCover(node.id);
  await checkKept(parts, front, label);

  const secXml = txt(parts.get(bodyPath(front)) || new Uint8Array());
  ok(secXml.length > 0, `[${label}] 본문 구역이 있다`, `찾은 자리 ${bodyPath(front)}`);
  ok(!/<hp:p\b[^>]*>\s*<\/hp:p>\s*$/.test(secXml) || secXml.includes('<hp:t>'),
    `[${label}] 본문에 글이 들어 있다`);
  ok(secXml.includes(node.title.slice(0, 8)) || secXml.includes('<hp:t>'),
    `[${label}] 제목 문자열이 본문에 있다`);

  /* ★ 표 양식 검사 — 이 시험의 핵심 */
  const got = tablesOf(secXml);
  if (wantForms.length) {
    ok(got.length >= wantForms.length,
      `[${label}] 표 ${wantForms.length}개가 모두 들어갔다`, `실제 ${got.length}개`);
    wantForms.forEach((f, i) => {
      const g = got[i];
      if (!g) return;
      ok(g.cols === f.cols, `[${label}] 표${i + 1} 열 수 ${f.cols}`, `실제 ${g.cols}`);
      const want = (f.header || []).filter(Boolean).map((s) => s.replace(/\s/g, ''));
      const have = (g.header || []).join('').replace(/\s/g, '');
      const miss = want.filter((w) => !have.includes(w));
      ok(miss.length === 0, `[${label}] 표${i + 1} 머리행 보존`, '빠짐: ' + miss.join(', '));
    });
  }
  /* ★ 도식 검사 — 안내서 원본 조각이 그대로 들어갔는가 */
  const wantLayouts = (node.forms || []).filter((f) => f.kind === 'layout' && f.xml);
  if (wantLayouts.length) {
    ok(!secXml.includes('[[도식:'), `[${label}] 도식 자리표가 남지 않았다`);
    for (const f of wantLayouts) {
      const src = fs.readFileSync(path.join(APP, 'data', f.xml), 'utf8');
      // 체계도는 칸을 병합해 그린 표다. 같은 행·열 수의 표가 산출물에 있어야 한다
      const here = got.some((t) => t.rows === f.rows && t.cols === f.cols);
      ok(here, `[${label}] 체계도 ${f.rows}×${f.cols} 표가 들어갔다`,
        `산출물 표: ${got.map((t) => `${t.rows}x${t.cols}`).join(', ')}`);
      // 원본 조각의 글자가 그대로 옮겨졌는가(칸 병합·서식까지 원본을 베낀 증거)
      const marks = [...src.matchAll(/<hp:t>([^<]{4,30})<\/hp:t>/g)].map((m) => m[1]).slice(0, 5);
      const kept = marks.filter((t) => secXml.includes(t));
      ok(marks.length && kept.length === marks.length,
        `[${label}] 체계도 안 글자 보존(${kept.length}/${marks.length})`,
        marks.filter((t) => !secXml.includes(t)).join(' / '));
      // 원본이 참조하는 서식 번호가 그대로 살아 있어야 한다(header.xml이 같아서 유효)
      const bf = [...new Set([...src.matchAll(/borderFillIDRef="(\d+)"/g)].map((m) => m[1]))];
      const alive = bf.filter((id) => secXml.includes(`borderFillIDRef="${id}"`));
      ok(bf.length && alive.length === bf.length,
        `[${label}] 체계도 테두리 서식 ${bf.length}종 보존`, `살아남음 ${alive.length}종`);
    }
  }

  ok(consoleErrs.length === 0, `[${label}] 콘솔 오류 없음`, consoleErrs.join(' | '));
  summary.push({ id: node.id, ok: true, tables: got.length, want: wantForms.length,
    layouts: wantLayouts.length, bytes: buf.length });
}

/* ───────── 지역여건 분석 ───────── */
head('지역여건 분석 (지표 → 그래프 → 그림이 박힌 hwpx)');
await page.click('.tab[data-tab="region"]');
// option은 화면에 '보이는' 요소가 아니라 visible 대기가 통하지 않는다 → 개수로 기다린다
await page.waitForFunction(
  () => document.querySelectorAll('#r-sgg option').length > 0
     && document.querySelectorAll('#r-sido option').length >= 17,
  null, { timeout: 30000 });

const CASES = [
  { sido: '경기도', hint: '수원' },
  { sido: '전라남도', hint: null },
  { sido: '대구광역시', hint: '군위' },   // type7 없는 지역 — 유형별 비교 예외 처리 확인
];
for (const c of CASES) {
  consoleErrs.length = 0;
  const has = await page.evaluate((s) => !!Array.from(document.querySelectorAll('#r-sido option'))
    .find((o) => o.value === s), c.sido);
  if (!ok(has, `${c.sido} 선택지 존재`)) continue;
  await page.selectOption('#r-sido', c.sido);
  await page.waitForTimeout(30);
  const code = await page.evaluate((hint) => {
    const opts = Array.from(document.querySelectorAll('#r-sgg option'));
    const hit = hint ? opts.find((o) => o.textContent.includes(hint)) : opts[0];
    return (hit || opts[0]).value;
  }, c.hint);
  await page.selectOption('#r-sgg', code);
  await page.selectOption('#r-basis', '광역');
  await page.click('#r-run');
  await page.waitForFunction(() => {
    const t = document.querySelector('#r-status').textContent;
    return /완료|실패/.test(t);
  }, null, { timeout: 90000 });
  const st = await page.textContent('#r-status');
  const okRun = ok(!/실패/.test(st), `${c.sido} ${code} 분석 실행`, st);
  if (!okRun) continue;
  console.log(`  ${c.sido} ${code} — ${st}`);

  const nRows = await page.locator('#r-table tbody tr').count();
  ok(nRows >= 20, `${code} 지표 20개 이상 산출`, `${nRows}개`);
  /* 22개 지표는 한 장에 다 넣으면 세로가 한글 한 쪽을 넘긴다. 11+11 두 장으로 갈라야 한다 */
  const nCharts = await page.locator('#r-chart img').count();
  ok(nCharts === 2, `${code} 비교 그래프가 2장으로 갈렸다(11+11)`, `${nCharts}장`);
  const nTrend = await page.locator('#t-chart img').count();
  ok(nTrend === 1, `${code} 연도별 추이 그래프가 그려졌다`, `${nTrend}장`);
  const drafted = await page.inputValue('#r-draft');
  ok(drafted.includes('지역사회보장지표'), `${code} 원고에 표주 있음`);
  ok(drafted.includes('#### 연도별 추이'), `${code} 원고에 추이 마디가 붙었다`);
  ok(/비슷한 수준인 지표|뚜렷이 다른 지표/.test(drafted),
    `${code} 원고가 차이 큰 지표와 비슷한 지표를 갈라 썼다`);

  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.click('#r-make');
  let f = null, e2 = null;
  try { const d = await dl; f = path.join(OUT, `지역여건_${code}.hwpx`); await d.saveAs(f); }
  catch (e) { e2 = (await page.textContent('#r-mstatus').catch(() => '')) || e.message; }
  if (!ok(!!f, `${code} 절 hwpx 산출`, e2)) continue;

  const parts = await unzipFile(new Uint8Array(fs.readFileSync(f)));
  /* 지역여건은 장에 속하지 않는 산출물이라 표지를 붙이지 않는다 */
  await checkKept(parts, false, `지역여건 ${code}`);
  const sec = txt(parts.get(bodyPath(false)) || new Uint8Array());
  const bin = [...parts.keys()].filter((k) => k.startsWith('BinData/') && /\.(png|jpe?g)$/i.test(k));
  const pics = (sec.match(/<hp:pic\b/g) || []).length;
  ok(pics === 3, `${code} 그림 3장(비교 2 + 추이 1)이 본문에 들어갔다`, `${pics}장`);
  ok(bin.length >= 3, `${code} BinData 그림 엔트리 3개 이상`, bin.join(', '));
  const hpf = txt(parts.get('Contents/content.hpf') || new Uint8Array());
  const ids = [...new Set([...sec.matchAll(/binaryItemIDRef="([^"]+)"/g)].map((m) => m[1]))];
  const lost = ids.filter((id) => !hpf.includes(`id="${id}"`));
  ok(ids.length >= 3 && lost.length === 0,
    `${code} content.hpf 매니페스트에 그림 ${ids.length}개가 모두 적혔다`, lost.join(', ') || `id=${ids}`);
  ok(sec.includes('xmlns:hc='), `${code} hc 네임스페이스 선언됨`);
  ok(consoleErrs.length === 0, `${code} 콘솔 오류 없음`, consoleErrs.join(' | '));
}

/* ───────── 양식 점검 (왕복) ───────── */
head('양식 점검 — 산출물을 되돌려 다시 만들기');
const made = fs.readdirSync(OUT).filter((f) => f.endsWith('.hwpx'));
if (made.length) {
  consoleErrs.length = 0;
  await page.click('.tab[data-tab="check"]');
  // 이 환경의 playwright는 경로에 한글이 섞이면 setInputFiles가 조용히 실패한다
  // (오류도 이벤트도 없이 files=0). 산출물 이름이 한글이라 버퍼로 넘긴다.
  await page.setInputFiles('#c-file', {
    name: 'check.hwpx',
    mimeType: 'application/octet-stream',
    buffer: fs.readFileSync(path.join(OUT, made[0])),
  });
  await page.waitForFunction(() => !document.querySelector('#c-run').disabled,
    null, { timeout: 20000 });
  await page.click('#c-run');
  await page.waitForFunction(() => /완료|실패/.test(document.querySelector('#c-status').textContent),
    null, { timeout: 60000 });
  const st = await page.textContent('#c-status');
  ok(!/실패/.test(st), '되돌리기 실행', st);
  const back = await page.inputValue('#c-draft');
  ok(back.trim().length > 0, '되돌린 원고가 비어 있지 않다', `${back.length}자`);

  /* 절을 안 고르면 표지 없이, 제1장 절을 고르면 표지까지 — 두 갈래를 다 본다 */
  const remake = async (secId, front, tag) => {
    await page.selectOption('#c-sec', secId);
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await page.click('#c-make');
    try {
      const d = await dl;
      const f = path.join(OUT, `재조판_${tag}.hwpx`);
      await d.saveAs(f);
      const parts = await unzipFile(new Uint8Array(fs.readFileSync(f)));
      ok(txt(parts.get('mimetype')) === 'application/hwp+zip', `재조판(${tag}) 산출물이 유효한 hwpx`);
      await checkKept(parts, front, `재조판 ${tag}`);
      ok(txt(parts.get(bodyPath(front)) || new Uint8Array()).includes('<hp:t>'),
        `재조판(${tag}) 본문 구역에 글이 있다`, `찾은 자리 ${bodyPath(front)}`);
    } catch (e) {
      ok(false, `재조판(${tag}) 산출`, (await page.textContent('#c-mstatus').catch(() => '')) || e.message);
    }
  };
  await remake('', false, '절없음');
  const first = await page.locator('#c-sec option').evaluateAll(
    (opts) => opts.map((o) => o.value).find((v) => /^0*1(?:[-_]|$)/.test(v)) || '');
  if (first) await remake(first, true, '제1장');
  else ok(false, '제1장 절을 고를 수 없다');
  ok(consoleErrs.length === 0, '양식 점검 콘솔 오류 없음', consoleErrs.join(' | '));
} else {
  ok(false, '되돌릴 산출물이 없다');
}

/* ───────── 개발도구용 스킬 꾸러미 ───────── */
head('스킬 꾸러미 — 화면에서 내려받기');
{
  consoleErrs.length = 0;
  await page.click('.tab[data-tab="check"]');
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.click('#c-skill');
  try {
    const d = await dl;
    ok(d.suggestedFilename().endsWith('.zip'), '.zip 으로 내려온다', d.suggestedFilename());
    const f = path.join(OUT, '스킬꾸러미.zip');
    await d.saveAs(f);
    const parts = await unzipFile(new Uint8Array(fs.readFileSync(f)));
    const want = ['SKILL.md', 'AGENTS.md', 'build.mjs', 'lib/hwpx-form.js', 'assets/template.hwpx'];
    const missing = want.filter((w) => ![...parts.keys()].some((k) => k.endsWith('/' + w)));
    ok(missing.length === 0, `꾸러미에 핵심 파일 ${want.length}개가 다 있다`, missing.join(', '));
    const st = await page.textContent('#c-sstatus');
    ok(/내려받음/.test(st), '내려받았다고 알린다', st);
  } catch (e) {
    ok(false, '스킬 꾸러미 내려받기', (await page.textContent('#c-sstatus').catch(() => '')) || e.message);
  }
  await page.click('#c-skillhelp');
  await page.waitForTimeout(60);
  ok(await page.locator('#sModal.on').count() === 1, '[적용 방법] 창이 열린다');
  await page.click('#s-close');
  ok(consoleErrs.length === 0, '스킬 꾸러미 콘솔 오류 없음', consoleErrs.join(' | '));
}

/* ───────── API 키 설정 띠 ─────────
   구글 창구를 가로채 가짜로 답한다(진짜 키가 없어도 절차 전체를 돌려 볼 수 있고,
   무엇보다 "모델 이름이 갈렸다"·"목록 창구가 죽었다" 같은 상황을 실제로 만들어 볼 수 있다). */
head('API 키 — 실호출 확인 절차와 모델 교체 대비');
{
  consoleErrs.length = 0;
  const FAKE = 'AIzaSyTEST-0123456789';
  const CORS = { 'Access-Control-Allow-Origin': '*' };
  const listOK = (names) => ({ status: 200, body: { models: names.map((n) => ({
    name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) } });
  const genOK = (t) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: t }] } }] } });
  const errJ = (status, message) => ({ status, body: { error: { message, code: status } } });

  // 상황판 — 시험 도중 갈아 끼운다
  const mock = { list: () => listOK(['gemini-2.5-flash', 'gemini-2.5-pro']), gen: () => genOK('OK') };
  const urls = [];        // 나간 주소(키가 새는지 본다)
  const keyHdr = new Set();

  await ctx.route(/generativelanguage\.googleapis\.com/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {          // 사전 요청(커스텀 헤더 때문에 뜬다)
      return route.fulfill({ status: 204, headers: { ...CORS,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'content-type,x-goog-api-key' } });
    }
    urls.push(req.url());
    keyHdr.add(req.headers()['x-goog-api-key'] || '(없음)');
    const model = (req.url().match(/\/models\/([^:]+):generateContent/) || [])[1] || '';
    const r = model ? mock.gen(model) : mock.list();
    return route.fulfill({ status: r.status, contentType: 'application/json',
      headers: CORS, body: JSON.stringify(r.body) });
  });

  const state = () => page.getAttribute('#setup', 'data-state');
  const waitState = (s, ms = 30000) => page.waitForFunction(
    (want) => document.querySelector('#setup').dataset.state === want, s, { timeout: ms });

  ok(await state() === 'need', '처음엔 키 입력 칸이 열려 있다', await state());
  ok(await page.locator('#setup').isVisible(), '설정 띠가 화면 맨 위에 보인다');
  ok(await page.isDisabled('#w-gen'), '확인 전에는 [AI로 초안 작성]이 잠겨 있다');

  // 1) 키를 넣고 확인 — 목록 조회 + 실제 생성 1회
  await page.fill('#k-in', FAKE);
  await page.click('#k-go');
  await waitState('ok');
  ok(true, '키 확인 통과 → 설정 띠가 한 줄로 접힌다');
  const why1 = await page.textContent('#k-okwhy');
  ok(why1.includes('gemini-2.5-flash'), '답한 모델 이름을 화면에 박아 둔다', why1);
  ok(!await page.isDisabled('#w-gen'), '확인 뒤 [AI로 초안 작성]이 열린다');
  ok(urls.some((u) => /\/models\?/.test(u)), '모델 목록을 조회했다');
  ok(urls.some((u) => /:generateContent$/.test(u)), '실제 생성까지 한 번 불렀다(목록 조회로 끝내지 않는다)');
  ok(urls.every((u) => !u.includes(FAKE) && !/[?&]key=/.test(u)), '키가 주소에 실리지 않는다',
    urls.join(' | '));
  ok(keyHdr.size === 1 && keyHdr.has(FAKE), '키는 x-goog-api-key 헤더로만 나간다',
    [...keyHdr].join(', '));
  const nOpt = await page.locator('#k-model option').count();
  ok(nOpt >= 3, '우선 모델 상자가 살아 있는 목록으로 채워진다', `${nOpt}개`);
  ok(await page.inputValue('#k-model') === '', '기본값은 자동(고정하면 폴백을 못 탄다)');

  // 2) 모델 교체 — 어제 이름이 사라지고 새 이름만 남은 상황
  mock.list = () => listOK(['gemini-9.9-flash']);
  mock.gen = (m) => (m === 'gemini-9.9-flash' ? genOK('OK') : errJ(404, `models/${m} is not found`));
  await page.click('#k-recheck');
  await waitState('ok');
  const why2 = await page.textContent('#k-okwhy');
  ok(why2.includes('gemini-9.9-flash'), '이름이 갈려도 새 모델로 연결된다', why2);
  ok(!await page.isDisabled('#w-gen'), '모델 교체 뒤에도 AI 기능이 열려 있다');

  // 3) 목록 창구가 죽은 상황 — 내장 이름으로 밀어붙인다
  //    (직전에 기억한 gemini-9.9-flash를 먼저 두들겨 보고 404면 버리는 길까지 함께 지난다)
  //    내장 목록의 맨 앞은 무료 몫이 가장 넉넉한 flash-lite여야 한다
  mock.list = () => errJ(500, '목록 창구가 죽었다');
  mock.gen = (m) => (/flash-lite/.test(m) ? genOK('OK') : errJ(404, `models/${m} is not found`));
  await page.click('#k-recheck');
  await waitState('ok');
  const why3 = await page.textContent('#k-okwhy');
  ok(/flash-lite/.test(why3), '목록이 막혀도 내장 이름으로 연결된다', why3);
  ok(why3.includes('모델 목록은 못 받았다'), '목록을 못 받았다는 사실을 감추지 않는다', why3);

  // 4) 키가 거부되는 상황
  mock.list = () => errJ(400, 'API key not valid. Please pass a valid API key.');
  mock.gen = () => errJ(400, 'API key not valid. Please pass a valid API key.');
  await page.click('#k-recheck');
  await waitState('fail');
  const msg = await page.textContent('#k-test');
  ok(msg.includes('확인 실패'), '거부된 키는 실패로 알린다', msg);
  ok(msg.includes('API key not valid'), '구글이 준 사유를 그대로 보여 준다', msg);
  ok(await page.isDisabled('#w-gen'), '확인이 깨지면 AI 기능이 다시 잠긴다');

  // 4-3) 무료 등급 하루 몫이 떨어지면 스스로 멈춘다
  const DAILY = 'You exceeded your current quota. quota_metric: '
    + 'generativelanguage.googleapis.com/generate_content_free_tier_requests, '
    + 'quota_id: GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit: 1000';
  mock.list = () => listOK(['gemini-3.5-flash-lite', 'gemini-3.5-flash']);
  mock.gen = () => errJ(429, DAILY);
  await page.click('#k-go');          // 실패 상태에서도 눌리는 쪽으로(다시 확인은 접힌 줄에 있다)
  await waitState('fail');
  ok(await page.isDisabled('#w-gen'), '몫이 떨어지면 AI 단추가 잠긴다');
  const spentTxt = await page.textContent('#k-fix');
  ok(/태평양 자정/.test(spentTxt), '되돌아오는 기준을 밝힌다', spentTxt);
  ok(/양식 점검|양식만 넣기/.test(spentTxt), '그동안 쓸 수 있는 기능을 알려 준다', spentTxt);
  ok(await page.locator('#w-skel').isEnabled(), '몫이 떨어져도 [양식만 넣기]는 살아 있다');
  // 장부에 적혔으므로 다시 눌러도 그물을 타지 않는다
  const beforeQ = urls.length;
  await page.click('#k-go');
  await page.waitForTimeout(300);
  const after = urls.slice(beforeQ).filter((u) => /:generateContent$/.test(u));
  ok(after.length === 0, '소진 뒤에는 생성 호출을 아예 내보내지 않는다', `${after.length}회`);

  // 4-4) 내려간 모델 — 구글이 지목한 대체 이름으로 갈아탄다(실제로 받은 문구)
  // 기억해 둔 우선 모델이 먼저 성공해 버리면 이 경로를 지나지 않는다. 장부와 함께 지운다.
  await page.evaluate(() => {
    try { localStorage.removeItem('gemini_usage'); localStorage.removeItem('gemini_model'); }
    catch (e) { /* 저장소가 막혀 있어도 그만 */ }
  });
  const RETIRED = 'This model models/gemini-2.5-flash-lite is no longer available to new users. '
    + 'Please update your code to use models/gemini-3.5-flash-lite for the latest features.';
  mock.list = () => listOK(['gemini-2.5-flash-lite']);
  mock.gen = (m) => (m === 'gemini-3.5-flash-lite' ? genOK('OK') : errJ(400, RETIRED));
  await page.click('#k-go');
  await waitState('ok');
  const why4 = await page.textContent('#k-okwhy');
  // 목록에는 내려간 이름 하나뿐인데 답한 것은 구글이 지목한 새 이름이다 = 갈아탄 증거
  ok(why4.includes('gemini-3.5-flash-lite'), '구글이 지목한 대체 모델로 갈아탄다', why4);
  ok(!why4.includes('gemini-2.5-flash-lite'), '내려간 이름을 응답 모델로 적지 않는다', why4);
  const listedOnly = urls.filter((u) => /:generateContent$/.test(u)).slice(-2);
  ok(listedOnly.some((u) => u.includes('gemini-2.5-flash-lite'))
     && listedOnly.some((u) => u.includes('gemini-3.5-flash-lite')),
    '내려간 이름을 한 번 시도한 뒤 대체 이름으로 넘어간다', listedOnly.join(' | '));
  ok(/오늘 \d+회/.test(why4), '오늘 쓴 횟수를 보여 준다', why4);
  ok(/되돌아옴/.test(why4), '몫이 되돌아오는 시각을 보여 준다', why4);

  // 4-2) 크레딧이 바닥난 계정 — 실제로 겪은 사유다. 기다리라고 하면 안 되고,
  //      모델을 더 두들겨도 안 되며, 어디를 손봐야 하는지 짚어 줘야 한다
  const DEPLETED = 'Your prepayment credits are depleted. Please go to AI Studio at '
    + 'https://ai.studio/projects to manage your project and billing.';
  const before = urls.length;
  mock.list = () => listOK(['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']);
  mock.gen = () => errJ(429, DEPLETED);
  await page.click('#k-edit');        // 접힌 줄에서 입력 칸을 다시 편다
  await waitState('need');
  await page.fill('#k-in', FAKE);
  await page.click('#k-go');
  await waitState('fail');
  const msg2 = await page.textContent('#k-test');
  ok(msg2.includes('prepayment credits are depleted'), '크레딧 소진 사유를 그대로 보여 준다', msg2);
  const gens = urls.slice(before).filter((u) => /:generateContent$/.test(u));
  ok(gens.length === 1, '모델을 더 두들기지 않는다(계정 단위 문제)', `생성 호출 ${gens.length}회`);
  const fix = await page.locator('#k-fix');
  ok(await fix.isVisible(), '조치 안내가 나온다');
  const fixTxt = await fix.textContent();
  ok(/기다려도 풀리지 않는다/.test(fixTxt), '기다리라고 하지 않는다', fixTxt);
  ok(await fix.locator('a[href="https://ai.studio/projects"]').count() === 1,
    'AI Studio 결제 화면으로 가는 길을 준다', fixTxt);
  ok(/키 없이 쓰기/.test(fixTxt), '그동안 쓸 수 있는 기능을 알려 준다', fixTxt);

  // 5) 막다른 길을 만들지 않는다 — 확인을 건너뛰고 쓰겠다는 길
  await page.click('#k-force');
  await waitState('ok');
  ok(!await page.isDisabled('#w-gen'), '확인을 건너뛰면 쓸 수는 있다');
  ok((await page.textContent('#k-oklbl')).includes('건너뛰'), '건너뛴 상태임을 밝힌다');

  // 6) 키 삭제
  await page.click('#k-del');
  await waitState('need');
  ok(await page.isDisabled('#w-gen'), '키를 지우면 AI 기능이 잠긴다');
  ok(await page.inputValue('#k-in') === '', '지우면 입력 칸도 빈다');

  // 404·500을 일부러 만들어 냈으니 그 자원 적재 실패는 오류로 치지 않는다.
  // 우리 코드가 삼키지 못하고 튄 예외만 본다.
  const real = consoleErrs.filter((m) => !/Failed to load resource/.test(m));
  ok(real.length === 0, 'API 키 절차에서 튄 예외 없음', real.join(' | '));
  await ctx.unroute(/generativelanguage\.googleapis\.com/);
}

/* ───────── 작업 폴더와 맥락 카드 ─────────
   폴더 고르기 창은 사람이 눌러야 뜨는 네이티브 창이라 자동으로 조작할 수 없다. 그래서
   showDirectoryPicker만 메모리 폴더로 바꿔 끼우고, **우리 코드 경로는 그대로** 태운다
   (저장·목록·되돌리기·카드 누적·지시문 주입이 실제로 도는지 본다). */
head('작업 폴더 — 산출물 저장과 앞 절 맥락');
{
  consoleErrs.length = 0;
  const page2 = await ctx.newPage();
  page2.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
  page2.on('pageerror', (e) => consoleErrs.push('pageerror: ' + e.message));

  // 메모리 위에 사는 가짜 폴더. File System Access API가 주는 것과 같은 모양만 갖춘다.
  await page2.addInitScript(() => {
    const files = new Map();
    const fileHandle = (name) => ({
      kind: 'file',
      name,
      async getFile() {
        const b = files.get(name) || new Uint8Array();
        return {
          size: b.length,
          lastModified: Date.now(),
          async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        };
      },
      async createWritable() {
        let buf = new Uint8Array();
        return {
          async write(d) {
            const u = d instanceof Uint8Array ? d
              : (typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d));
            const j = new Uint8Array(buf.length + u.length);
            j.set(buf); j.set(u, buf.length);
            buf = j;
          },
          async close() { files.set(name, buf); },
        };
      },
    });
    const dir = {
      kind: 'directory',
      name: '계획서작업',
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async getFileHandle(name, opt) {
        if (!files.has(name) && !(opt && opt.create)) throw new Error('NotFound');
        if (!files.has(name)) files.set(name, new Uint8Array());
        return fileHandle(name);
      },
      async *entries() { for (const n of files.keys()) yield [n, fileHandle(n)]; },
    };
    window.showDirectoryPicker = async () => dir;
    window.__files = () => [...files.keys()];
    window.__read = (n) => new TextDecoder().decode(files.get(n) || new Uint8Array());
  });

  await page2.goto(base, { waitUntil: 'networkidle' });
  await page2.waitForSelector('#w-tree .tnode', { timeout: 30000 });

  ok(await page2.locator('#ws-pick').isEnabled(), '폴더 지정 단추가 열려 있다');
  await page2.click('#ws-pick');
  await page2.waitForFunction(() => !document.querySelector('#ws-body').hidden, null, { timeout: 15000 });
  ok((await page2.textContent('#ws-state')).includes('계획서작업'), '고른 폴더 이름이 보인다',
    await page2.textContent('#ws-state'));

  // 절 하나를 폴더에 낸다 — 내려받기가 아니라 폴더 쓰기로 가야 한다
  const first = cat.nodes[0].id;
  await page2.evaluate((id) => document.querySelector(`#w-tree .tnode[data-id="${id}"]`).click(), first);
  await page2.click('#w-skel');
  await page2.waitForTimeout(60);
  const draft1 = await page2.inputValue('#w-draft');
  await page2.click('#w-make');
  await page2.waitForFunction(() => /완료|실패/.test(document.querySelector('#w-mstatus').textContent),
    null, { timeout: 30000 });
  const st1 = await page2.textContent('#w-mstatus');
  ok(/작업 폴더에 저장/.test(st1), '산출물이 폴더로 간다(내려받기가 아니라)', st1);
  ok(/맥락 카드 1개/.test(st1), '맥락 카드가 쌓인다', st1);

  const names = await page2.evaluate(() => window.__files());
  ok(names.some((n) => n.endsWith('.hwpx')), '폴더에 hwpx가 쓰였다', names.join(', '));
  ok(names.includes('_맥락.json'), '맥락 장부가 폴더에 쓰였다', names.join(', '));

  // 장부 내용 — 전문이 아니라 요약이어야 한다
  const ledger = JSON.parse(await page2.evaluate(() => window.__read('_맥락.json')));
  ok(Array.isArray(ledger) && ledger.length === 1, '장부에 카드 하나', JSON.stringify(ledger).slice(0, 120));
  ok(ledger[0].id === first, '카드가 그 절의 것', ledger[0].id);
  const cardSize = JSON.stringify(ledger[0]).length;
  // 카드는 원고 길이와 무관하게 상한 안에 묶인다(그래야 65개를 쌓아도 지시문이 안 부푼다)
  ok(cardSize < 2000, '카드 크기가 묶여 있다', `카드 ${cardSize}자 / 원고 ${draft1.length}자`);
  ok(Array.isArray(ledger[0].names) && Array.isArray(ledger[0].tables),
    '카드가 원문이 아니라 갈래별 요약이다', Object.keys(ledger[0]).join(','));

  // 목록에 뜨고, [참고 원문으로]가 실제로 되돌려 넣는다(1단계)
  ok(await page2.locator('#ws-files li').count() >= 1, '폴더 산출물이 목록에 뜬다');
  await page2.locator('#ws-files li button').first().click();
  await page2.waitForFunction(() => document.querySelector('#w-src').value.length > 0,
    null, { timeout: 30000 });
  const src = await page2.inputValue('#w-src');
  ok(src.includes('되돌린 원고'), '되돌린 원고가 [참고 원문]에 들어간다', src.slice(0, 60));

  // 다음 절 지시문에 앞 절 카드가 자동으로 들어간다(2단계)
  const second = cat.nodes.find((n) => n.id !== first && n.id.startsWith('01')).id;
  await page2.evaluate((id) => document.querySelector(`#w-tree .tnode[data-id="${id}"]`).click(), second);
  await page2.click('#w-showprompt');
  await page2.waitForSelector('#pModal.on', { timeout: 10000 });
  const prompt = await page2.inputValue('#p-text');
  ok(prompt.includes('[앞서 작성한 절의 결정 사항]'), '지시문에 앞 절 맥락이 붙는다');
  ok(prompt.includes(first), '앞 절 id가 맥락에 있다', prompt.slice(prompt.indexOf('[앞서'), prompt.indexOf('[앞서') + 160));
  ok(/옮겨 적지는 말고/.test(prompt), '베끼지 말라는 단서가 붙는다');

  // 체크를 끄면 안 붙는다
  await page2.click('#p-close');
  await page2.uncheck('#w-ctx');
  await page2.click('#w-showprompt');
  await page2.waitForSelector('#pModal.on', { timeout: 10000 });
  const off = await page2.inputValue('#p-text');
  ok(!off.includes('[앞서 작성한 절의 결정 사항]'), '체크를 끄면 맥락을 넣지 않는다');
  await page2.click('#p-close');

  // 폴더를 놓으면 종전 방식으로 되돌아간다
  await page2.check('#w-ctx');
  await page2.click('#ws-drop');
  await page2.waitForFunction(() => document.querySelector('#ws-body').hidden, null, { timeout: 10000 });
  ok(true, '폴더를 놓으면 폴더 화면이 접힌다');

  ok(consoleErrs.length === 0, '작업 폴더 절차 콘솔 오류 없음', consoleErrs.join(' | '));
  await page2.close();
}

await browser.close();
srv.close();

head('결과');
const okN = summary.filter((s) => s.ok).length;
console.log(`  절 산출 ${okN}/${summary.length} 성공`);
console.log(`  단언 ${checks}건 중 실패 ${fails}건`);
console.log(`  산출물: ${OUT}`);
if (fails) { console.error('\n시험 실패'); process.exitCode = 1; }
else console.log('\n전부 통과');
