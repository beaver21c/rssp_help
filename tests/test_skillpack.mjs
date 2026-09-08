/* 개발도구용 스킬 꾸러미 시험 — node tests/test_skillpack.mjs
   시험 틀을 쓰지 않는다. 어긋나면 사유를 찍고 process.exitCode = 1로 끝낸다.

   보는 것
     1. 꾸러미에 있어야 할 파일이 다 들어가고 빈 파일이 없는가
     2. 실어 나른 lib/ 가 저장소 원본과 **한 바이트도 다르지 않은가**(사본이 어긋날 자리 차단)
     3. SKILL.md 머리말이 클로드 코드가 읽는 꼴인가
     4. 안내 문서가 실제 파일 이름·옵션과 어긋나지 않는가
     5. **압축을 풀어 build.mjs 를 진짜로 돌려** hwpx 가 나오는가
        — 표지 없이 / 표지 붙여 / 그림 넣어 세 갈래를 모두 돌린다
     6. 잘못 부르면 조용히 넘어가지 않고 사유를 찍고 죽는가 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildSkillPack, WRITTEN, CARRIED, SKILL_NAME } from '../app/assets/skillpack.js';
import { unzip } from '../app/assets/zip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, 'app');

let fails = 0; let checks = 0;
const ok = (cond, msg, extra) => {
  checks += 1;
  if (cond) { console.log(`  통과 — ${msg}`); return true; }
  fails += 1;
  console.error(`  실패 — ${msg}${extra ? `\n      ${String(extra).slice(0, 600)}` : ''}`);
  return false;
};
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`);

/* 브라우저의 fetch 자리를 파일 읽기로 대신한다 */
const read = async (rel) => new Uint8Array(fs.readFileSync(path.join(APP, rel)));

/* ───────── 1. 꾸러미 짜임새 ───────── */
head('꾸러미 짜임새');
const bytes = await buildSkillPack(read);
const files = await unzip(bytes);
const names = [...files.keys()];
const dec = (n) => new TextDecoder().decode(files.get(n));

{
  ok(bytes.length > 20000, `꾸러미 ${Math.round(bytes.length / 1024)}KB`);
  ok(names.every((n) => n.startsWith(`${SKILL_NAME}/`)),
    `모든 파일이 ${SKILL_NAME}/ 아래에 있다(풀면 폴더 하나)`,
    names.find((n) => !n.startsWith(`${SKILL_NAME}/`)));

  const want = [
    'SKILL.md', 'AGENTS.md', '적용안내.md', 'build.mjs',
    'reference/마커문법.md', 'reference/작성지시.md', '예시/원고예시.txt',
    'lib/zip.js', 'lib/xml.js', 'lib/formkit.js', 'lib/hwpx-form.js', 'lib/cover.js',
    'assets/template.hwpx', 'assets/form.json',
  ];
  const missing = want.filter((w) => !files.has(`${SKILL_NAME}/${w}`));
  ok(missing.length === 0, `있어야 할 파일 ${want.length}개가 모두 있다`, missing.join(', '));

  const empty = names.filter((n) => !files.get(n).length);
  ok(empty.length === 0, '빈 파일이 없다', empty.join(', '));
}

/* ───────── 2. 실어 나른 파일이 원본과 같은가 ───────── */
head('실어 나른 모듈이 원본과 같은가');
{
  let bad = null;
  for (const [from, to] of CARRIED) {
    const src = fs.readFileSync(path.join(APP, from));
    const got = Buffer.from(files.get(`${SKILL_NAME}/${to}`));
    if (!src.equals(got)) { bad = `${from} → ${to}`; break; }
  }
  ok(!bad, `실어 나른 파일 ${CARRIED.length}개가 저장소 원본과 바이트까지 같다`, bad);

  /* lib/ 안에서 서로를 부르는 주소가 꾸러미 안에서도 맞는가 —
     hwpx-form.js 는 ./zip.js ./xml.js ./formkit.js 를 같은 폴더에서 찾는다 */
  const form = dec(`${SKILL_NAME}/lib/hwpx-form.js`);
  const deps = [...form.matchAll(/from '\.\/([\w.-]+)'/g)].map((m) => m[1]);
  const lost = deps.filter((d) => !files.has(`${SKILL_NAME}/lib/${d}`));
  ok(lost.length === 0, `hwpx-form.js 가 부르는 모듈 ${deps.length}개가 lib/ 에 다 있다`, lost.join(', '));

  const cover = dec(`${SKILL_NAME}/lib/cover.js`);
  const cdeps = [...cover.matchAll(/from '\.\/([\w.-]+)'/g)].map((m) => m[1]);
  ok(cdeps.every((d) => files.has(`${SKILL_NAME}/lib/${d}`)), 'cover.js 가 부르는 모듈도 다 있다');

  const build = dec(`${SKILL_NAME}/build.mjs`);
  const bdeps = [...build.matchAll(/from '\.\/([\w./-]+)'/g)].map((m) => m[1]);
  const blost = bdeps.filter((d) => !files.has(`${SKILL_NAME}/${d}`));
  ok(blost.length === 0, `build.mjs 가 부르는 모듈 ${bdeps.length}개가 다 있다`, blost.join(', '));
}

/* ───────── 3. 스킬 정의 ───────── */
head('스킬 정의 (SKILL.md · AGENTS.md)');
{
  const skill = dec(`${SKILL_NAME}/SKILL.md`);
  const lines = skill.split('\n');
  ok(lines[0] === '---', '머리말이 첫 줄부터 시작한다');
  const close = lines.indexOf('---', 1);
  ok(close > 1, '머리말이 닫힌다', String(close));
  const fm = lines.slice(1, close).join('\n');
  ok(new RegExp(`^name: ${SKILL_NAME}$`, 'm').test(fm), `머리말에 name: ${SKILL_NAME}`);
  const desc = /^description: (.+)$/m.exec(fm);
  ok(desc && desc[1].length > 40, 'description 이 언제 쓰는지 알 만큼 길다', desc && desc[1]);
  ok(desc && /hwpx|한글/.test(desc[1]), 'description 에 무엇을 만드는지 적혀 있다');
  ok(!/\n---\n/.test(skill.slice(skill.indexOf('---', 1) + 4)),
    '본문에 머리말 구분선(---)이 또 나오지 않는다(파서가 헷갈린다)');

  const agents = dec(`${SKILL_NAME}/AGENTS.md`);
  ok(/build\.mjs/.test(agents), 'AGENTS.md 가 build.mjs 를 가리킨다');
  ok(/Node 22/.test(agents), 'AGENTS.md 가 Node 판을 밝힌다');
}

/* ───────── 4. 안내가 실제와 어긋나지 않는가 ───────── */
head('안내 문서와 실제가 맞는가');
{
  const build = dec(`${SKILL_NAME}/build.mjs`);
  const docs = ['SKILL.md', 'AGENTS.md', '적용안내.md'].map((n) => dec(`${SKILL_NAME}/${n}`)).join('\n');

  for (const opt of ['--cover', '--image', '--chapter']) {
    ok(build.includes(`'${opt}'`), `build.mjs 가 ${opt} 를 실제로 받는다`);
  }
  ok(/--cover/.test(docs) && /--image/.test(docs), '안내가 옵션을 적어 두었다');

  /* 안내가 가리키는 파일이 정말 꾸러미에 있는가 */
  const cited = [...docs.matchAll(/`([\w가-힣./-]+\.(?:md|mjs|txt|json|hwpx))`/g)].map((m) => m[1]);
  const uniq = [...new Set(cited)].filter((p) => p.includes('/') || /\.(md|mjs)$/.test(p));
  /* 안내는 두 자리에서 파일을 가리킨다 — 꾸러미 안에서 본 경로(build.mjs)와
     꾸러미 바깥에서 본 경로(rssp-hwpx/build.mjs, 코덱스 쪽). 둘 다 있어야 맞다 */
  const inPack = (p) => files.has(`${SKILL_NAME}/${p}`) || files.has(p);
  const nofile = uniq.filter((p) => !inPack(p) && !p.startsWith('원고/') && !p.startsWith('산출/'));
  ok(nofile.length === 0, `안내가 가리킨 파일 ${uniq.length}개가 다 있다`, nofile.join(', '));

  ok(/beaver21c\.github\.io\/rssp_help/.test(docs), '웹 도구 주소를 적어 두었다');
  ok(/제1장/.test(docs) && /--cover/.test(docs), '표지는 제1장에만이라는 규칙을 적어 두었다');

  const write = dec(`${SKILL_NAME}/reference/작성지시.md`);
  ok(/Q1~Q3/.test(write), '작성지시가 비슷한 수준 판단 기준(Q1~Q3)을 적어 두었다');
  ok(/개조식/.test(write) && /반말/.test(write), '문체 규칙을 적어 두었다');
  ok(/지어내지 않는다/.test(write), '없는 자료를 지어내지 말라는 금지를 적어 두었다');

  const syn = dec(`${SKILL_NAME}/reference/마커문법.md`);
  for (const m of ['####', '○', '▪', '※', '{cols=', '![](']) {
    ok(syn.includes(m), `마커문법이 ${m} 을(를) 설명한다`);
  }
  ok(Object.keys(WRITTEN).length >= 8, `지어낸 문서 ${Object.keys(WRITTEN).length}개`);
}

/* ───────── 5. 풀어서 진짜로 돌려 보기 ───────── */
head('풀어서 build.mjs 돌리기');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rssp-skill-'));
try {
  for (const [name, data] of files) {
    const p = path.join(work, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
  const dir = path.join(work, SKILL_NAME);
  const run = (args) => execFileSync('node', ['build.mjs', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  /* (1) 표지 없이 — 기본 */
  const out1 = path.join(work, 'plain.hwpx');
  const log1 = run(['예시/원고예시.txt', out1]);
  ok(fs.existsSync(out1), 'hwpx 가 나왔다', log1);
  ok(/본문만/.test(log1), '표지를 안 붙였다고 알린다', log1.trim().split('\n')[0]);
  const z1 = await unzip(new Uint8Array(fs.readFileSync(out1)));
  ok(z1.has('Contents/section0.xml') && !z1.has('Contents/section1.xml'),
    '표지 구역을 떼고 본문만 남겼다', [...z1.keys()].join(' '));
  ok(new TextDecoder().decode(z1.get('mimetype')) === 'application/hwp+zip', '한글이 읽는 mimetype');

  /* (2) 표지 붙여 */
  const out2 = path.join(work, 'cover.hwpx');
  const log2 = run(['예시/원고예시.txt', out2, '--cover']);
  ok(/표지 포함/.test(log2), '--cover 면 표지를 붙였다고 알린다');
  const z2 = await unzip(new Uint8Array(fs.readFileSync(out2)));
  ok(z2.has('Contents/section1.xml') && z2.has('Contents/section2.xml'),
    '표지·제출문 구역이 그대로 있다');
  ok(fs.statSync(out2).size > fs.statSync(out1).size, '표지가 붙어 더 크다',
    `${fs.statSync(out2).size} vs ${fs.statSync(out1).size}`);

  /* (3) 그림 넣어 — 원고의 ![](indicator1.png) 자리 */
  const png = path.join(work, 'p.png');
  fs.writeFileSync(png, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR42mP8z8BQz0AEYBxVSF+F'
    + 'ABJ2AwHpDIhaAAAAAElFTkSuQmCC', 'base64'));
  const out3 = path.join(work, 'img.hwpx');
  const log3 = run(['예시/원고예시.txt', out3, '--image', `indicator1.png=${png}`]);
  ok(/그림 1개 삽입/.test(log3), '그림을 넣었다고 알린다', log3);
  const z3 = await unzip(new Uint8Array(fs.readFileSync(out3)));
  ok([...z3.keys()].some((n) => n.startsWith('BinData/')), 'BinData 에 그림이 들어갔다',
    [...z3.keys()].filter((n) => n.startsWith('BinData')).join(' '));
  const hpf3 = new TextDecoder().decode(z3.get('Contents/content.hpf'));
  ok(/BinData\//.test(hpf3), '매니페스트에도 그림이 적혔다');

  /* (4) 잘못 불렀을 때 */
  const dies = (args) => {
    try { run(args); return ''; } catch (e) { return String(e.stderr || e.stdout || e.message); }
  };
  ok(/원고 파일과 산출 파일/.test(dies(['예시/원고예시.txt'])), '인자가 모자라면 쓰는 법을 찍고 죽는다');
  ok(/찾지 못했다/.test(dies(['없는파일.txt', path.join(work, 'x.hwpx')])),
    '없는 원고를 주면 사유를 찍고 죽는다');
  ok(/모르는 옵션/.test(dies(['예시/원고예시.txt', path.join(work, 'x.hwpx'), '--wat'])),
    '모르는 옵션을 조용히 넘기지 않는다');
  ok(/이름=경로/.test(dies(['예시/원고예시.txt', path.join(work, 'x.hwpx'), '--image', 'abc'])),
    '--image 꼴이 틀리면 사유를 찍는다');

  /* (5) 예시 원고가 검사를 통과하는가 — 담당자가 처음 보는 본보기다 */
  ok(!/검사 \d+건/.test(log1) || !/2층|3층/.test(log1),
    '예시 원고가 구조 검사에서 죽지 않는다', log1);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

/* ───────── 6. 읽기 함수가 어긋날 때 ───────── */
head('읽기가 어긋날 때');
{
  let threw = '';
  try { await buildSkillPack(null); } catch (e) { threw = e.message; }
  ok(/읽기 함수를 받지 못했다/.test(threw), '읽기 함수 없이 부르면 오류', threw);

  threw = '';
  try { await buildSkillPack(async () => { throw new Error('HTTP 404'); }); } catch (e) { threw = e.message; }
  ok(/읽지 못했다/.test(threw) && /HTTP 404/.test(threw),
    '실어 나를 파일을 못 읽으면 어느 파일인지 밝히고 오류', threw);

  threw = '';
  try { await buildSkillPack(async () => new Uint8Array(0)); } catch (e) { threw = e.message; }
  ok(/비어 있다/.test(threw), '빈 파일을 조용히 담지 않는다', threw);
}

console.log(`\n검사 ${checks}건 · 실패 ${fails}건`);
if (fails) process.exitCode = 1;
