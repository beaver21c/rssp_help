/* 판 번호와 폴더 쓰기 시험 — node tests/test_version.mjs
   시험 틀을 쓰지 않는다. 어긋나면 사유를 찍고 process.exitCode = 1로 끝낸다.

   왜 이 시험이 있나
     이 도구는 빌드 과정이 없어 `assets/*.js` 주소가 늘 같다. 브라우저가 그 파일을
     캐시에 쥐고 있으면 **새 판을 올려도 열어 둔 탭은 옛 코드를 돌린다.** 고치기 전
     코드로 만든 hwpx는 한글에서 「손상된 파일」이 되는데 화면에는 아무 표시가 없다.
     그래서 판 번호를 두 자리에 두고 어긋나면 알리기로 했고, 그 장치를 여기서 본다.

     폴더 쓰기도 같은 갈래의 사고를 낸다. 쓰다 어긋난 자리에서 `close()`를 부르면
     그때까지 쓴 만큼이 파일로 확정되어 **반쪽짜리 hwpx가 폴더에 남는다.**

   보는 것
     1. checkStale 이 옛 판·새 판·판정 불가를 가려내는가
     2. 개발판에서는 경고하지 않는가(진짜 경고를 무디게 만들지 않으려고)
     3. 배포 때 박는 자리가 실제로 박히는 꼴인가(pages.yml 의 sed 와 같은 규칙)
     4. saveFile 이 쓰기 실패에 abort 하고 반쪽 파일을 남기지 않는가
     5. 덜 기록되면 알아채고 치우는가
     6. 다시 쓸 때 옛 파일 꼬리가 남지 않는가 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD, checkStale } from '../app/assets/version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, 'app');

let fails = 0; let checks = 0;
const ok = (cond, msg, extra) => {
  checks += 1;
  if (cond) { console.log(`  통과 — ${msg}`); return true; }
  fails += 1;
  console.error(`  실패 — ${msg}${extra ? `\n      ${String(extra).slice(0, 400)}` : ''}`);
  return false;
};
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`);

/* ───────── 1. 판 비교 ───────── */
head('판 비교 (checkStale)');
{
  ok(BUILD === 'dev', `저장소의 BUILD 는 'dev' 다 (지금 ${BUILD})`,
    '배포 때만 커밋 해시로 바뀐다. 저장소에 박아 두면 안 된다');

  /* 개발판에서는 판정하지 않는다 */
  let asked = 0;
  const r0 = await checkStale(async () => { asked += 1; return 'zzz'; });
  ok(r0.stale === false, '개발판에서는 옛 판이라고 하지 않는다');
  ok(asked === 0, '개발판에서는 올라간 판을 묻지도 않는다(쓸데없는 호출 없음)');
}

/* BUILD 가 박힌 뒤의 동작을 보려면 모듈을 다시 읽어야 한다.
   실제 배포가 하는 것과 같은 방식으로 바꿔 둔 사본을 만들어 읽는다. */
{
  const src = fs.readFileSync(path.join(APP, 'assets/version.js'), 'utf8');
  const stamped = src.replace(/^export const BUILD = '[^']*';/m,
    "export const BUILD = 'aaaa1111bbbb';");
  ok(stamped !== src, 'pages.yml 과 같은 규칙으로 판 번호가 박힌다',
    '정규식이 version.js 와 어긋나면 배포가 조용히 실패한다');
  ok(/^export const BUILD = 'aaaa1111bbbb';$/m.test(stamped), '박힌 줄의 꼴이 맞다');

  const tmp = path.join(HERE, 'out', '_version_stamped.mjs');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, stamped);
  const v = await import(`file://${tmp}?t=${Date.now()}`);

  ok(v.BUILD === 'aaaa1111bbbb', '박은 판 번호가 읽힌다');

  const same = await v.checkStale(async () => 'aaaa1111bbbb');
  ok(same.stale === false, '판이 같으면 조용하다');

  const diff = await v.checkStale(async () => 'cccc2222dddd');
  ok(diff.stale === true, '판이 다르면 옛 판이라고 알린다');
  ok(diff.here === 'aaaa1111bbbb' && diff.there === 'cccc2222dddd',
    '어느 판을 돌리고 어느 판이 올라갔는지 함께 준다', JSON.stringify(diff));

  const gone = await v.checkStale(async () => null);
  ok(gone.stale === false, '올라간 판을 못 받으면 판정하지 않는다(망 끊김에 겁주지 않는다)');

  const boom = await v.checkStale(async () => { throw new Error('망 끊김'); });
  ok(boom.stale === false, '조회가 던져도 화면을 막지 않는다');

  fs.rmSync(tmp, { force: true });
}

/* ───────── 2. 배포가 박을 자리가 실제로 있는가 ───────── */
head('배포 설정 (pages.yml)');
{
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8');
  ok(/app\/data\/build\.json/.test(yml), 'pages.yml 이 data/build.json 을 쓴다');
  ok(/app\/assets\/version\.js/.test(yml), 'pages.yml 이 assets/version.js 를 고친다');
  ok(/git rev-parse/.test(yml), '판 번호를 커밋 해시에서 얻는다');
  ok(/grep -q/.test(yml), '박히지 않으면 배포를 멈춘다(조용한 실패 금지)');

  const bj = JSON.parse(fs.readFileSync(path.join(APP, 'data/build.json'), 'utf8'));
  ok(bj.build === 'dev', `저장소의 build.json 도 'dev' 다 (지금 ${bj.build})`);

  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  ok(/id="stale"/.test(html), '옛 판 알림 띠가 화면에 있다');
  ok(/id="stale-go"/.test(html), '새로 고치는 단추가 있다');
  ok(/id="build"/.test(html), '지금 돌리는 판을 화면에 적는다');
  ok(/<div class="stalebar" id="stale" hidden>/.test(html), '평소에는 숨어 있다');

  const css = fs.readFileSync(path.join(APP, 'assets/style.css'), 'utf8');
  ok(/\.stalebar\{/.test(css) && /\.build\{/.test(css), '띠와 판 번호에 서식이 있다');
}

/* ───────── 3. 폴더 쓰기 ─────────
   File System Access API 가 없는 Node 라 같은 계약의 가짜 폴더를 만들어 건다. */
head('폴더 쓰기 (saveFile)');
{
  const ws = await import('../app/assets/workspace.js');

  /** 가짜 폴더. mode 로 실패를 만들어 넣는다. */
  function fakeDir(mode = 'ok') {
    const store = new Map();
    const log = [];
    return {
      store,
      log,
      async getFileHandle(name) {
        return {
          async createWritable() {
            let buf = null;                      // 새로 쓰기 시작하면 옛 내용은 버린다
            return {
              async write(b) {
                if (mode === 'throw') throw new Error('디스크가 가득 찼다');
                buf = mode === 'short' ? b.slice(0, Math.floor(b.length / 2)) : b;
              },
              async close() { log.push('close'); store.set(name, buf); },
              async abort() { log.push('abort'); },
            };
          },
          async getFile() {
            const b = store.get(name);
            return { size: b ? b.length : 0 };
          },
        };
      },
      async removeEntry(name) { log.push('remove'); store.delete(name); },
    };
  }

  const bytes = new Uint8Array(1000).fill(7);

  /* 정상 */
  let dir = fakeDir('ok');
  ws._setDir(dir);
  const put = await ws.saveFile('절.hwpx', bytes);
  ok(put === '절.hwpx', `이름 그대로 저장된다 (${put})`);
  ok(dir.store.get('절.hwpx').length === 1000, '쓴 만큼 들어간다');
  ok(dir.log.join(',') === 'close', '정상이면 close 만 부른다', dir.log.join(','));

  /* 쓰다 어긋남 — close 로 확정하면 안 된다 */
  dir = fakeDir('throw');
  ws._setDir(dir);
  let why = '';
  try { await ws.saveFile('절.hwpx', bytes); } catch (e) { why = e.message; }
  ok(/쓰지 못했다/.test(why), '실패를 사유와 함께 던진다', why);
  ok(/디스크가 가득 찼다/.test(why), '원래 사유를 잃지 않는다', why);
  ok(dir.log.includes('abort'), '닫지 않고 버린다(abort)', dir.log.join(','));
  ok(!dir.log.includes('close'), '실패한 자리에서 close 를 부르지 않는다', dir.log.join(','));
  ok(!dir.store.has('절.hwpx'), '반쪽 파일이 폴더에 남지 않는다');

  /* 오류 없이 덜 기록됨 */
  dir = fakeDir('short');
  ws._setDir(dir);
  why = '';
  try { await ws.saveFile('절.hwpx', bytes); } catch (e) { why = e.message; }
  ok(/덜 기록됐다/.test(why), '덜 기록되면 알아챈다', why);
  ok(/500\/1000/.test(why), '얼마나 들어갔는지 적는다', why);
  ok(/동기화 폴더/.test(why), '무엇을 확인할지 알려 준다', why);
  ok(!dir.store.has('절.hwpx'), '덜 기록된 파일도 치운다');

  /* 다시 쓰기 — 옛 꼬리가 남으면 안 된다 */
  dir = fakeDir('ok');
  ws._setDir(dir);
  await ws.saveFile('절.hwpx', new Uint8Array(3000).fill(1));
  await ws.saveFile('절.hwpx', new Uint8Array(1000).fill(2));
  ok(dir.store.get('절.hwpx').length === 1000,
    '작은 파일로 덮어써도 옛 꼬리가 남지 않는다', dir.store.get('절.hwpx').length);

  ws._setDir(null);
}

/* ───────── 4. 내려받기 ─────────
   Blob 주소를 일찍 거두면 파일이 끊겨 저장된다. 브라우저 설정이 「저장 위치 확인」이면
   사용자가 폴더를 고를 때까지 내려받기가 시작되지 않는데, 그 전에 거두면 브라우저가
   읽을 바이트를 잃는다. 코드에 그 실수가 다시 들어오지 못하게 막는다. */
head('내려받기 (app.js)');
{
  const app = fs.readFileSync(path.join(APP, 'assets/app.js'), 'utf8');

  const revokes = [...app.matchAll(/revokeObjectURL/g)].length;
  ok(revokes > 0, `주소를 거두기는 한다 (${revokes}자리)`);

  /* 짧은 시간 뒤 거두는 자리가 없어야 한다 */
  const soon = [...app.matchAll(/revokeObjectURL[\s\S]{0,80}?\}?,\s*(\d+)\)/g)]
    .map((m) => Number(m[1])).filter((n) => n < 60_000);
  ok(soon.length === 0, '1분 안에 거두는 자리가 없다', soon.join(', '));
  ok(/OBJECT_URL_TTL/.test(app), '거두는 시간을 한자리에 모아 두었다');
  ok(/pagehide/.test(app), '창을 닫을 때 한꺼번에 거둔다(새지 않게)');

  /* 내려받기는 한 함수로 모은다 — 자리마다 다르게 쓰다 하나만 어긋나는 것을 막는다 */
  const anchors = [...app.matchAll(/createElement\('a'\)/g)].length;
  ok(anchors === 1, `앵커를 만드는 자리가 하나다 (${anchors}자리)`, '내려받기는 saveAs 하나로');
  ok(/function saveAs\(/.test(app), 'saveAs 한 곳을 지난다');
  ok(!/a\.click\(\); a\.remove\(\)/.test(app),
    '클릭과 같은 틱에 앵커를 지우지 않는다');
  ok(/application\/octet-stream/.test(app),
    '무색 형식으로 넘긴다(브라우저·백신이 손대지 않게)');

  /* 크기를 알려 줘야 담당자가 끊긴 파일을 알아본다 */
  ok(/바이트/.test(app) && /toLocaleString/.test(app),
    '산출물의 정확한 바이트 수를 화면에 적는다');
}

/* ───────── 5. 파일 진단 ─────────
   「손상된 파일」의 책임 소재를 가르는 도구다. 우리가 만든 파일을 다시 올렸을 때
   성하다고 나오면 만든 잘못도 옮기다 상한 것도 아니라는 뜻이 된다. */
head('파일 진단 (diagnose)');
{
  const { diagnose } = await import('../app/assets/diagnose.js');
  const orig = new Uint8Array(fs.readFileSync(
    path.join(ROOT, 'source/제6기_지역사회보장계획_수립안내_시군구.hwpx')));
  const tpl = new Uint8Array(fs.readFileSync(path.join(APP, 'data/template.hwpx')));

  const g1 = await diagnose(orig);
  ok(g1.ok === true, '한글이 쓴 원본을 성하다고 본다');
  ok(g1.entries.length === 17, `원본 항목 ${g1.entries.length}개를 다 폈다`);
  const g2 = await diagnose(tpl);
  ok(g2.ok === true, '배포용 템플릿도 성하다고 본다');

  const cut = orig.slice(0, Math.floor(orig.length * 0.6));
  const c1 = await diagnose(cut);
  ok(c1.ok === false, '뒤가 잘린 파일을 잡아낸다');
  ok(c1.lines.some((l) => /끝 레코드가 없다/.test(l.msg)), '무엇이 없는지 짚는다');
  ok(c1.lines.some((l) => /내려받다 끊겼|백신|동기화/.test(l.msg)),
    '어디를 볼지 알려 준다(내려받기·백신·동기화 폴더)');

  const head_ = orig.slice(1000);
  ok((await diagnose(head_)).ok === false, '앞이 잘린 파일도 잡아낸다');

  const flip = orig.slice();
  flip[Math.floor(flip.length / 2)] ^= 0xff;
  const f1 = await diagnose(flip);
  ok(f1.ok === false, '가운데 한 바이트만 바뀌어도 잡아낸다(CRC 대조)');
  /* 뒤집힌 자리가 압축 항목이면 「펴지지 않음」, 무압축 항목이면 「내용이 바뀜」이다.
     둘 다 맞는 판정이므로 어느 쪽이든 **그 항목 이름을 대는지**를 본다 */
  ok(f1.lines.some((l) => /상한 항목 \d+개 — \S+\((내용이 바뀜|펴지지 않음|크기 어긋남)\)/.test(l.msg)),
    '상한 항목의 이름과 증상을 댄다', f1.lines.map((l) => l.msg).join(' | ').slice(0, 200));
  ok(f1.lines.some((l) => /옮기는 사이에 상한/.test(l.msg)), '만든 뒤 상했다고 짚는다');

  ok((await diagnose(new Uint8Array(0))).ok === false, '빈 파일');
  ok((await diagnose(new Uint8Array(500).fill(65))).ok === false, 'zip 이 아닌 파일');

  /* 우리 판정이 우리 unzip 에 기대면 우리 잘못이 드러나지 않는다 */
  const src = fs.readFileSync(path.join(APP, 'assets/diagnose.js'), 'utf8');
  ok(!/from '\.\/zip\.js'/.test(src),
    '진단은 우리 unzip() 을 쓰지 않는다(읽는 규칙이 우리 것이면 우리 잘못이 안 보인다)');
  ok(/crc32/.test(src), '내용이 바뀌었는지 CRC 로 대조한다');
}

console.log(`\n검사 ${checks}건 · 실패 ${fails}건`);
if (fails) process.exitCode = 1;
