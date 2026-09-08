/**
 * 사용자 개인 Gemini API 키로 하는 LLM 호출.
 *
 * kihasa-indicator-new의 static/assets/nlq.js에 있던 키 보관·모델 정렬·폴백 로직을
 * 그대로 물려받되, 화면은 건드리지 않는다. 여기서 내보내는 것은 순수 함수와
 * 비동기 함수뿐이고 DOM·전역 상태 표시는 이 모듈을 쓰는 쪽이 맡는다.
 *
 * 키는 브라우저 저장소에만 둔다. 서버로 보내지 않고 URL에도 싣지 않으며
 * 오직 x-goog-api-key 헤더로만 나간다(주소창·리퍼러·프록시 로그에 남지 않게).
 * 지표 값 데이터는 이 경로로 나가지 않는다. 나가는 것은 사용자 입력·첨부파일·절 지시문뿐이다.
 */
"use strict";

export const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** 429(할당량 초과)를 만났을 때 다음 모델로 넘어가기 전 쉬는 시간. */
export const RETRY_MS = 2000;

/** 모델 목록이 비었을 때 기대 볼 이름들. 무료 티어에서 대개 살아 있다. */
export const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

/** 이름만 보고 걸러 내는 모델. 실험·미리보기·음성·그림·임베딩 계열은 원고 생성에 안 맞는다. */
const SKIP_RE = /exp|experimental|preview|tts|image|embed|live|audio|thinking/i;

const KEY_NAME = 'gemini_key';

// ──────────────────────────────────────────────────────────────
// 주입 지점 — 시험에서는 가짜 fetch·즉시 반환 sleep을 꽂는다
// ──────────────────────────────────────────────────────────────
let fetchImpl = null;
let sleepImpl = null;

/** fetch 구현을 갈아 끼운다. null을 주면 globalThis.fetch로 되돌린다. */
export function setFetch(fn) {
  fetchImpl = typeof fn === 'function' ? fn : null;
}

/** 대기 함수를 갈아 끼운다(시험에서 0초로 만들기 위함). */
export function setSleep(fn) {
  sleepImpl = typeof fn === 'function' ? fn : null;
}

function pickFetch(deps) {
  const fn = (deps && deps.fetchImpl) || fetchImpl || globalThis.fetch;
  if (typeof fn !== 'function') throw new Error('fetch를 쓸 수 없다. setFetch로 구현을 넣을 것.');
  return fn;
}

function pickSleep(deps) {
  return (deps && deps.sleep) || sleepImpl
    || ((ms) => new Promise((done) => setTimeout(done, ms)));
}

// ──────────────────────────────────────────────────────────────
// 키 보관 — 저장소가 없는 환경(Node)에서도 죽지 않게 감싼다
// ──────────────────────────────────────────────────────────────
/** 저장소가 아예 없을 때 대신 쓰는 자리. 프로세스가 살아 있는 동안만 남는다. */
const memory = { local: '', session: '' };
let memoryOnly = false;

function store(kind) {
  try {
    const s = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    if (!s || typeof s.getItem !== 'function') return null;
    return s;
  } catch (e) {
    // 사생활 보호 모드나 저장소 차단 설정이면 접근 자체가 튄다. 조용히 메모리로 간다.
    return null;
  }
}

function readSlot(kind) {
  const s = store(kind);
  if (!s) { memoryOnly = true; return memory[kind] || ''; }
  try {
    return s.getItem(KEY_NAME) || '';
  } catch (e) {
    memoryOnly = true;
    return memory[kind] || '';
  }
}

function writeSlot(kind, value) {
  memory[kind] = value || '';
  const s = store(kind);
  if (!s) { memoryOnly = true; return; }
  try {
    if (value) s.setItem(KEY_NAME, value);
    else s.removeItem(KEY_NAME);
  } catch (e) {
    memoryOnly = true;
  }
}

/** 저장소가 막혀 메모리에만 키가 있는 상태인가. 화면에서 경고를 띄울 때 쓴다. */
export function storageBlocked() {
  return memoryOnly;
}

/** 설정된 키. 없으면 빈 문자열. session이 local보다 앞선다(nlq.js와 같다). */
export function getKey() {
  return readSlot('session') || readSlot('local') || '';
}

/** 키를 어디에 두고 있는지. 'local'=이 브라우저에 저장 / 'session'=이 탭에서만 / ''=없음. */
export function keyScope() {
  if (readSlot('local')) return 'local';
  if (readSlot('session')) return 'session';
  return '';
}

/** 키 설정. persist=true면 localStorage, 아니면 sessionStorage. 빈 값이면 지운다. */
export function setKey(key, persist) {
  writeSlot('session', '');
  writeSlot('local', '');
  const k = String(key || '').trim();
  if (k) writeSlot(persist ? 'local' : 'session', k);
  clearModelCache();
}

function needKey(key) {
  const k = String(key || '').trim() || getKey();
  if (!k) throw new Error('Gemini API 키가 없다. 먼저 키를 설정할 것.');
  return k;
}

/** 키는 헤더로만 보낸다. */
const authHeader = (key) => ({ 'x-goog-api-key': key });

// ──────────────────────────────────────────────────────────────
// 모델 목록·우선순위
// ──────────────────────────────────────────────────────────────
/**
 * 정렬 기준값 [flash 여부, 버전, lite 역순].
 * 무료 티어에서는 flash 계열이 한도가 넉넉하니 앞세우고,
 * 같은 계열이면 버전이 높은 것을, 동버전이면 lite가 아닌 쪽을 앞에 둔다.
 */
export function rankModel(name) {
  const n = String(name || '');
  const v = n.match(/(\d+)\.(\d+)/) || [0, 0, 0];
  const ver = (+v[1]) * 100 + (+v[2]);
  const lite = n.includes('lite') ? 1 : 0;
  return [n.includes('flash') ? 1 : 0, ver, -lite];
}

const byRank = (a, b) => {
  const x = rankModel(a);
  const y = rankModel(b);
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

/** 이름 목록을 계약대로 걸러 내고 정렬한다. 순수 함수라 시험에서 바로 부를 수 있다. */
export function orderModels(names) {
  const all = (names || [])
    .map((n) => String(n || '').replace(/^models\//, ''))
    .filter((n) => n && !SKIP_RE.test(n));
  const flash = all.filter((n) => n.includes('flash')).sort(byRank);
  const rest = all.filter((n) => !n.includes('flash'));
  return [...flash, ...rest];
}

let modelCache = null;   // { key, models }

/** 모델 목록 캐시를 버린다. 키를 바꾸면 자동으로 불린다. */
export function clearModelCache() {
  modelCache = null;
}

/**
 * 쓸 수 있는 모델 이름 목록. generateContent를 지원하는 것만 남기고 flash 계열을 앞세운다.
 * 같은 키로 두 번째 부르면 캐시를 준다.
 */
export async function listModels(key, deps) {
  const k = needKey(key);
  if (modelCache && modelCache.key === k) return modelCache.models;
  const doFetch = pickFetch(deps);
  const r = await doFetch(`${BASE}/models?pageSize=1000`, { headers: authHeader(k) });
  if (!r.ok) throw await httpError(r);
  const j = await r.json();
  const usable = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name);
  let models = orderModels(usable);
  if (!models.length) models = [...FALLBACK_MODELS];
  modelCache = { key: k, models };
  return models;
}

/** 응답 본문에서 구글이 준 사유를 캐낸다. 못 캐면 상태 코드만 남긴다. */
async function httpError(r) {
  let msg = `HTTP ${r.status}`;
  try {
    const j = await r.json();
    msg = (j && j.error && j.error.message) || msg;
  } catch (e) { /* 본문이 JSON이 아니면 상태 코드로 만족한다 */ }
  const e = new Error(msg);
  e.status = r.status;
  return e;
}

/** 키 자체가 잘못된 경우인가. 이러면 다른 모델로 넘어가 봐야 똑같이 막힌다. */
const isKeyFault = (msg) => /api key|permission|expired/i.test(String(msg || ''));

// ──────────────────────────────────────────────────────────────
// 요청 본문
// ──────────────────────────────────────────────────────────────
function fileParts(files) {
  return (files || []).map((f, i) => {
    const mime = f && (f.mimeType || f.mime_type);
    const data = f && f.data;
    if (!mime || !data) throw new Error(`첨부 ${i + 1}번에 mimeType이나 data가 없다.`);
    return { inline_data: { mime_type: mime, data } };
  });
}

/**
 * 요청 본문을 만든다. 텍스트 파트가 항상 먼저 오고 첨부는 그 뒤에 붙는다.
 * (모델이 지시문을 읽은 다음 자료를 보게 하려는 것이다.)
 */
export function buildBody(opts, useSchema) {
  const o = opts || {};
  const prompt = String(o.prompt == null ? '' : o.prompt);
  if (!prompt.trim() && !(o.files || []).length) throw new Error('보낼 프롬프트가 비었다.');
  const parts = [{ text: prompt }, ...fileParts(o.files)];
  const body = { contents: [{ role: 'user', parts }] };
  if (o.system) body.systemInstruction = { parts: [{ text: String(o.system) }] };
  const gen = { temperature: typeof o.temperature === 'number' ? o.temperature : 0.3 };
  if (o.json) gen.responseMimeType = 'application/json';
  if (o.json && o.schema && useSchema) gen.responseSchema = o.schema;
  if (typeof o.maxOutputTokens === 'number') gen.maxOutputTokens = o.maxOutputTokens;
  body.generationConfig = gen;
  return body;
}

/**
 * 첫 시도에 실제로 나가는 요청 본문의 바이트 수.
 * 어림짐작한 토큰 수가 아니라 잰 값이다. 화면에서 "이만큼 보낸다"를 보여 줄 때 쓴다.
 */
export function requestSize(opts) {
  const body = buildBody(opts, true);
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/** 응답에서 본문 텍스트만 이어 붙인다. */
export function answerText(j) {
  const parts = j && j.candidates && j.candidates[0]
    && j.candidates[0].content && j.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => p.text || '').join('');
}

// ──────────────────────────────────────────────────────────────
// 호출 — 429는 쉬었다 다음 모델, 404는 바로 다음 모델, 키 오류는 즉시 중단
// ──────────────────────────────────────────────────────────────
/**
 * opts = { system, prompt, files:[{mimeType,data}], temperature, json, schema, key, model }
 * deps = { fetchImpl, sleep }
 * 돌려주는 값 { model, text }.
 */
export async function generate(opts, deps) {
  const o = opts || {};
  const key = needKey(o.key);
  const doFetch = pickFetch(deps);
  const sleep = pickSleep(deps);
  const models = o.model ? [o.model] : await listModels(key, deps);
  const headers = { 'Content-Type': 'application/json', ...authHeader(key) };
  let last = null;

  for (const model of models) {
    // 응답 스키마를 안 받아 주는 구형 모델이 있어 400이면 스키마를 빼고 한 번 더 본다.
    const passes = (o.json && o.schema) ? [true, false] : [false];
    for (const useSchema of passes) {
      const body = JSON.stringify(buildBody(o, useSchema));
      let r;
      try {
        r = await doFetch(`${BASE}/models/${model}:generateContent`,
          { method: 'POST', headers, body });
      } catch (e) {
        last = e;               // 그물이 끊긴 것이니 이 모델은 접고 다음으로
        break;
      }
      if (r.ok) {
        const j = await r.json();
        return { model, text: answerText(j) };
      }
      last = await httpError(r);
      if (isKeyFault(last.message)) throw Object.assign(last, { fatal: true });
      if (last.status === 429) { await sleep(RETRY_MS); break; }
      if (last.status === 400 && useSchema) continue;
      break;                    // 404 등 — 다음 모델
    }
  }
  throw last || new Error('쓸 수 있는 모델이 없다.');
}

/**
 * 키가 살아 있는지만 본다. 모델 목록 호출이 통하면 정상으로 친다.
 * 돌려주는 값 { ok, models, model, scope, error }.
 */
export async function checkKey(key, deps) {
  try {
    const models = await listModels(key, deps);
    return { ok: true, models, model: models[0], scope: keyScope(), error: '' };
  } catch (e) {
    return { ok: false, models: [], model: '', scope: keyScope(), error: e.message };
  }
}
