/* hwpx 꾸러미 꼴 검사 — node tests/test_package.mjs
   시험 틀을 쓰지 않는다. 어긋나면 사유를 찍고 process.exitCode = 1로 끝낸다.

   왜 이 시험이 있나
     산출물의 XML이 아무리 멀쩡해도 **zip 꾸러미의 꼴**이 한글이 쓰는 것과 다르면
     한글은 「손상된 파일」이라며 열지 않는다. 우리 쪽 unzip 으로 읽히는 것은
     증거가 되지 못한다 — 읽는 규칙이 우리 것이기 때문이다.
     그래서 기준을 **한글 13.0이 직접 쓴 안내서 원본**으로 잡고, 산출물의 항목 틀
     (압축 방식·플래그·만든 판·속성·시각)이 원본과 같은지 바이트로 대조한다.

   보는 것
     1. 왕복 — 원본을 풀었다 다시 싸면 모든 항목의 틀이 원본과 같은가
     2. 산출물 — buildForm/도식 삽입/표지 떼기를 거친 파일의 틀이 원본과 같은가
     3. 손대지 않기로 한 항목은 내용 바이트까지 같은가
     4. mimetype 이 맨 앞·무압축이고 내용이 맞는가
     5. Preview/PrvText.txt 가 UTF-8 인가(원본과 같은 인코딩)
     6. 모든 XML 이 읽히고, 매니페스트·메타가 없는 파일을 가리키지 않는가 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzip, zip } from '../app/assets/zip.js';
import { buildForm } from '../app/assets/hwpx-form.js';
import { stripFront } from '../app/assets/cover.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, 'app');

let fails = 0; let checks = 0;
const ok = (cond, msg, extra) => {
  checks += 1;
  if (cond) { console.log(`  통과 — ${msg}`); return true; }
  fails += 1;
  console.error(`  실패 — ${msg}${extra ? `\n      ${String(extra).slice(0, 500)}` : ''}`);
  return false;
};
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`);

/* ───────── zip 레코드를 직접 읽는다(우리 unzip 을 믿지 않는다) ───────── */
function records(bytes) {
  const b = new Uint8Array(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i -= 1) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD 를 찾지 못했다');
  const count = v.getUint16(eocd + 10, true);
  let o = v.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (v.getUint32(o, true) !== 0x02014b50) throw new Error('중앙 디렉터리 손상');
    const nameLen = v.getUint16(o + 28, true);
    const extraLen = v.getUint16(o + 30, true);
    const commentLen = v.getUint16(o + 32, true);
    const name = new TextDecoder().decode(b.subarray(o + 46, o + 46 + nameLen));
    const lho = v.getUint32(o + 42, true);
    out.push({
      name,
      vmade: v.getUint16(o + 4, true),
      vneed: v.getUint16(o + 6, true),
      flag: v.getUint16(o + 8, true),
      method: v.getUint16(o + 10, true),
      time: v.getUint16(o + 12, true),
      date: v.getUint16(o + 14, true),
      usize: v.getUint32(o + 24, true),
      eattr: v.getUint32(o + 38, true),
      extraLen,
      // 지역 헤더도 함께 본다 — 중앙과 어긋나면 읽는 쪽이 갈린다
      lFlag: v.getUint16(lho + 6, true),
      lMethod: v.getUint16(lho + 8, true),
      lExtraLen: v.getUint16(lho + 28, true),
    });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* 틀에서 비교할 값만 뽑는다. 크기·CRC 는 내용이 바뀌면 당연히 달라지므로 뺀다.
   일부러 견주지 않는 두 가지
     · 플래그 비트 1~2 (0x0006) — deflate **인코더 설정**을 적어 두는 자리다.
       우리는 우리 deflate 스트림을 만들므로 원본 값을 물려받는 것이 오히려 거짓말이 된다
     · vmade 의 하위 바이트 — 「만든 zip 판」(2.0/2.3)이라 읽는 데 영향이 없다.
       상위 바이트(만든 운영체제)는 견준다 */
const FLAG_MASK = ~0x0006;
const shape = (r) => `method=${r.method} flag=0x${(r.flag & FLAG_MASK).toString(16).padStart(4, '0')} `
  + `host=${r.vmade >> 8} vneed=${r.vneed} date=${r.date} time=${r.time} `
  + `eattr=0x${r.eattr.toString(16)} extra=${r.extraLen}`;

const ORIG = path.join(ROOT, 'source/제6기_지역사회보장계획_수립안내_시군구.hwpx');
const TPL = path.join(APP, 'data/template.hwpx');
const form = JSON.parse(fs.readFileSync(path.join(APP, 'data/form.json'), 'utf8'));

if (!fs.existsSync(ORIG)) {
  console.error('기준으로 삼을 안내서 원본이 없다 — source/ 를 확인할 것');
  process.exitCode = 1;
} else {

const origBytes = new Uint8Array(fs.readFileSync(ORIG));
const origRecs = records(origBytes);
const origShape = new Map(origRecs.map((r) => [r.name, shape(r)]));
const tplBytes = new Uint8Array(fs.readFileSync(TPL));

/* 산출물은 원본이 아니라 **템플릿**에서 나온다. 그래서 기준 틀은 템플릿의 것으로 잡고,
   템플릿이 원본과 같은 꼴인지는 따로 한 번 확인한다(아래 2장). */
const tplRecs = records(tplBytes);
const baseShape = new Map(tplRecs.map((r) => [r.name, shape(r)]));
const baseRecs = tplRecs;

/** 산출물의 항목 틀이 기준(템플릿)과 같은가 */
function sameShape(bytes, label, { allowMissing = [], want = baseShape, kin = baseRecs } = {}) {
  const recs = records(bytes);
  const bad = [];
  for (const r of recs) {
    const wish = want.get(r.name);
    if (!wish) {                       // 기준에 없던 새 항목(그림 등)
      const sib = kin.find((x) => x.name.split('/')[0] === r.name.split('/')[0]);
      if (sib && shape(r) !== shape(sib)) {
        bad.push(`${r.name}\n        새 항목 ${shape(r)}\n        형제   ${shape(sib)}`);
      }
      continue;
    }
    if (shape(r) !== wish) bad.push(`${r.name}\n        산출물 ${shape(r)}\n        기준   ${wish}`);
    if (r.flag !== r.lFlag || r.method !== r.lMethod || r.extraLen !== r.lExtraLen) {
      bad.push(`${r.name} — 지역 헤더와 중앙 디렉터리가 어긋난다`);
    }
  }
  ok(bad.length === 0, `${label} — 항목 ${recs.length}개의 꼴이 기준과 같다`, bad.join('\n      '));
  const first = recs[0];
  ok(first && first.name === 'mimetype' && first.method === 0 && first.flag === 0,
    `${label} — mimetype 이 맨 앞·무압축·플래그 0`,
    first && `${first.name} method=${first.method} flag=${first.flag}`);
  const missing = [...want.keys()]
    .filter((n) => !recs.some((r) => r.name === n) && !allowMissing.includes(n));
  ok(missing.length === 0, `${label} — 기준 항목이 빠지지 않았다`, missing.join(', '));
  return recs;
}

/* ───────── 1. 왕복 ───────── */
head('왕복 — 풀었다 다시 싸면 원본 꼴 그대로인가');
{
  const files = await unzip(origBytes);
  ok(files.frames instanceof Map, 'unzip 이 항목 틀을 함께 돌려준다');
  ok(files.frames.size === files.size, `틀 ${files.frames.size}개 = 항목 ${files.size}개`);
  const again = await zip(files, { stored: ['mimetype'], frames: files.frames });
  /* 여기서만은 기준이 원본이다 — 원본을 풀었다 그대로 다시 싼 것이므로 */
  sameShape(again, '왕복 산출물', { want: origShape, kin: origRecs });

  /* 내용도 한 바이트도 달라지면 안 된다 */
  const back = await unzip(again);
  let diff = null;
  for (const [name, data] of files) {
    const got = back.get(name);
    if (!got || Buffer.from(got).compare(Buffer.from(data)) !== 0) { diff = name; break; }
  }
  ok(!diff, '왕복해도 모든 항목의 내용이 같다', diff);

  /* 틀을 안 주면 예전처럼 우리 식으로 쓴다(다른 용도의 zip 은 그대로 돌아야 한다) */
  const plain = await zip(new Map([['a.txt', new TextEncoder().encode('x')]]));
  ok(records(plain).length === 1, '틀 없이도 평범한 zip 을 만든다');
  ok(records(plain)[0].flag === 0, '아스키 이름이면 플래그 0');
  const kor = await zip(new Map([['한글.txt', new TextEncoder().encode('x')]]));
  ok(records(kor)[0].flag === 0x0800, '이름에 한글이 섞이면 UTF-8 플래그를 켠다');
}

/* ───────── 2. 템플릿이 원본과 같은 꼴인가 ─────────
   산출물의 기준이 템플릿이므로, 템플릿 자체가 한글이 쓴 원본과 어긋나 있으면
   그 아래 모든 검사가 헛것이 된다. 여기서 한 번 못박는다. */
head('배포용 템플릿 — 한글이 쓴 원본과 같은 꼴인가');
sameShape(tplBytes, '템플릿', { want: origShape, kin: origRecs });

/* ───────── 3. 절 산출물(표지 포함) ───────── */
head('절 산출물 — buildForm');
const SAMPLE = [
  '# 제1장 계획 수립 개요',
  '',
  '## 1. 계획의 배경',
  '',
  '○ 총인구 1,185천 명 (2024년 기준)',
  '- 최근 5년 연평균 0.4% 감소 → 2019년 대비 2.1% 축소',
  '',
  '| 구분 | 2023년 | 2024년 |',
  '|---|---|---|',
  '| 총인구(명) | 1,190,000 | 1,185,000 |',
  '※ 자료：행정안전부, 「주민등록인구현황」, 2024.',
].join('\n');

const built = await buildForm(tplBytes, form, SAMPLE, { images: new Map() });
{
  const recs = sameShape(built.bytes, '절 산출물');
  const z = await unzip(built.bytes);

  /* 손대지 않기로 한 항목은 내용 바이트까지 같아야 한다 */
  const tpl = await unzip(tplBytes);
  const touched = new Set([form.section, 'Preview/PrvText.txt', 'Contents/content.hpf']);
  const moved = [];
  for (const [name, data] of tpl) {
    if (touched.has(name)) continue;
    const got = z.get(name);
    if (!got || Buffer.from(got).compare(Buffer.from(data)) !== 0) moved.push(name);
  }
  ok(moved.length === 0, '손대지 않기로 한 항목의 내용이 템플릿과 같다', moved.join(', '));

  /* 미리보기 글 — 원본과 같은 UTF-8 이어야 한다 */
  const prv = z.get('Preview/PrvText.txt');
  const orig = await unzip(origBytes);
  const origPrv = orig.get('Preview/PrvText.txt');
  ok(!origPrv.includes(0), '원본 미리보기 글에 NUL 바이트가 없다(UTF-8)');
  ok(prv && !prv.includes(0), '산출물 미리보기 글에도 NUL 바이트가 없다',
    prv && Buffer.from(prv.slice(0, 12)).toString('hex'));
  let decoded = null;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(prv);
  } catch (e) { decoded = null; }
  ok(decoded !== null && decoded.length > 0, '산출물 미리보기 글이 UTF-8 로 읽힌다', decoded);
  ok(recs.some((r) => r.name === 'Preview/PrvText.txt'), '미리보기 글 항목이 있다');
}

/* ───────── 4. 표지 뗀 산출물 ───────── */
head('표지 뗀 산출물 — stripFront');
{
  const stripped = await stripFront(built.bytes, form.section);
  /* 표지 구역과 그 바탕쪽은 일부러 뺀 것이라 빠져도 된다 */
  sameShape(stripped, '표지 뗀 산출물', {
    allowMissing: ['Contents/section0.xml', 'Contents/section1.xml',
      'Contents/masterpage0.xml', 'Contents/masterpage1.xml', 'Contents/section2.xml'],
  });
  const z = await unzip(stripped);
  ok(z.has('Contents/section0.xml') && !z.has('Contents/section2.xml'),
    '본문 구역이 section0 으로 앞당겨졌다');
  /* 이름이 바뀐 본문 구역도 원본 section2 와 같은 꼴이어야 한다 */
  const rec = records(stripped).find((r) => r.name === 'Contents/section0.xml');
  ok(rec && shape(rec) === baseShape.get(form.section),
    '이름 바뀐 본문 구역의 꼴이 원래 본문 구역과 같다',
    rec && `${shape(rec)}\n        기준 ${baseShape.get(form.section)}`);
}

/* ───────── 5. 그림이 박힌 산출물 ───────── */
head('그림이 박힌 산출물');
{
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR42mP8z8BQz0AEYBxVSF+F'
    + 'ABJ2AwHpDIhaAAAAAElFTkSuQmCC', 'base64');
  const text = SAMPLE + '\n\n![](chart.png)\n';
  const withImg = await buildForm(tplBytes, form, text,
    { images: new Map([['chart.png', new Uint8Array(png)]]) });
  const recs = sameShape(withImg.bytes, '그림 산출물');
  const added = recs.filter((r) => r.name.startsWith('BinData/') && !baseShape.has(r.name));
  ok(added.length === 1, `새 그림 항목 ${added.length}개`);
  const kin = baseRecs.find((r) => r.name.startsWith('BinData/'));
  ok(added[0] && shape(added[0]) === shape(kin),
    '새 그림 항목이 원본 BinData 항목과 같은 꼴이다',
    added[0] && `${shape(added[0])}\n        형제 ${shape(kin)}`);
}

/* ───────── 6. 내부 참조 ───────── */
head('내부 참조');
{
  const targets = [
    ['절 산출물', built.bytes],
    ['표지 뗀 산출물', await stripFront(built.bytes, form.section)],
  ];
  for (const [label, bytes] of targets) {
    const z = await unzip(bytes);
    const names = new Set(z.keys());
    const dec = (n) => new TextDecoder().decode(z.get(n));
    const hpf = dec('Contents/content.hpf');
    const lostHpf = [...hpf.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
      .filter((h) => !names.has(h));
    ok(lostHpf.length === 0, `${label} — 매니페스트가 없는 파일을 가리키지 않는다`, lostHpf.join(', '));
    const rdf = dec('META-INF/container.rdf');
    const lostRdf = [...rdf.matchAll(/rdf:resource="([^"]+)"/g)].map((m) => m[1])
      .filter((r) => r.startsWith('Contents/') && !names.has(r));
    ok(lostRdf.length === 0, `${label} — 메타가 없는 파일을 가리키지 않는다`, lostRdf.join(', '));
    ok(new TextDecoder().decode(z.get('mimetype')) === 'application/hwp+zip',
      `${label} — mimetype 내용`);
  }
}

}

console.log(`\n검사 ${checks}건 · 실패 ${fails}건`);
if (fails) process.exitCode = 1;
