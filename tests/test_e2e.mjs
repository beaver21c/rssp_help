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
const tplHash = {};
for (const k of ['Contents/header.xml', 'Contents/section0.xml', 'Contents/section1.xml',
  'Contents/masterpage0.xml', 'Contents/masterpage2.xml', 'settings.xml']) {
  if (tplParts.has(k)) tplHash[k] = await sha(tplParts.get(k));
}
const BODY = JSON.parse(fs.readFileSync(path.join(APP, 'data/form.json'), 'utf8')).section
  || 'Contents/section2.xml';

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
  let keep = true;
  for (const [k, h] of Object.entries(tplHash)) {
    const got = parts.has(k) ? await sha(parts.get(k)) : '(없음)';
    if (got !== h) { keep = false; ok(false, `[${label}] ${k} 가 템플릿과 달라졌다`); }
  }
  ok(keep, `[${label}] 서식·표지·제출문 보존(해시 일치)`);

  const secXml = txt(parts.get(BODY) || new Uint8Array());
  ok(secXml.length > 0, `[${label}] 본문 구역이 있다`);
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
  ok(await page.locator('#r-chart img').count() === 1, `${code} 그래프 그려짐`);
  const drafted = await page.inputValue('#r-draft');
  ok(drafted.includes('지역사회보장지표'), `${code} 원고에 표주 있음`);

  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.click('#r-make');
  let f = null, e2 = null;
  try { const d = await dl; f = path.join(OUT, `지역여건_${code}.hwpx`); await d.saveAs(f); }
  catch (e) { e2 = (await page.textContent('#r-mstatus').catch(() => '')) || e.message; }
  if (!ok(!!f, `${code} 절 hwpx 산출`, e2)) continue;

  const parts = await unzipFile(new Uint8Array(fs.readFileSync(f)));
  const sec = txt(parts.get(BODY) || new Uint8Array());
  const bin = [...parts.keys()].filter((k) => k.startsWith('BinData/') && /\.(png|jpe?g)$/i.test(k));
  ok(sec.includes('<hp:pic'), `${code} 그림(hp:pic)이 본문에 들어갔다`);
  ok(bin.length >= 1, `${code} BinData 그림 엔트리 존재`, bin.join(', '));
  const hpf = txt(parts.get('Contents/content.hpf') || new Uint8Array());
  const idm = (sec.match(/binaryItemIDRef="([^"]+)"/) || [])[1];
  ok(!!idm && hpf.includes(`id="${idm}"`), `${code} content.hpf 매니페스트에 그림 항목 있음`, `id=${idm}`);
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

  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.click('#c-make');
  try {
    const d = await dl;
    const f = path.join(OUT, '재조판.hwpx');
    await d.saveAs(f);
    const parts = await unzipFile(new Uint8Array(fs.readFileSync(f)));
    ok(txt(parts.get('mimetype')) === 'application/hwp+zip', '재조판 산출물이 유효한 hwpx');
    for (const [k, h] of Object.entries(tplHash)) {
      ok(parts.has(k) && (await sha(parts.get(k))) === h, `재조판 후에도 ${k} 보존`);
    }
  } catch (e) {
    ok(false, '재조판 산출', (await page.textContent('#c-mstatus').catch(() => '')) || e.message);
  }
  ok(consoleErrs.length === 0, '양식 점검 콘솔 오류 없음', consoleErrs.join(' | '));
} else {
  ok(false, '되돌릴 산출물이 없다');
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
