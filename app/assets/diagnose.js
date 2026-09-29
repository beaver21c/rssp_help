/**
 * 올린 hwpx가 성한가 — 「손상된 파일」의 책임 소재를 가른다.
 *
 * 한글이 문서를 열지 못할 때 원인은 세 자리 중 하나다.
 *   ① 만들 때부터 잘못 만들었다
 *   ② 만든 뒤 옮기는 사이에 상했다(내려받기가 끊김·백신이 손댐·동기화 폴더)
 *   ③ 바이트는 성한데 한글 쪽에서 못 연다
 * 이 셋은 화면 밖에서는 구별되지 않는다. 담당자는 「손상된 파일」이라는 말만 본다.
 *
 * 그래서 파일을 받아 zip 켜켜이 뜯어 보고 무엇이 성하고 무엇이 깨졌는지 적는다.
 * **우리가 만든 파일을 다시 올렸을 때 여기서 성하다고 나오면 ①·②가 아니다.**
 *
 * 판정은 우리 unzip()에 기대지 않고 zip 레코드를 직접 읽는다. 읽는 규칙이 우리
 * 것이면 우리가 만든 잘못은 드러나지 않기 때문이다.
 */
"use strict";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** CRC-32. zip이 적어 둔 값과 맞춰 본다. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i += 1) c = TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** hwpx 한 벌이 갖춰야 할 것. 없으면 한글이 열지 못한다. */
const MUST = ['mimetype', 'version.xml', 'Contents/header.xml', 'Contents/content.hpf',
  'META-INF/container.xml'];

/**
 * @returns {{ok, fatal, lines, entries}} — `ok`면 바이트가 성하다는 뜻.
 *   lines 는 화면에 그대로 뿌릴 `{lv, msg}` 목록.
 */
export async function diagnose(bytes) {
  const lines = [];
  const add = (lv, msg) => lines.push({ lv, msg });
  const b = new Uint8Array(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);

  add('info', `파일 크기 ${b.length.toLocaleString('ko-KR')}바이트`);

  if (b.length < 100) {
    add('err', '파일이 너무 작다 — 내려받다 끊겼거나 빈 파일이다');
    return { ok: false, fatal: true, lines, entries: [] };
  }

  /* 끝 레코드 — 내려받다 끊기면 여기부터 사라진다 */
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i -= 1) {
    if (v.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) {
    add('err', 'zip 끝 레코드가 없다 — 파일이 **뒤가 잘린 채** 저장됐다. '
      + '내려받다 끊겼거나(저장 위치를 고르는 사이 중단) 백신·동기화 폴더가 가로챈 것이다');
    return { ok: false, fatal: true, lines, entries: [] };
  }

  const count = v.getUint16(eocd + 10, true);
  const cdOff = v.getUint32(eocd + 16, true);
  const cdSize = v.getUint32(eocd + 12, true);
  if (cdOff + cdSize > b.length) {
    add('err', `가운데 목록이 파일 밖을 가리킨다(${cdOff + cdSize} > ${b.length}) — 앞부분이 잘렸다`);
    return { ok: false, fatal: true, lines, entries: [] };
  }

  /* 항목을 하나씩 뜯어 CRC까지 맞춰 본다 */
  const entries = [];
  const broken = [];
  let o = cdOff;
  for (let i = 0; i < count; i += 1) {
    if (v.getUint32(o, true) !== SIG_CENTRAL) {
      add('err', `가운데 목록 ${i + 1}번째가 깨졌다 — 파일 가운데가 상했다`);
      return { ok: false, fatal: true, lines, entries };
    }
    const method = v.getUint16(o + 10, true);
    const crc = v.getUint32(o + 16, true);
    const csize = v.getUint32(o + 20, true);
    const usize = v.getUint32(o + 24, true);
    const nlen = v.getUint16(o + 28, true);
    const elen = v.getUint16(o + 30, true);
    const clen = v.getUint16(o + 32, true);
    const lho = v.getUint32(o + 42, true);
    const name = new TextDecoder().decode(b.subarray(o + 46, o + 46 + nlen));

    if (v.getUint32(lho, true) !== SIG_LOCAL) {
      broken.push(`${name}(자리표 없음)`);
    } else {
      const ln = v.getUint16(lho + 26, true);
      const le = v.getUint16(lho + 28, true);
      const start = lho + 30 + ln + le;
      if (start + csize > b.length) {
        broken.push(`${name}(내용이 파일 밖)`);
      } else {
        const raw = b.subarray(start, start + csize);
        try {
          const data = method === 0 ? raw : await inflateRaw(raw);
          if (data.length !== usize) broken.push(`${name}(크기 어긋남)`);
          else if (crc32(data) !== crc) broken.push(`${name}(내용이 바뀜)`);
          else entries.push({ name, size: usize, method });
        } catch (e) {
          broken.push(`${name}(펴지지 않음)`);
        }
      }
    }
    o += 46 + nlen + elen + clen;
  }

  add('info', `항목 ${count}개 가운데 ${entries.length}개가 성하다`);
  if (broken.length) {
    add('err', `상한 항목 ${broken.length}개 — ${broken.slice(0, 5).join(', ')}`
      + (broken.length > 5 ? ' 등' : ''));
    add('err', '내용이 바뀌거나 잘렸다. **만든 뒤 옮기는 사이에 상한 것**이다 — '
      + '내려받기 중단·백신 검사·동기화 폴더(원드라이브·구글드라이브)를 확인할 것');
    return { ok: false, fatal: true, lines, entries };
  }

  /* 한글이 찾는 파일이 다 있는가 */
  const have = new Set(entries.map((e) => e.name));
  const miss = MUST.filter((m) => !have.has(m));
  if (miss.length) {
    add('err', `한글이 찾는 파일이 없다 — ${miss.join(', ')}`);
    return { ok: false, fatal: true, lines, entries };
  }

  const mime = entries[0];
  if (!mime || mime.name !== 'mimetype' || mime.method !== 0) {
    add('err', 'mimetype 이 맨 앞·무압축이 아니다 — 한글이 hwpx 로 알아보지 못한다');
    return { ok: false, fatal: true, lines, entries };
  }

  const body = [...have].filter((n) => /^Contents\/section\d+\.xml$/.test(n));
  add('info', `본문 구역 ${body.length}개 (${body.sort().join(', ')})`);

  add('ok', '**이 파일의 바이트는 성하다.** zip 구조·CRC·필수 항목이 모두 맞는다. '
    + '그래도 한글이 열지 못한다면 파일이 오는 길이 아니라 여는 쪽을 봐야 한다 — '
    + '한글 판(2018 이상 권장)·보안 프로그램의 문서 검사 설정을 확인할 것');
  return { ok: true, fatal: false, lines, entries };
}
