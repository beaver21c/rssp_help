/**
 * 양식 보존 빌더 대조 시험 — `app/assets/hwpx-form.js` ↔ `build_form.py`.
 *
 * 돌리는 법: node tests/test_form_parity.mjs
 * 시험 틀을 쓰지 않는다. 어긋나면 사유를 찍고 process.exitCode = 1로 끝낸다.
 *
 * 보는 것
 *  1. JS와 파이썬이 만든 본문 구역 XML이 글자까지 같은가
 *  2. 자동 번호가 걸린 양식에서도 같은가
 *  3. 본문 구역 말고 템플릿의 모든 파일이 SHA-256 그대로인가
 *  4. 그림을 넣었을 때 hp:pic·BinData·content.hpf가 제대로 붙는가
 *     (파이썬 빌더에는 그림이 없어 engine.py가 만든 hp:pic과 맞대어 본다)
 *  5. 빌드 → 되돌리기 왕복에서 본문·표·각주가 살아남는가
 *  6. 깨진 입력(cols 합 0·제어문자·자리표 위조·겹친 빌드·깨진 zip)을 짚는가
 *
 * 자산은 `PARITY_KIT`가 가리키는 꾸러미를 먼저 보고, 없으면 저장소의
 * `app/data/template.hwpx`와 설치된 `hwpx_studio`로 그 자리에서 만든다.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { buildForm, parseInput, lintParsed, detectImageSize } from '../app/assets/hwpx-form.js';
import { readBack } from '../app/assets/readback.js';
import { crc32, unzip } from '../app/assets/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'form-parity-'));

/** 24비트 PNG 한 장. 그림 검사에 쓸 원본을 그 자리에서 만든다. */
function makePng(w, h) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(new Uint8Array(body)));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;            // 비트 깊이
  ihdr[9] = 2;            // 트루컬러
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const at = y * (1 + w * 3) + 1 + x * 3;
      raw[at] = (x * 7) & 0xff;
      raw[at + 1] = (y * 11) & 0xff;
      raw[at + 2] = 0x40;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 대조에 쓸 자산을 찾는다.
 *
 * 손으로 뽑아 둔 꾸러미가 있으면 그것을 쓰고, 없으면(CI가 그렇다) 저장소가
 * 들고 있는 `app/data/template.hwpx`와 설치된 `hwpx_studio`로 그 자리에서
 * 꾸러미를 만든다. 시험이 이 세션 임시폴더에 매여 있으면 CI에서 돌지 않는다.
 */
function resolveKit() {
  const kit = process.env.PARITY_KIT || '';
  if (kit && existsSync(path.join(kit, 'build_form.py'))) {
    return {
      where: kit,
      builder: path.join(kit, 'build_form.py'),
      template: path.join(kit, 'template.hwpx'),
      form: path.join(kit, 'form.json'),
    };
  }
  const builder = execFileSync('python3', ['-c',
    'import pathlib, hwpx_studio;'
    + 'print(pathlib.Path(hwpx_studio.__file__).parent / "assets" / "build_form.py")'],
  { encoding: 'utf8' }).trim();
  if (!existsSync(builder)) throw new Error(`파이썬 빌더를 찾지 못했다: ${builder}`);
  const template = path.join(ROOT, 'app/data/template.hwpx');
  const form = path.join(work, 'kit.form.json');
  // 양식 카드도 같은 템플릿에서 뽑는다. 두 빌더가 같은 카드를 봐야 대조가 된다
  execFileSync('python3', ['-c',
    'import json, sys;'
    + 'from hwpx_studio.formkit import analyze;'
    + 'json.dump(analyze(sys.argv[1]).form, open(sys.argv[2], "w", encoding="utf-8"),'
    + ' ensure_ascii=False, indent=2)', template, form], { encoding: 'utf8' });
  return { where: '저장소 자산 + 설치된 hwpx_studio', builder, template, form };
}

const KIT = resolveKit();
const BUILDER = KIT.builder;
const TEMPLATE = KIT.template;
const IMAGE = path.join(work, 'core22.png');
writeFileSync(IMAGE, existsSync(path.join(path.dirname(BUILDER), 'core22.png'))
  ? readFileSync(path.join(path.dirname(BUILDER), 'core22.png'))
  : makePng(1564, 1757));

const failures = [];
const fail = (why) => failures.push(why);
const ok = (label) => console.log(`  통과 — ${label}`);
//: 이 자리에서 새로 생긴 실패만 센다. 앞 단계 실패가 뒤 단계 보고를 먹으면 안 된다
const mark = () => failures.length;
const clean = (from) => failures.length === from;

const decoder = new TextDecoder();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ──────────────────────────────────────────────────────────────
// 시험 원고 — 안내서에서 실제로 쓰는 모양(장/절/항/목 + 개조식 + 표 + 표주 + 각주)
// ──────────────────────────────────────────────────────────────
const MANUSCRIPT = `[장: 지역사회보장 여건 분석]

# 지역사회보장 여건 분석

## 인구·사회적 여건

### 인구 구조의 변화

#### 총인구와 고령화 추이

□ 최근 5년간 시군구 총인구는 완만하게 감소하는 흐름을 보였다[^1]

○ 고령인구 비율은 전국 시군구 평균을 웃도는 수준으로 올라섰다

- 65세 이상 인구가 전체의 24.3%로 초고령사회 기준을 넘어섰다

▪ 노인 1인가구 비중도 같은 기간 함께 늘었다

행정 자료는 주민등록 기준이므로 실거주 인구와는 차이가 있다.

{cols=40,30,30}

| 구분 | 2020년 | 2024년 |
|---|---|---|
| 총인구(명) | 412,300 | 401,880 |
| 고령인구 비율(%) | 18.6 | 24.3 |
| 노인 1인가구(가구) | 9,140<br>(추계) | 12,675 |
※ 자료：통계청, 「주민등록인구현황」, 각 연도.

□ 돌봄 영역의 사회보장 수요가 특히 빠르게 커졌다[^2]

○ 재가돌봄 대기자는 2년 사이 두 배로 늘었다

▪ 시설 중심 공급으로는 대기를 줄이기 어렵다

### 보장기관의 대응 여건

□ 전담 인력과 예산은 수요 증가 속도를 따라가지 못했다

| 항목 | 2022년 | 2024년 |
|---|---|---|
| 전담 인력(명) | 42 | 45 |
| 사업 예산(억원) | 318 | 371 |
※ 자료：내부 행정자료.

[^1]: 통계청, 「장래인구추계: 2022~2052년」, 2024.
[^2]: 보건복지부, 「지역사회보장 수요조사 결과」, 2024.
`;

const IMAGE_MANUSCRIPT = `# 지역사회보장 여건 분석

## 지표 비교 결과

□ 우리 지역의 주요 지표를 비교집단과 견주면 다음과 같다

![](core22.png)

○ 분포의 가운데보다 아래쪽에 놓인 지표가 많다
`;

// ──────────────────────────────────────────────────────────────
// 잡일
// ──────────────────────────────────────────────────────────────
/** 난수로 정해지는 값만 지운다. 표 id·각주 instid는 양쪽이 같아야 하므로 남긴다. */
function normalizeRandom(xml) {
  return xml
    .replace(/(<hp:pic )id="\d+"/g, '$1id="PIC_ID"')
    .replace(/(<hp:pic [^>]*?)instid="\d+"/g, '$1instid="PIC_INSTID"')
    .replace(/binaryItemIDRef="[^"]*"/g, 'binaryItemIDRef="BIN"');
}

function firstDiff(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) {
      return `${i}번째 글자부터 어긋난다\n    JS : …${a.slice(Math.max(0, i - 40), i + 60)}\n`
        + `    PY : …${b.slice(Math.max(0, i - 40), i + 60)}`;
    }
  }
  return `길이가 다르다: JS ${a.length} / PY ${b.length}`;
}

function runPython(formPath, sourcePath, outPath) {
  return execFileSync('python3', [BUILDER, sourcePath, '-o', outPath,
    '--form', formPath, '--template', TEMPLATE], { encoding: 'utf8' });
}

async function sectionOf(bytes, name) {
  const entries = await unzip(bytes);
  const found = entries.get(name);
  if (!found) throw new Error(`산출물에 ${name}이 없다`);
  return decoder.decode(found);
}

// ──────────────────────────────────────────────────────────────
// 1·2. 파이썬과 글자까지 같은가
// ──────────────────────────────────────────────────────────────
const baseForm = JSON.parse(readFileSync(KIT.form, 'utf8'));
const templateBytes = new Uint8Array(readFileSync(TEMPLATE));

/** 자동 번호를 걸어 둔 변형. Numbering 이식이 맞는지 보려면 이게 있어야 한다. */
const numberedForm = JSON.parse(JSON.stringify(baseForm));
for (const level of numberedForm.levels) {
  if (level.key === 'h2') level.numbering = 'AUTO_ROMAN';
  if (level.key === 'h3') level.numbering = 'AUTO_NUM';
  if (level.key === 'h4') level.numbering = 'AUTO_HANGUL';
  if (level.key === 'circle') { level.numbering = 'AUTO_CIRCLED'; }
}

const cases = [
  ['기본 양식', baseForm, MANUSCRIPT],
  ['자동 번호 양식', numberedForm, MANUSCRIPT],
];

console.log(`대조 자산: ${KIT.where} — 본문 구역 ${baseForm.section}`);
console.log('── 1층 파이썬 대조 ' + '─'.repeat(28));
const built = new Map();
for (const [label, form, text] of cases) {
  const slug = label.replace(/\s+/g, '_');
  const formPath = path.join(work, `${slug}.form.json`);
  const srcPath = path.join(work, `${slug}.md`);
  const outPath = path.join(work, `${slug}.py.hwpx`);
  writeFileSync(formPath, JSON.stringify(form, null, 2), 'utf8');
  writeFileSync(srcPath, text, 'utf8');

  let jsBytes;
  try {
    const result = await buildForm(templateBytes, form, text, {});
    jsBytes = result.bytes;
    built.set(label, result);
  } catch (err) {
    fail(`${label}: JS 빌드가 터졌다 — ${err.message}`);
    continue;
  }

  try {
    runPython(formPath, srcPath, outPath);
  } catch (err) {
    fail(`${label}: 파이썬 빌더가 터졌다 — ${err.message}`);
    continue;
  }

  const jsSection = await sectionOf(jsBytes, form.section);
  const pySection = await sectionOf(new Uint8Array(readFileSync(outPath)), form.section);
  const a = normalizeRandom(jsSection);
  const b = normalizeRandom(pySection);
  const where = form.section.replace(/^Contents\//, '');
  if (a !== b) fail(`${label}: ${where}이 파이썬과 다르다 — ${firstDiff(a, b)}`);
  else ok(`${label} — ${where} ${a.length}글자가 파이썬과 완전 일치`);
}

// ──────────────────────────────────────────────────────────────
// 3. 손대면 안 되는 파일
// ──────────────────────────────────────────────────────────────
console.log('── 2층 보존 검사 ' + '─'.repeat(30));
const templateEntries = await unzip(templateBytes);
// 본문 구역·매니페스트·미리보기 말고는 한 바이트도 달라지면 안 된다.
// 목록을 손으로 적어 두면 양식이 바뀔 때 검사가 조용히 헐거워진다
const TOUCHABLE = new Set([baseForm.section, 'Contents/content.hpf', 'Preview/PrvText.txt']);
const KEEP = [...templateEntries.keys()].filter((n) => !TOUCHABLE.has(n));
const baseResult = built.get('기본 양식');
if (!baseResult) {
  fail('보존 검사: 기본 양식 산출물이 없어 건너뛴다');
} else {
  const from = mark();
  const outEntries = await unzip(baseResult.bytes);
  for (const name of KEEP) {
    const before = templateEntries.get(name);
    const after = outEntries.get(name);
    if (!before || !after) { fail(`보존 검사: ${name}이 한쪽에 없다`); continue; }
    if (sha256(before) !== sha256(after)) fail(`보존 검사: ${name}이 바뀌었다`);
  }
  if (clean(from)) ok(`본문 구역 말고 ${KEEP.length}개 파일이 SHA-256 그대로`);
}

// ──────────────────────────────────────────────────────────────
// 4. 그림
// ──────────────────────────────────────────────────────────────
console.log('── 3층 그림 검사 ' + '─'.repeat(30));
const imageBytes = new Uint8Array(readFileSync(IMAGE));
const [pxW, pxH] = detectImageSize(imageBytes, '.png');
if (!(pxW > 0 && pxH > 0)) fail(`그림 검사: PNG 크기를 못 읽었다 (${pxW}×${pxH})`);

let picResult = null;
try {
  picResult = await buildForm(templateBytes, baseForm, IMAGE_MANUSCRIPT,
    { images: new Map([['core22.png', imageBytes]]) });
} catch (err) {
  fail(`그림 검사: JS 빌드가 터졌다 — ${err.message}`);
}

if (picResult) {
  const entries = await unzip(picResult.bytes);
  const section = decoder.decode(entries.get(baseForm.section));
  const pics = [...section.matchAll(/<hp:pic [\s\S]*?<\/hp:pic>/g)].map((m) => m[0]);
  if (pics.length !== 1) fail(`그림 검사: hp:pic이 ${pics.length}개다 (1개여야 한다)`);

  if (pics.length === 1) {
    const ref = /binaryItemIDRef="([^"]*)"/.exec(pics[0]);
    const id = ref ? ref[1] : '';
    if (!id) fail('그림 검사: binaryItemIDRef가 없다');
    const binName = [...entries.keys()].find((n) => n.startsWith('BinData/')
      && n.slice(8).replace(/\.[^.]*$/, '') === id);
    if (!binName) fail(`그림 검사: BinData에 ${id} 항목이 없다`);
    else if (sha256(entries.get(binName)) !== sha256(imageBytes)) {
      fail(`그림 검사: ${binName}의 바이트가 원본과 다르다`);
    }
    // 양식이 이미 들고 있는 그림 이름과 겹치면 한글이 딴 그림을 보여 준다
    const taken = new Set([...templateEntries.keys()]
      .filter((n) => n.startsWith('BinData/'))
      .map((n) => n.slice(8).replace(/\.[^.]*$/, '')));
    const tplHpf = decoder.decode(templateEntries.get('Contents/content.hpf'));
    for (const m of tplHpf.matchAll(/<opf:item\s+id="([^"]*)"/g)) taken.add(m[1]);
    if (taken.has(id)) fail(`그림 검사: 양식에 이미 있는 '${id}'과 이름이 겹쳤다`);

    const hpf = decoder.decode(entries.get('Contents/content.hpf'));
    if (!hpf.includes(`<opf:item id="${id}" href="${binName}"`)) {
      fail(`그림 검사: content.hpf 매니페스트에 ${id} 항목이 없다`);
    }
    if (!section.includes('xmlns:hc=')) fail('그림 검사: 구역 루트에 hc 이름공간이 없다');

    // engine.py가 만든 hp:pic과 맞대어 본다(난수 id와 그림 이름만 지운다)
    const script = path.join(work, 'engine_pic.py');
    writeFileSync(script, `
import io, re, sys, zipfile
from hwpx_studio.engine import build_document
from hwpx_studio.profile import load_profile
res = build_document(load_profile('policy-default'), [('image', ${JSON.stringify(IMAGE)})])
z = zipfile.ZipFile(io.BytesIO(res.data))
s = z.read('Contents/section0.xml').decode('utf-8')
m = re.search(r'<hp:pic .*?</hp:pic>', s, re.S)
sys.stdout.write(m.group() if m else '')
`, 'utf8');
    let enginePic = '';
    try {
      enginePic = execFileSync('python3', [script], { encoding: 'utf8' });
    } catch (err) {
      fail(`그림 검사: engine.py 호출이 터졌다 — ${err.message}`);
    }
    if (enginePic) {
      const a = normalizeRandom(pics[0]);
      const b = normalizeRandom(enginePic);
      if (a !== b) fail(`그림 검사: hp:pic이 engine.py와 다르다 — ${firstDiff(a, b)}`);
      else ok(`hp:pic ${a.length}글자가 engine.py와 일치 (${pxW}×${pxH}px)`);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 5. 왕복 — 빌드 → 되돌리기
// ──────────────────────────────────────────────────────────────
console.log('── 4층 왕복 검사 ' + '─'.repeat(30));
if (baseResult) {
  const from = mark();
  const back = await readBack(baseResult.bytes, baseForm);
  const paras = back.blocks.filter((b) => b.kind === 'para');
  const wanted = [
    '노인 1인가구 비중도 같은 기간 함께 늘었다',
    '고령인구 비율은 전국 시군구 평균을 웃도는 수준으로 올라섰다',
    '재가돌봄 대기자는 2년 사이 두 배로 늘었다',
    '자료：통계청, 「주민등록인구현황」, 각 연도.',
  ];
  for (const text of wanted) {
    if (!paras.some((b) => b.text.includes(text))) {
      fail(`왕복 검사: 본문에서 '${text}'를 되찾지 못했다`);
    }
  }

  const table = back.blocks.find((b) => b.kind === 'table'
    && b.rows[0] && b.rows[0].join('|') === '구분|2020년|2024년');
  if (!table) fail('왕복 검사: 표 머리행을 되찾지 못했다');
  else if (table.rows.length !== 4) {
    fail(`왕복 검사: 표가 ${table.rows.length}행이다 (4행이어야 한다)`);
  } else if (table.rows[3][1] !== '9,140<br>(추계)') {
    fail(`왕복 검사: 셀 안 줄바꿈이 깨졌다 — ${JSON.stringify(table.rows[3][1])}`);
  }

  const secondTable = back.blocks.find((b) => b.kind === 'table'
    && b.rows[0] && b.rows[0].join('|') === '항목|2022년|2024년');
  if (!secondTable) fail('왕복 검사: 둘째 표를 되찾지 못했다');

  const noteTexts = back.blocks.flatMap((b) => (b.notes || []).map(([, t]) => t));
  for (const note of ['통계청, 「장래인구추계: 2022~2052년」, 2024.',
    '보건복지부, 「지역사회보장 수요조사 결과」, 2024.']) {
    if (!noteTexts.includes(note)) fail(`왕복 검사: 각주 '${note}'를 되찾지 못했다`);
  }

  if (clean(from)) {
    ok(`문단 ${paras.length}개·표 2개·각주 ${noteTexts.length}개를 되돌려 확인`);
  }
}

// ──────────────────────────────────────────────────────────────
// 곁다리 — 파서·검사기가 제 할 말을 하는가
// ──────────────────────────────────────────────────────────────
console.log('── 5층 파서 검사 ' + '─'.repeat(30));
{
  const from = mark();
  const parsed = parseInput(MANUSCRIPT, baseForm);
  const kinds = parsed.items.map((i) => i.kind);
  if (!kinds.includes('table_note')) fail('파서 검사: 표 주를 못 알아봤다');
  if (kinds.filter((k) => k === 'table').length !== 2) fail('파서 검사: 표가 2개가 아니다');
  if (parsed.chapter !== '지역사회보장 여건 분석') {
    fail(`파서 검사: [장: …]을 못 읽었다 — ${parsed.chapter}`);
  }
  const withCols = parsed.items.find((i) => i.kind === 'table' && i.colPct);
  if (!withCols || withCols.colPct.join(',') !== '40,30,30') {
    fail('파서 검사: {cols=40,30,30}을 못 읽었다');
  }
  const notes = parsed.items.flatMap((i) => i.notes);
  if (notes.length !== 2) fail(`파서 검사: 각주 자리가 ${notes.length}개다 (2개여야 한다)`);

  const broken = parseInput('□ 근거 없는 각주[^9]\n', baseForm);
  const issues = lintParsed(broken, baseForm);
  if (!issues.some((s) => s.includes('내용을 찾지 못했다'))) {
    fail('파서 검사: 내용 없는 각주를 그냥 넘겼다');
  }
  if (clean(from)) ok('표·표주·각주·장 제목·열 너비를 모두 알아본다');
}

// ──────────────────────────────────────────────────────────────
// 6. 경계 — 깨진 입력을 조용히 통과시키지 않는가
// ──────────────────────────────────────────────────────────────
console.log('── 6층 경계 검사 ' + '─'.repeat(30));
{
  const from = mark();

  // {cols} 합이 0이면 비율을 나눌 수 없다. 예전에는 width="NaN"이 그대로 나갔다
  const zeroCols = await buildForm(templateBytes, baseForm,
    '□ 앞\n\n{cols=0,0,0}\n| 가 | 나 | 다 |\n| 1 | 2 | 3 |\n\n□ 뒤\n', {});
  const zeroSection = await sectionOf(zeroCols.bytes, baseForm.section);
  const widths = [...zeroSection.matchAll(/<hp:cellSz width="([^"]*)"/g)].map((m) => m[1]);
  if (widths.some((w) => !Number.isFinite(Number(w)))) {
    fail(`경계 검사: 셀 너비에 숫자가 아닌 값이 있다 — ${JSON.stringify(widths.slice(0, 6))}`);
  }
  if (!zeroCols.issues.some((s) => s.includes('합이 0'))) {
    fail('경계 검사: {cols} 합이 0인데 알리지 않았다');
  }

  // 계약이 요구하는 번호매기기 네 가지 가운데 AUTO_PAREN이 빠져 있었다
  const parenForm = JSON.parse(JSON.stringify(baseForm));
  for (const level of parenForm.levels) {
    if (level.key === 'h2') level.numbering = 'AUTO_PAREN';
  }
  const parenSection = await sectionOf(
    (await buildForm(templateBytes, parenForm, '## 첫\n\n## 둘\n', {})).bytes,
    parenForm.section);
  for (const want of ['1) 첫', '2) 둘']) {
    if (!parenSection.includes(`<hp:t>${want}</hp:t>`)) {
      fail(`경계 검사: AUTO_PAREN이 '${want}'를 찍지 않았다`);
    }
  }

  // 원고 글자가 그림 자리표와 겹쳐도 글이 그림으로 바뀌면 안 된다
  const png = new Uint8Array(readFileSync(IMAGE));
  try {
    const forged = await buildForm(templateBytes, baseForm,
      '□ __IMAGE_PLACEHOLDER_0__\n\n![](core22.png)\n',
      { images: new Map([['core22.png', png]]) });
    const forgedSection = await sectionOf(forged.bytes, baseForm.section);
    const forgedPics = (forgedSection.match(/<hp:pic /g) || []).length;
    if (forgedPics !== 1) fail(`경계 검사: hp:pic이 ${forgedPics}개다 (1개여야 한다)`);
    if (!forgedSection.includes('<hp:t>__IMAGE_PLACEHOLDER_0__</hp:t>')) {
      fail('경계 검사: 자리표와 같은 글자를 적었더니 본문이 그림으로 바뀌었다');
    }
  } catch (err) {
    fail(`경계 검사: 자리표와 같은 글자를 적었더니 빌드가 터졌다 — ${err.message}`);
  }

  // 빌드가 겹쳐도 같은 원고는 같은 문서를 내야 한다(일련번호가 모듈 하나에 있다)
  const [p1, p2] = await Promise.all([
    buildForm(templateBytes, baseForm, '□ 가\n\n| a | b |\n| 1 | 2 |\n', {}),
    buildForm(templateBytes, baseForm, '□ 가\n\n| a | b |\n| 1 | 2 |\n', {}),
  ]);
  const s1 = await sectionOf(p1.bytes, baseForm.section);
  const s2 = await sectionOf(p2.bytes, baseForm.section);
  if (s1 !== s2) fail('경계 검사: 빌드를 겹쳐 돌리니 같은 원고가 다른 문서를 냈다');

  // 깨진 템플릿은 조용히 넘어가지 않는다
  let threw = '';
  try {
    await buildForm(new Uint8Array(1000), baseForm, '□ 가\n', {});
  } catch (err) { threw = err.message; }
  if (!threw) fail('경계 검사: 깨진 zip을 템플릿으로 줬는데 그냥 만들어 냈다');

  // PDF·한글에서 붙여넣은 원고에는 XML 1.0이 못 받는 제어문자가 섞여 온다.
  // 그대로 내보내면 태그 세기는 통과하지만 한글이 파일을 열지 못한다
  const ctrl = await buildForm(templateBytes, baseForm,
    '○ 제어\u0007문자\u0000 낀\u001f 줄\n', {});
  const ctrlSection = await sectionOf(ctrl.bytes, baseForm.section);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(ctrlSection)) {
    fail('경계 검사: 제어문자가 구역 XML에 그대로 나갔다');
  }
  if (!ctrlSection.includes('제어문자 낀 줄')) {
    fail('경계 검사: 제어문자를 떨어뜨리면서 글자까지 잃었다');
  }
  writeFileSync(path.join(work, 'ctrl.xml'), ctrlSection, 'utf8');
  try {
    execFileSync('python3', ['-c',
      'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])',
      path.join(work, 'ctrl.xml')], { encoding: 'utf8' });
  } catch (err) {
    fail(`경계 검사: 진짜 XML 파서가 산출물을 거부했다 — ${String(err.message).slice(0, 160)}`);
  }

  if (clean(from)) {
    ok('cols 합 0·AUTO_PAREN·자리표 위조·동시 빌드·깨진 zip·제어문자를 모두 짚는다');
  }
}

rmSync(work, { recursive: true, force: true });

console.log('─'.repeat(46));
if (failures.length) {
  process.exitCode = 1;
  console.log(`실패 ${failures.length}건`);
  for (const why of failures) console.log(`  [실패] ${why}`);
} else {
  console.log('모두 통과');
}
