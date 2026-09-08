/**
 * 양식 보존 빌더 대조 시험 — `app/assets/hwpx-form.js` ↔ `build_form.py`.
 *
 * 돌리는 법: node tests/test_form_parity.mjs
 * 시험 틀을 쓰지 않는다. 어긋나면 사유를 찍고 process.exitCode = 1로 끝낸다.
 *
 * 보는 것
 *  1. JS와 파이썬이 만든 `Contents/section2.xml`이 글자까지 같은가
 *  2. 자동 번호가 걸린 양식에서도 같은가
 *  3. 손대면 안 되는 파일(header·section0·section1·settings)이 그대로인가
 *  4. 그림을 넣었을 때 hp:pic·BinData·content.hpf가 제대로 붙는가
 *     (파이썬 빌더에는 그림이 없어 engine.py가 만든 hp:pic과 맞대어 본다)
 *  5. 빌드 → 되돌리기 왕복에서 본문·표·각주가 살아남는가
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildForm, parseInput, lintParsed, detectImageSize } from '../app/assets/hwpx-form.js';
import { readBack } from '../app/assets/readback.js';
import { unzip } from '../app/assets/zip.js';

const KIT ='/tmp/claude-0/-home-user-rssp-help/393a50e4-1d17-5b67-a48d-cb849ff1da1c'
  + '/scratchpad/verify/guide6_kit2';
const BUILDER = path.join(KIT, 'build_form.py');
const TEMPLATE = path.join(KIT, 'template.hwpx');
const IMAGE = path.join(KIT, 'core22.png');

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
const work = mkdtempSync(path.join(tmpdir(), 'form-parity-'));
const baseForm = JSON.parse(readFileSync(path.join(KIT, 'form.json'), 'utf8'));
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
  if (a !== b) fail(`${label}: section2.xml이 파이썬과 다르다 — ${firstDiff(a, b)}`);
  else ok(`${label} — section2.xml ${a.length}글자가 파이썬과 완전 일치`);
}

// ──────────────────────────────────────────────────────────────
// 3. 손대면 안 되는 파일
// ──────────────────────────────────────────────────────────────
console.log('── 2층 보존 검사 ' + '─'.repeat(30));
const KEEP = ['Contents/header.xml', 'Contents/section0.xml',
  'Contents/section1.xml', 'settings.xml'];
const templateEntries = await unzip(templateBytes);
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
  if (clean(from)) ok(`${KEEP.join(', ')} SHA-256 그대로`);
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
    if (id === 'image1') {
      fail('그림 검사: 양식에 이미 있는 image1과 이름이 겹쳤다');
    }

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

rmSync(work, { recursive: true, force: true });

console.log('─'.repeat(46));
if (failures.length) {
  process.exitCode = 1;
  console.log(`실패 ${failures.length}건`);
  for (const why of failures) console.log(`  [실패] ${why}`);
} else {
  console.log('모두 통과');
}
