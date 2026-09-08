/**
 * app/assets/attach.js 시험 — 첨부파일 텍스트·표 추출.
 *
 * 시험용 파일은 여기서 직접 만들어 tests/fixtures/에 떨군다(엑셀 실물 하나만 빌려 쓴다).
 * 프레임워크 없이 돈다. 실패하면 사유를 찍고 process.exitCode = 1.
 *   node tests/test_attach.mjs
 */
"use strict";

import { mkdirSync, writeFileSync, readFileSync, existsSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zip } from '../app/assets/zip.js';
import { extractAttachment, SUPPORTED, MAX_BYTES } from '../app/assets/attach.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = join(HERE, 'fixtures');
const REAL_XLSX = '/home/user/kihasa-indicator-new/source/지역사회보장지표.xlsx';

mkdirSync(FIX, { recursive: true });

let failed = 0;
let passed = 0;
function check(name, ok, why) {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${name}${why ? ` — ${why}` : ''}`);
}
async function throws(name, fn, needle) {
  try {
    await fn();
    check(name, false, '오류가 안 났다');
  } catch (e) {
    check(name, needle ? e.message.includes(needle) : true, `사유가 다르다: ${e.message}`);
  }
}

const enc = (text) => new TextEncoder().encode(text);
/** 파일로 남기고 File 객체로 돌려준다. 브라우저가 넘기는 것과 같은 모양이다. */
function fixture(name, content) {
  const bytes = typeof content === 'string' ? enc(content) : content;
  writeFileSync(join(FIX, name), bytes);
  return new File([bytes], name);
}
const widths = (table) => [...new Set(table.map((r) => r.length))];

// ──────────────────────────────────────────────────────────────
// 시험용 파일 만들기
// ──────────────────────────────────────────────────────────────
const CSV = '﻿이름,내용,수\n'
  + '가나,"쉼표, 안에 있음",1\n'
  + '"여러\n줄",\'홑따옴표\',2\n'
  + '따옴표,"큰따옴표 ""안"" 이스케이프",3\n'
  + '짧은행,,\n';

const TSV = '가\t나\t다\n1\t2\t3\n4\t5\t6\n';
const SCSV = '가;나;다\n1;2;3\n4;5;6\n';

const HTML = `<!doctype html><html><head><title>제목</title>
<style>body{color:red}</style><script>var x = 1 < 2;</script></head>
<body><!-- 주석 --><h1>지역사회보장계획</h1>
<p>첫째 줄&nbsp;본문&amp;붙임</p><noscript>스크립트 꺼짐</noscript>
<table><tr><th>구분</th><th colspan="2">2026년</th></tr>
<tr><td>예산</td><td>100</td><td>200</td></tr></table>
<ul><li>항목 하나</li><li>항목 둘</li></ul></body></html>`;

/** 최소 OOXML 엑셀. 시트 차례는 workbook.xml + rels로만 정해진다. */
async function makeXlsx() {
  const files = new Map();
  files.set('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org'
    + '/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  // 차례를 일부러 뒤집는다. sheet2.xml이 첫째 시트다.
  files.set('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook><sheets>'
    + '<sheet name="앞시트" sheetId="7" r:id="rId9"/>'
    + '<sheet name="뒷시트" sheetId="3" r:id="rId4"/>'
    + '</sheets></workbook>');
  files.set('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships>'
    + '<Relationship Id="rId4" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId9" Target="/xl/worksheets/sheet2.xml"/>'
    + '</Relationships>');
  files.set('xl/sharedStrings.xml',
    '<?xml version="1.0" encoding="UTF-8"?><sst count="3" uniqueCount="3">'
    + '<si><t>구분</t></si>'
    + '<si><r><t>합계</t></r><r><t>(원)</t></r><rPh sb="0" eb="2"><t>버릴것</t></rPh></si>'
    + '<si><t>가 &amp; 나</t></si></sst>');
  // 앞시트: A·B·D만 있고 C가 비었다. 빈 칸을 채워야 열이 안 어긋난다.
  files.set('xl/worksheets/sheet2.xml',
    '<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>'
    + '<c r="D1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>내리막</t></is></c>'
    + '<c r="B2"><v>12.5</v></c><c r="C2"><f>B2*2</f><v>25</v></c>'
    + '<c r="D2" t="b"><v>1</v></c></row>'
    + '<row r="3"><c r="A3" t="inlineStr"><is><t>끝줄</t></is></c></row>'
    + '<row r="4"/>'
    + '</sheetData></worksheet>');
  // 뒷시트: 두 자리 열(AA)까지 간다.
  files.set('xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>왼쪽</t></is></c>'
    + '<c r="AA1" t="inlineStr"><is><t>스물일곱째</t></is></c></row>'
    + '</sheetData></worksheet>');
  return zip(files, []);
}

/** 최소 OOXML 파워포인트. 슬라이드 차례는 파일 이름 번호로 정한다. */
async function makePptx() {
  const slide = (body) => `<?xml version="1.0" encoding="UTF-8"?>`
    + `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
  const files = new Map();
  files.set('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  files.set('ppt/slides/slide1.xml', slide(
    '<p:sp><p:txBody>'
    + '<a:p><a:r><a:t>한 문단을</a:t></a:r><a:r><a:t> 이어 붙인다</a:t></a:r></a:p>'
    + '<a:p><a:r><a:t>둘째 문단</a:t></a:r></a:p>'
    + '</p:txBody></p:sp>'));
  // 10번 슬라이드가 2번보다 뒤로 가야 한다(문자열 정렬이면 어긋난다).
  files.set('ppt/slides/slide10.xml', slide(
    '<p:sp><p:txBody><a:p><a:r><a:t>마지막장</a:t></a:r></a:p></p:txBody></p:sp>'));
  files.set('ppt/slides/slide2.xml', slide(
    '<p:graphicFrame><a:graphic><a:graphicData><a:tbl>'
    + '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>구분</a:t></a:r></a:p></a:txBody></a:tc>'
    + '<a:tc><a:txBody><a:p><a:r><a:t>값</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
    + '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>예산</a:t></a:r></a:p>'
    + '<a:p><a:r><a:t>둘째 줄</a:t></a:r></a:p></a:txBody></a:tc>'
    + '<a:tc><a:txBody><a:p><a:r><a:t>100</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
    + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'));
  return zip(files, []);
}

/** 최소 hwpx. readback.js가 읽을 수 있는 만큼만 넣는다. */
async function makeHwpx() {
  const cell = (text) => `<hp:tc><hp:subList><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0">`
    + `<hp:t>${text}</hp:t></hp:run></hp:p></hp:subList></hp:tc>`;
  const files = new Map();
  files.set('mimetype', 'application/hwp+zip');
  files.set('Contents/header.xml',
    '<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="h" xmlns:hc="c">'
    + '<hh:charPr id="0" height="1000"/><hh:charPr id="1" height="1600"><hh:bold/></hh:charPr>'
    + '<hh:paraPr id="0"><hh:margin><hc:left value="0"/></hh:margin></hh:paraPr>'
    + '</hh:head>');
  files.set('Contents/section0.xml',
    '<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="s" xmlns:hp="p">'
    + '<hp:p paraPrIDRef="0"><hp:run charPrIDRef="1"><hp:t>1. 지역 개관</hp:t></hp:run></hp:p>'
    + '<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>□ 인구가 줄고 있다</hp:t></hp:run></hp:p>'
    + '<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:tbl>'
    + `<hp:tr>${cell('연도')}${cell('인구')}</hp:tr>`
    + `<hp:tr>${cell('2024')}${cell('12,345')}</hp:tr>`
    + '</hp:tbl></hp:run></hp:p>'
    + '</hs:sec>');
  return zip(files);
}

// 1×1 PNG(진짜 PNG 바이트다. 그대로 되돌아와야 한다).
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'));
const PDF = enc('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

// ──────────────────────────────────────────────────────────────
// 브라우저 갈래(DOMParser·btoa) — Chromium이 있을 때만 돈다
// ──────────────────────────────────────────────────────────────
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.csv': 'text/csv' };

function serveRepo() {
  const server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel);
    if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end(); return; }
    const dot = path.lastIndexOf('.');
    res.writeHead(200, { 'Content-Type': MIME[path.slice(dot)] || 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

function findChromium() {
  const require_ = createRequire(import.meta.url);
  for (const candidate of ['playwright', '/opt/node22/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright']) {
    try { return require_(candidate).chromium; } catch { /* 다음 후보 */ }
  }
  return null;
}

/** 진짜 브라우저에서 DOMParser 갈래와 btoa 갈래를 돌려 본다. */
async function inBrowser() {
  const chromium = findChromium();
  if (!chromium) { console.log('· Chromium이 없어 브라우저 갈래는 건너뛴다'); return; }
  const server = await serveRepo();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/tests/fixtures/sample.html`);
    const out = await page.evaluate(async (root) => {
      const mod = await import(`${root}/app/assets/attach.js`);
      const grab = async (path, name) => {
        const bytes = new Uint8Array(await (await fetch(path)).arrayBuffer());
        return mod.extractAttachment(new File([bytes], name));
      };
      return {
        dom: typeof DOMParser !== 'undefined',
        html: await grab(`${root}/tests/fixtures/sample.html`, 'sample.html'),
        xlsx: await grab(`${root}/tests/fixtures/mini.xlsx`, 'mini.xlsx'),
        hwpx: await grab(`${root}/tests/fixtures/mini.hwpx`, 'mini.hwpx'),
        png: await grab(`${root}/tests/fixtures/dot.png`, 'dot.png'),
      };
    }, base);

    check('브라우저에 DOMParser 있음', out.dom, '없다');
    const h = out.html;
    check('브라우저 html script 제거', !h.text.includes('var x'), '스크립트가 남았다');
    check('브라우저 html style 제거', !h.text.includes('color:red'), '스타일이 남았다');
    check('브라우저 html noscript 제거', !h.text.includes('스크립트 꺼짐'), 'noscript가 남았다');
    check('브라우저 html 본문', h.text.includes('지역사회보장계획')
      && h.text.includes('첫째 줄 본문&붙임'), JSON.stringify(h.text));
    check('브라우저 html 블록 줄바꿈', h.text.includes('항목 하나\n항목 둘'), '목록이 붙었다');
    check('브라우저 html 표', h.tables.length === 1 && h.tables[0][0].length === 3,
      JSON.stringify(h.tables));
    check('브라우저 html colspan 자리 벌림',
      h.tables[0][0][1] === '2026년' && h.tables[0][0][2] === '', JSON.stringify(h.tables[0][0]));
    check('브라우저 html 표는 본문에서 뺌', !h.text.includes('예산'), '표가 본문에 남았다');
    check('브라우저 xlsx', out.xlsx.tables.length === 2 && out.xlsx.tables[0][1][2] === '25',
      JSON.stringify(out.xlsx.tables[0]));
    check('브라우저 hwpx', out.hwpx.tables.length === 1 && out.hwpx.text.includes('지역 개관'),
      JSON.stringify(out.hwpx.text));
    const back = Uint8Array.from(Buffer.from(out.png.inline.data, 'base64'));
    check('브라우저 btoa 왕복', back.length === PNG.length && back.every((b, i) => b === PNG[i]),
      `${back.length}바이트`);
  } finally {
    await browser.close();
    server.close();
  }
}

// ──────────────────────────────────────────────────────────────
// 시험
// ──────────────────────────────────────────────────────────────
async function main() {
  // ── 확장자별 mode
  const csvFile = fixture('sample.csv', CSV);
  const txtFile = fixture('sample.txt', '﻿첫 줄\r\n둘째 줄\n');
  const mdFile = fixture('sample.md', '# 제목\n\n- 하나\n');
  const htmlFile = fixture('sample.html', HTML);
  const xlsxFile = fixture('mini.xlsx', await makeXlsx());
  const pptxFile = fixture('mini.pptx', await makePptx());
  const hwpxFile = fixture('mini.hwpx', await makeHwpx());
  const pngFile = fixture('dot.png', PNG);
  const jpgFile = fixture('dot.jpg', PNG);          // 바이트 왕복만 본다
  const pdfFile = fixture('mini.pdf', PDF);

  const want = [
    [csvFile, 'text'], [txtFile, 'text'], [mdFile, 'text'], [htmlFile, 'text'],
    [xlsxFile, 'text'], [pptxFile, 'text'], [hwpxFile, 'text'],
    [pngFile, 'inline'], [jpgFile, 'inline'], [pdfFile, 'inline'],
  ];
  const got = new Map();
  for (const [file, mode] of want) {
    const a = await extractAttachment(file);
    got.set(file.name, a);
    check(`mode ${file.name}`, a.mode === mode, `${a.mode}로 나왔다`);
    check(`bytes ${file.name}`, a.bytes === file.size, `${a.bytes} ≠ ${file.size}`);
    check(`note ${file.name}`, typeof a.note === 'string' && a.note.length > 0, '설명이 비었다');
    check(`tables 꼴 ${file.name}`, Array.isArray(a.tables), '표가 배열이 아니다');
  }
  check('SUPPORTED 목록', SUPPORTED.includes('xlsm') && SUPPORTED.includes('htm'),
    'CONTRACTS의 목록과 다르다');

  // ── 거부
  await throws('지원 안 하는 확장자', () => extractAttachment(new File([enc('x')], 'a.exe')),
    '지원하지 않는');
  await throws('확장자 없음', () => extractAttachment(new File([enc('x')], 'README')),
    '지원하지 않는');
  // 20MB 넘는 파일은 디스크에 남기지 않는다(쓸데없이 크다).
  const huge = new File([new Uint8Array(MAX_BYTES + 1024)], 'huge.txt');
  await throws('20MB 초과 거부', () => extractAttachment(huge), '20.0MB까지만');
  await throws('빈 파일 거부', () => extractAttachment(new File([], 'empty.txt')), '빈 파일');

  // ── csv
  const csv = got.get('sample.csv');
  const rows = csv.tables[0];
  check('csv 표 하나', csv.tables.length === 1, `${csv.tables.length}개가 나왔다`);
  check('csv 행 수', rows.length === 5, `${rows.length}행`);
  check('csv 열 수 균일', widths(rows).length === 1 && rows[0].length === 3,
    `열 수 ${JSON.stringify(widths(rows))}`);
  check('csv BOM 제거', rows[0][0] === '이름', `머리 칸이 ${JSON.stringify(rows[0][0])}`);
  check('csv 따옴표 안 쉼표', rows[1][1] === '쉼표, 안에 있음', JSON.stringify(rows[1][1]));
  check('csv 따옴표 안 개행', rows[2][0] === '여러\n줄', JSON.stringify(rows[2][0]));
  check('csv 이스케이프', rows[3][1] === '큰따옴표 "안" 이스케이프', JSON.stringify(rows[3][1]));
  check('csv 짧은 행 채움', rows[4].length === 3 && rows[4][2] === '', JSON.stringify(rows[4]));

  const tsv = await extractAttachment(fixture('tab.csv', TSV));
  check('csv 탭 자동추정', tsv.tables[0][0].length === 3, JSON.stringify(tsv.tables[0][0]));
  const scsv = await extractAttachment(fixture('semi.csv', SCSV));
  check('csv 세미콜론 자동추정', scsv.tables[0][0].length === 3, JSON.stringify(scsv.tables[0][0]));

  // ── txt/md
  check('txt BOM·개행 정리', got.get('sample.txt').text === '첫 줄\n둘째 줄',
    JSON.stringify(got.get('sample.txt').text));
  check('md 그대로', got.get('sample.md').text.startsWith('# 제목'), '머리글이 없다');

  // ── base64 왕복
  for (const [name, mime, src] of [['dot.png', 'image/png', PNG], ['mini.pdf', 'application/pdf', PDF]]) {
    const a = got.get(name);
    check(`inline mime ${name}`, a.inline && a.inline.mimeType === mime,
      JSON.stringify(a.inline && a.inline.mimeType));
    const back = Uint8Array.from(Buffer.from(a.inline.data, 'base64'));
    const same = back.length === src.length && back.every((b, i) => b === src[i]);
    check(`base64 왕복 ${name}`, same, `${back.length}바이트로 되돌아왔다`);
    check(`base64 접두어 없음 ${name}`, !a.inline.data.startsWith('data:'), 'data: 접두어가 붙었다');
    check(`inline은 파싱 안 함 ${name}`, a.text === '' && a.tables.length === 0, '내용을 뜯었다');
  }
  check('jpg mime', got.get('dot.jpg').inline.mimeType === 'image/jpeg',
    got.get('dot.jpg').inline.mimeType);

  // ── 합성 xlsx
  const x = got.get('mini.xlsx');
  check('xlsx 시트 둘', x.tables.length === 2, `${x.tables.length}개`);
  const front = x.tables[0];
  check('xlsx 시트 차례(rels 대응)', front[0][0] === '구분' && front.length === 3,
    `첫 표가 ${JSON.stringify(front[0])}`);
  check('xlsx 시트 이름', x.text.includes('앞시트') && x.text.includes('뒷시트'),
    `요약이 ${JSON.stringify(x.text)}`);
  check('xlsx 열 수 균일', widths(front).length === 1 && front[0].length === 4,
    `열 수 ${JSON.stringify(widths(front))}`);
  check('xlsx 빈 칸 채움(C1)', front[0][2] === '' && front[0][3] === '가 & 나',
    JSON.stringify(front[0]));
  check('xlsx 공유문자열 이스케이프', front[0][3] === '가 & 나', JSON.stringify(front[0][3]));
  check('xlsx 여러 런 이어 붙임', front[0][1] === '합계(원)', JSON.stringify(front[0][1]));
  check('xlsx rPh 버림', !x.text.includes('버릴것') && !front[0][1].includes('버릴것'), 'rPh가 섞였다');
  check('xlsx inlineStr', front[1][0] === '내리막', JSON.stringify(front[1][0]));
  check('xlsx 숫자', front[1][1] === '12.5', JSON.stringify(front[1][1]));
  check('xlsx 수식 결과', front[1][2] === '25', JSON.stringify(front[1][2]));
  check('xlsx 참/거짓', front[1][3] === 'TRUE', JSON.stringify(front[1][3]));
  check('xlsx 빈 행 버림', front[2][0] === '끝줄' && front[2][3] === '', JSON.stringify(front[2]));
  check('xlsx 두 자리 열(AA)', x.tables[1][0].length === 27 && x.tables[1][0][26] === '스물일곱째',
    `${x.tables[1][0].length}열`);

  // ── 실물 xlsx
  if (existsSync(REAL_XLSX)) {
    const raw = readFileSync(REAL_XLSX);
    const real = await extractAttachment(new File([raw], '지역사회보장지표.xlsx'));
    check('실물 xlsx 시트 하나 이상', real.tables.length >= 1, `${real.tables.length}개`);
    const first = real.tables[0];
    check('실물 xlsx 첫 시트 10행 이상', first.length >= 10, `${first.length}행`);
    let ragged = 0;
    real.tables.forEach((table, i) => { if (widths(table).length !== 1) ragged = i + 1; });
    check('실물 xlsx 모든 표의 열 수 균일', ragged === 0, `${ragged}번째 표가 어긋난다`);
    check('실물 xlsx 첫 시트 이름', real.text.includes('지표개요'), '요약에 시트 이름이 없다');
    check('실물 xlsx 값이 들어옴', first.flat().some((c) => c.includes('돌봄')), '공유문자열이 비었다');
  } else {
    check('실물 xlsx', false, `${REAL_XLSX}가 없다`);
  }

  // ── pptx
  const p = got.get('mini.pptx');
  check('pptx 슬라이드 차례', /슬라이드 1[\s\S]*슬라이드 2[\s\S]*슬라이드 3/.test(p.text),
    '10번이 2번보다 앞에 왔다');
  check('pptx 마지막 슬라이드', p.text.trim().endsWith('마지막장'), JSON.stringify(p.text.slice(-40)));
  check('pptx 같은 문단 런 결합', p.text.includes('한 문단을 이어 붙인다'), '런이 갈라졌다');
  check('pptx 문단 사이 줄바꿈', p.text.includes('한 문단을 이어 붙인다\n둘째 문단'), '줄바꿈이 없다');
  check('pptx 표 하나', p.tables.length === 1, `${p.tables.length}개`);
  check('pptx 표 모양', p.tables[0].length === 2 && widths(p.tables[0])[0] === 2,
    JSON.stringify(p.tables[0]));
  check('pptx 셀 안 여러 문단', p.tables[0][1][0] === '예산<br>둘째 줄', JSON.stringify(p.tables[0][1][0]));

  // ── html
  const h = got.get('sample.html');
  check('html script 제거', !h.text.includes('var x'), '스크립트가 남았다');
  check('html style 제거', !h.text.includes('color:red'), '스타일이 남았다');
  check('html noscript 제거', !h.text.includes('스크립트 꺼짐'), 'noscript가 남았다');
  check('html 주석 제거', !h.text.includes('주석'), '주석이 남았다');
  check('html 본문', h.text.includes('지역사회보장계획') && h.text.includes('첫째 줄 본문&붙임'),
    JSON.stringify(h.text));
  check('html 블록 줄바꿈', h.text.includes('항목 하나\n항목 둘'), '목록이 한 줄로 붙었다');
  check('html 표 하나', h.tables.length === 1, `${h.tables.length}개`);
  check('html 표 열 수 균일', widths(h.tables[0]).length === 1 && h.tables[0][0].length === 3,
    JSON.stringify(h.tables[0]));
  check('html colspan 자리 벌림', h.tables[0][0][1] === '2026년' && h.tables[0][0][2] === '',
    JSON.stringify(h.tables[0][0]));
  check('html 표는 본문에서 뺌', !h.text.includes('예산'), '표가 본문에도 남았다');

  // ── hwpx
  const w = got.get('mini.hwpx');
  check('hwpx 문단', w.text.includes('지역 개관') && w.text.includes('인구가 줄고 있다'),
    JSON.stringify(w.text));
  check('hwpx 표', w.tables.length === 1 && w.tables[0].length === 2, `${w.tables.length}개`);
  check('hwpx 표 내용', w.tables[0][1][1] === '12,345', JSON.stringify(w.tables[0]));
  await throws('한글 바이너리 거부',
    () => extractAttachment(new File([Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0])], 'old.hwpx')),
    '한글 바이너리');

  await inBrowser();

  console.log(`통과 ${passed}건, 실패 ${failed}건`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('시험이 뻗었다:', e); process.exitCode = 1; });
