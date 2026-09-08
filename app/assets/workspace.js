/**
 * 작업 폴더 — 산출물을 사용자가 정한 로컬 폴더에 바로 쓰고, 그 폴더에서 앞선 절을 읽는다.
 *
 * File System Access API(`showDirectoryPicker`)를 쓴다. 폴더 핸들을 IndexedDB에 담아 두므로
 * 다시 들어와도 같은 폴더를 이어 쓴다(권한만 한 번 다시 묻는다). 파일은 브라우저 밖으로
 * 나가지 않는다 — 사용자가 고른 폴더에 직접 쓴다.
 *
 * 이 기능은 크로미움 계열에만 있다. 없으면 `supported()`가 거짓을 돌려주고, 쓰는 쪽은
 * 종전대로 내려받기로 물러난다. 기능이 없다고 화면이 멈추면 안 된다.
 */
"use strict";

const DB = 'rssp_ws';
const STORE = 'handles';
const KEY = 'outdir';

/** 이 브라우저에서 폴더 지정이 되는가. */
export function supported() {
  return typeof globalThis.showDirectoryPicker === 'function'
    && typeof globalThis.indexedDB !== 'undefined';
}

// ──────────────────────────────────────────────────────────────
// IndexedDB — 폴더 핸들 하나만 담는다(핸들은 JSON으로 못 바꾸니 구조적 복제로 저장)
// ──────────────────────────────────────────────────────────────
function openDb() {
  return new Promise((done, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => done(req.result);
    req.onerror = () => fail(new Error('브라우저 저장소를 열지 못했다.'));
  });
}

function tx(db, mode, fn) {
  return new Promise((done, fail) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => done(req && req.result);
    t.onerror = () => fail(new Error('브라우저 저장소를 읽고 쓰지 못했다.'));
  });
}

async function keep(handle) {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.put(handle, KEY));
  db.close();
}

async function recall() {
  const db = await openDb();
  const got = await tx(db, 'readonly', (s) => s.get(KEY));
  db.close();
  return got || null;
}

async function drop() {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.delete(KEY));
  db.close();
}

// ──────────────────────────────────────────────────────────────
// 폴더
// ──────────────────────────────────────────────────────────────
let dir = null;

/** 지금 잡혀 있는 폴더 핸들(없으면 null). */
export const current = () => dir;

/** 폴더 이름. 없으면 빈 문자열. */
export const folderName = () => (dir && dir.name) || '';

/** 권한 상태를 본다. 'granted' | 'prompt' | 'denied' | '' */
async function permOf(handle, ask) {
  if (!handle || typeof handle.queryPermission !== 'function') return '';
  const opt = { mode: 'readwrite' };
  let st = await handle.queryPermission(opt);
  if (st !== 'granted' && ask && typeof handle.requestPermission === 'function') {
    st = await handle.requestPermission(opt);
  }
  return st;
}

/**
 * 폴더를 고르게 한다. **사용자 클릭 안에서만** 부를 수 있다(브라우저 규칙).
 * 돌려주는 값은 폴더 이름. 사용자가 취소하면 빈 문자열.
 */
export async function pick() {
  if (!supported()) throw new Error('이 브라우저는 폴더 지정을 지원하지 않는다. 크롬·엣지에서 쓸 것.');
  let handle;
  try {
    handle = await globalThis.showDirectoryPicker({ id: 'rssp', mode: 'readwrite' });
  } catch (e) {
    if (e && e.name === 'AbortError') return '';       // 사용자가 취소한 것은 오류가 아니다
    throw e;
  }
  if ((await permOf(handle, true)) !== 'granted') {
    throw new Error('폴더에 쓸 권한을 받지 못했다.');
  }
  dir = handle;
  try { await keep(handle); } catch (e) { /* 기억하지 못해도 이번 판은 쓸 수 있다 */ }
  return folderName();
}

/**
 * 지난번 폴더를 되살린다. 권한이 남아 있으면 바로 쓰고, 다시 물어야 하면 알린다.
 * 돌려주는 값 { name, need } — need가 참이면 사용자가 한 번 눌러 줘야 한다.
 */
export async function restore() {
  if (!supported()) return { name: '', need: false };
  let handle = null;
  try { handle = await recall(); } catch (e) { return { name: '', need: false }; }
  if (!handle) return { name: '', need: false };
  const st = await permOf(handle, false);
  if (st === 'granted') { dir = handle; return { name: handle.name, need: false }; }
  if (st === 'denied') { try { await drop(); } catch (e) { /* 지우지 못해도 그만 */ } return { name: '', need: false }; }
  return { name: handle.name, need: true, handle };
}

/** 되살릴 때 권한을 다시 받는다. 사용자 클릭 안에서 부를 것. */
export async function grant(handle) {
  const h = handle || (await recall());
  if (!h) return '';
  if ((await permOf(h, true)) !== 'granted') throw new Error('폴더 권한을 받지 못했다.');
  dir = h;
  return h.name;
}

/** 폴더를 놓는다(파일은 건드리지 않는다). */
export async function forget() {
  dir = null;
  try { await drop(); } catch (e) { /* 저장소가 막혀 있어도 이번 판은 놓은 것으로 친다 */ }
}

// ──────────────────────────────────────────────────────────────
// 파일
// ──────────────────────────────────────────────────────────────
function needDir() {
  if (!dir) throw new Error('작업 폴더가 지정되지 않았다.');
  return dir;
}

/** 파일 이름으로 못 쓰는 글자를 걷어낸다. */
export const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 90);

/** 바이트를 폴더에 쓴다. 같은 이름이 있으면 덮어쓴다. */
export async function saveFile(name, bytes) {
  const d = needDir();
  const fh = await d.getFileHandle(safeName(name), { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(bytes);
  } finally {
    await w.close();
  }
  return safeName(name);
}

/** 폴더 안 파일 목록. 숨김 장부(_로 시작)는 빼고 이름순으로 준다. */
export async function listFiles(ext) {
  const d = needDir();
  const out = [];
  for await (const [name, h] of d.entries()) {
    if (h.kind !== 'file' || name.startsWith('.') || name.startsWith('_')) continue;
    if (ext && !name.toLowerCase().endsWith(ext)) continue;
    let size = 0;
    let at = 0;
    try {
      const f = await h.getFile();
      size = f.size;
      at = f.lastModified;
    } catch (e) { /* 못 읽는 파일은 크기 없이 목록에만 둔다 */ }
    out.push({ name, size, at });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 폴더 안 파일을 바이트로 읽는다. */
export async function readFile(name) {
  const d = needDir();
  const fh = await d.getFileHandle(name);
  const f = await fh.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

/** 장부(JSON)를 읽는다. 없거나 깨졌으면 기본값. */
export async function readJson(name, dflt) {
  try {
    const bytes = await readFile(name);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return dflt;
  }
}

/** 장부(JSON)를 쓴다. */
export async function writeJson(name, obj) {
  const text = JSON.stringify(obj, null, 2);
  return saveFile(name, new TextEncoder().encode(text));
}
