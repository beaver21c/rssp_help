/**
 * 최소 ZIP 읽기·쓰기.
 *
 * hwpx는 zip이다. 외부 라이브러리 없이 브라우저 내장 CompressionStream /
 * DecompressionStream('deflate-raw')만으로 처리한다.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function streamThrough(bytes, stream) {
  const input = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(input).arrayBuffer());
}

const inflateRaw = (bytes) => streamThrough(bytes, new DecompressionStream('deflate-raw'));
const deflateRaw = (bytes) => streamThrough(bytes, new CompressionStream('deflate-raw'));

/**
 * ZIP 바이트 → Map<파일명, Uint8Array>. 순서를 보존한다.
 *
 * 돌려주는 Map에는 `frames`가 함께 달려 온다(열거되지 않는 속성).
 * 항목마다 압축 방식·플래그·만든 판·속성·시각을 담은 Map<이름, 틀>이다.
 * hwpx를 다시 쓸 때 이 틀을 그대로 넘겨야 원본과 같은 꼴이 나온다 — 한글은
 * 제 손으로 쓴 것과 다른 꼴을 만나면 문서를 열지 않는 일이 있다.
 */
export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End of central directory 찾기(뒤에서부터)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 형식이 아닙니다');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map();
  const frames = new Map();

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('중앙 디렉터리 손상');
    const vmade = view.getUint16(offset + 4, true);
    const method = view.getUint16(offset + 10, true);
    const time = view.getUint16(offset + 12, true);
    const date = view.getUint16(offset + 14, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const eattr = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    files.set(name, method === 0 ? raw.slice() : await inflateRaw(raw));
    frames.set(name, { method, vmade, time, date, eattr });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  /* 열거되지 않게 달아 둔다 — `new Map(files)`로 베끼는 쪽이 모르는 사이에
     틀까지 나르려 하면 오히려 헷갈린다. 필요한 쪽이 `.frames`를 명시로 넘긴다 */
  Object.defineProperty(files, 'frames', { value: frames, enumerable: false });
  return files;
}

//: 일반 목적 비트 11. 이름에 아스키 밖 글자가 있을 때만 켠다.
//  원본 hwpx는 이름이 모두 아스키라 플래그가 0이다. 늘 켜 두면 한글이 제 손으로
//  쓴 파일과 꼴이 달라진다. 압축 방식 비트(1~2)는 우리가 만든 deflate 스트림과
//  무관하므로 원본 값을 물려받지 않고 0으로 둔다.
const UTF8_NAMES = 0x0800;
const ASCII_ONLY = /^[\x20-\x7e]*$/;

/** 틀이 없는 새 항목에 쓸 기본값. 같은 꾸러미의 첫 항목에서 빌려 온다. */
function defaultFrame(frames) {
  for (const fr of frames.values()) {
    return { method: 8, vmade: fr.vmade, time: fr.time, date: fr.date, eattr: fr.eattr };
  }
  return null;
}

/** 새로 들어온 항목이 따를 틀. 같은 갈래(BinData 등) 형제가 있으면 그쪽을 따른다. */
function frameFor(name, frames, dflt) {
  const own = frames.get(name);
  if (own) return own;
  const slash = name.indexOf('/');
  if (slash > 0) {
    const dir = name.slice(0, slash + 1);
    for (const [other, fr] of frames) {
      if (other !== name && other.startsWith(dir)) return { ...fr };
    }
  }
  return dflt;
}

/**
 * Map<파일명, Uint8Array|string> → ZIP 바이트.
 *
 * 두 번째 인자
 *   배열            — 무압축으로 둘 이름 목록(기존 방식). 기본 `['mimetype']`
 *   {stored, frames}— frames는 `unzip()`이 준 틀. 주면 항목마다 원본과 같은
 *                     압축 방식·만든 판·속성·시각으로 쓴다
 *
 * hwpx는 mimetype이 **무압축으로 맨 앞**에 있어야 한다. 그 밖의 항목도 원본 틀을
 * 그대로 물려주어야 한글이 제 파일로 알아본다.
 */
export async function zip(files, opts = ['mimetype']) {
  const o = Array.isArray(opts) ? { stored: opts } : (opts || {});
  const stored = o.stored || ['mimetype'];
  const frames = o.frames instanceof Map ? o.frames : null;
  const dflt = frames ? defaultFrame(frames) : null;

  const encoder = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of files) {
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const nameBytes = encoder.encode(name);
    const fr = frames ? frameFor(name, frames, dflt) : null;
    /* mimetype은 어떤 틀이 오든 무압축이어야 한다 */
    const useStore = name === 'mimetype' || (fr ? fr.method === 0 : stored.includes(name));
    const body = useStore ? data : await deflateRaw(data);
    const method = useStore ? 0 : 8;
    const flag = ASCII_ONLY.test(name) ? 0 : UTF8_NAMES;
    const vmade = fr ? fr.vmade : 20;
    const time = fr ? fr.time : 0;
    const date = fr ? fr.date : 0x21;     // 1980-01-01
    const eattr = fr ? fr.eattr : 0;
    const sum = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, flag, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, vmade, true);         // version made by
    dv.setUint16(6, 20, true);            // version needed
    dv.setUint16(8, flag, true);
    dv.setUint16(10, method, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, sum, true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, data.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(38, eattr, true);        // external attributes
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);

    locals.push(local, body);
    central.push(dir);
    offset += local.length + body.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...central, end];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}
