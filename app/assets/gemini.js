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

import {
  bump, markExhausted, isExhausted, usable, setVerified as noteVerified,
} from './quota.js';

export const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** 429(할당량 초과)를 만났을 때 다음 모델로 넘어가기 전 쉬는 시간. */
export const RETRY_MS = 2000;

/**
 * 기본은 **flash-lite 계열 중 가장 높은 판**이다. 이름을 박지 않는다.
 *
 * 2026-09-08에 실제로 겪은 일 — `gemini-2.5-flash-lite`를 고정했더니 구글이
 * "no longer available to new users. Please update your code to use
 * models/gemini-3.5-flash-lite"라고 돌려줬다. 특정 이름을 기본으로 박아 두면
 * 구글이 판을 올릴 때마다 도구가 멈춘다. 그래서 계열만 정하고 판은 목록에서 고른다.
 * (정렬 규칙이 flash → 높은 판 → lite 차례이므로 목록 맨 앞이 곧 그 값이다.)
 */
export const DEFAULT_FAMILY = /flash-lite/i;

/**
 * 모델 목록 창구까지 막혔을 때만 쓰는 이름들. 무료 몫이 넉넉한 차례로 적되,
 * 여기 적힌 이름도 언제든 죽을 수 있다는 전제로 여러 개를 둔다.
 */
export const FALLBACK_MODELS = [
  'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash',
];

/** 이름만 보고 걸러 내는 모델. 실험·미리보기·음성·그림·임베딩 계열은 원고 생성에 안 맞는다. */
const SKIP_RE = /exp|experimental|preview|tts|image|embed|live|audio|thinking/i;

/**
 * 모델 이름에 허용하는 글자. 이름은 주소에 그대로 끼워 넣는 값이라
 * `/`·`?`·`&`·공백이 섞이면 경로나 쿼리스트링이 뒤틀린다(키가 주소로 새는 길이 열린다).
 * 실제 모델 이름은 전부 영숫자·점·밑줄·붙임표뿐이니 그 밖은 이름부터 물리친다.
 */
const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 이름 검사. 글자 종류만 보면 `..`가 통과해 상위 경로로 빠져나갈 수 있다
 * (`models/../evil?key=LEAK`처럼 구글이 준 오류 문구 안에 섞여 들어올 수 있는 값이다).
 * 그래서 첫 글자를 영숫자로 못박고 점 두 개를 따로 물리친다.
 */
const SAFE_MODEL = { test: (n) => SAFE_MODEL_RE.test(String(n)) && !String(n).includes('..') };

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
const memory = { local: '', session: '', pref: '' };
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
 * 정렬 기준값 [flash 여부, 버전, lite 여부].
 * 무료 등급에서 flash 계열이 한도가 넉넉하니 앞세우고, 같은 계열이면 버전이 높은 것을,
 * 동버전이면 **lite를 앞에** 둔다 — lite 쪽 하루 요청 수가 몇 배 크기 때문이다.
 * (유료로 쓰면서 품질을 앞세우고 싶으면 화면에서 [우선 모델]을 직접 고르면 된다.)
 */
export function rankModel(name) {
  const n = String(name || '');
  const v = n.match(/(\d+)\.(\d+)/) || [0, 0, 0];
  const ver = (+v[1]) * 100 + (+v[2]);
  const lite = n.includes('lite') ? 1 : 0;
  return [n.includes('flash') ? 1 : 0, ver, lite];
}

const byRank = (a, b) => {
  const x = rankModel(a);
  const y = rankModel(b);
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

/** 이름 목록을 계약대로 걸러 내고 정렬한다. 순수 함수라 시험에서 바로 부를 수 있다. */
export function orderModels(names) {
  const all = (Array.isArray(names) ? names : [])
    .map((n) => String(n || '').replace(/^models\//, ''))
    .filter((n) => n && SAFE_MODEL.test(n) && !SKIP_RE.test(n));
  const flash = all.filter((n) => n.includes('flash')).sort(byRank);
  const rest = all.filter((n) => !n.includes('flash'));
  return [...flash, ...rest];
}

/** 살아 있는 목록에서 기본으로 삼을 이름(가장 높은 판의 flash-lite). 없으면 빈 문자열. */
export function defaultModel(models) {
  return (Array.isArray(models) ? models : []).find((n) => DEFAULT_FAMILY.test(n)) || '';
}

/* 마지막으로 성공한 모델. 구글이 목록을 바꿔도 어제 되던 것부터 다시 해 본다.
   반대로 그 모델이 사라지면(404) 곧바로 버려서 묵은 이름에 매이지 않는다. */
const PREF_NAME = 'gemini_model';

export function getPreferred() {
  const s = store('local');
  if (!s) return memory.pref || '';
  try { return s.getItem(PREF_NAME) || memory.pref || ''; }
  catch (e) { return memory.pref || ''; }
}

export function setPreferred(name) {
  const one = String(name || '').replace(/^models\//, '');
  // 주소를 비틀 수 있는 이름은 기억하지 않는다(모델 이름은 URL 경로에 그대로 들어간다)
  const ok = one && SAFE_MODEL.test(one) ? one : '';
  memory.pref = ok;
  const s = store('local');
  if (!s) return;
  try {
    if (ok) s.setItem(PREF_NAME, ok);
    else s.removeItem(PREF_NAME);
  } catch (e) { /* 저장소가 막혀 있으면 메모리에만 둔다 */ }
}

let modelCache = null;   // { key, models }
let inflight = null;     // { key, promise } — 같은 키로 동시에 물으면 그물은 한 번만 탄다

/** 모델 목록 캐시를 버린다. 키를 바꾸면 자동으로 불린다. */
export function clearModelCache() {
  modelCache = null;
  inflight = null;
}

async function fetchModels(k, deps) {
  const doFetch = pickFetch(deps);
  const r = await doFetch(`${BASE}/models?pageSize=1000`, { headers: authHeader(k) });
  if (!r.ok) throw await httpError(r);
  const j = await readJson(r, '모델 목록');
  const listed = Array.isArray(j && j.models) ? j.models : [];
  const usable = listed
    .filter((m) => (Array.isArray(m && m.supportedGenerationMethods)
      ? m.supportedGenerationMethods : []).includes('generateContent'))
    .map((m) => m.name);
  const models = orderModels(usable);
  return models.length ? models : [...FALLBACK_MODELS];
}

/**
 * 쓸 수 있는 모델 이름 목록. generateContent를 지원하는 것만 남기고 flash 계열을 앞세운다.
 * 같은 키로 두 번째 부르면 캐시를 준다.
 */
export async function listModels(key, deps) {
  const k = needKey(key);
  if (modelCache && modelCache.key === k) return modelCache.models;
  if (inflight && inflight.key === k) return inflight.promise;
  const promise = fetchModels(k, deps).then(
    (models) => {
      modelCache = { key: k, models };
      if (inflight && inflight.promise === promise) inflight = null;
      return models;
    },
    (e) => {
      if (inflight && inflight.promise === promise) inflight = null;
      throw e;
    },
  );
  inflight = { key: k, promise };
  return promise;
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

/**
 * 계정의 선불 크레딧이 바닥난 경우인가. 이것도 계정 단위라 모델을 바꿔 봐야 똑같이 막힌다.
 * 모델별 일일 한도("You exceeded your current quota, please check your plan and billing
 * details")와는 다르다 — 그쪽은 다른 모델로 넘어가면 통할 때가 있으므로 여기 걸리면 안 된다.
 * 그래서 'billing'이라는 낱말이 아니라 크레딧 소진 문구만 집는다.
 */
const isBillingFault = (msg) => /prepay|credits?\s+(are|is)\s+depleted|out of credits/i
  .test(String(msg || ''));

/**
 * 429가 **하루 몫**을 다 쓴 것인가(분당 몫이 아니라).
 * 하루 몫이면 오늘은 그 모델이 끝난 것이라 장부에 적고 다시 두들기지 않는다.
 * 분당 몫이면 잠깐 쉬었다 가면 되므로 여기 걸리면 안 된다.
 */
const isDailyQuota = (msg) => /per\s*day|PerDay|requests_per_day|free_tier_requests/i
  .test(String(msg || ''));

/** 구글이 429 본문에 적어 준 한도 값(있을 때만). 관측값이라 우리 참고값보다 앞선다. */
function limitInMessage(msg) {
  const m = String(msg || '').match(/limit:\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}

/** 그 이름이 내려간 모델인가(신규 사용자 차단·지원 종료). */
const isRetired = (msg) => /no longer available|not available to new users|deprecated|discontinued/i
  .test(String(msg || ''));

/**
 * 구글이 오류 본문에서 대신 쓰라고 지목한 모델 이름.
 * 실제로 받은 문구 — "Please update your code to use models/gemini-3.5-flash-lite".
 * 이름을 그대로 주소에 넣을 값이라 SAFE_MODEL을 통과한 것만 받는다.
 */
export function replacementIn(msg) {
  const m = String(msg || '').match(/use\s+models\/([A-Za-z0-9._-]+)/i);
  const one = m ? m[1] : '';
  return one && SAFE_MODEL.test(one) && !SKIP_RE.test(one) ? one : '';
}

/**
 * 200이어도 본문이 JSON이 아닐 수 있다(프록시가 끼워 넣은 안내 쪽, 잘린 응답).
 * 날 SyntaxError를 그대로 흘리면 폴백 고리가 통째로 끊기니 한국어 사유로 바꿔 준다.
 */
async function readJson(r, what) {
  try {
    return await r.json();
  } catch (e) {
    throw new Error(`${what} 응답을 JSON으로 읽지 못했다.`);
  }
}

/** 빈 응답이 왔을 때 구글이 남긴 사유(안전 차단·길이 초과 등)를 캐낸다. */
function emptyReason(j) {
  const c = j && j.candidates && j.candidates[0];
  return (j && j.promptFeedback && j.promptFeedback.blockReason)
    || (c && c.finishReason) || '';
}

// ──────────────────────────────────────────────────────────────
// 요청 본문
// ──────────────────────────────────────────────────────────────
function fileParts(files) {
  if (files == null) return [];
  if (!Array.isArray(files)) throw new Error('첨부 목록(files)은 배열이어야 한다.');
  return files.map((f, i) => {
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
  const parts = [{ text: prompt }, ...fileParts(o.files)];
  if (!prompt.trim() && parts.length < 2) throw new Error('보낼 프롬프트가 비었다.');
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
  let models;
  if (o.model) {
    const one = String(o.model).replace(/^models\//, '');
    if (!SAFE_MODEL.test(one)) throw new Error(`모델 이름에 못 쓰는 글자가 있다: ${one}`);
    models = [one];
  } else {
    let listErr = null;
    try {
      models = await listModels(key, deps);
    } catch (e) {
      // 목록 창구가 막히거나 모양이 바뀌어도 멈추지 않는다. 아는 이름으로 밀어붙인다.
      if (isKeyFault(e && e.message)) throw Object.assign(e, { fatal: true });
      listErr = e;
      models = [...FALLBACK_MODELS];
    }
    // 어제 되던 모델을 맨 앞에 세운다(없어졌으면 아래 고리가 알아서 버린다)
    const pref = getPreferred();
    if (pref) models = [pref, ...models.filter((m) => m !== pref)];
    if (listErr) o._listError = listErr.message;
  }
  // 오늘 하루 몫을 이미 다 쓴 모델은 빼고 간다. 무료 등급에서 헛호출을 아끼고,
  // 남은 것이 없으면 여기서 조용히 끝낸다(작업 도중 몫이 떨어져도 스스로 멈추게).
  const left = usable(models);
  if (!left.length) {
    const e = new Error('오늘 쓸 수 있는 무료 몫을 다 썼다. 태평양 자정에 되돌아온다.');
    e.quota = true;
    e.fatal = true;
    e.spent = models.slice();
    throw e;
  }
  models = left;
  const headers = { 'Content-Type': 'application/json', ...authHeader(key) };
  let last = null;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const isLast = i === models.length - 1;
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
        bump(model);            // 200이면 하루 몫을 한 칸 쓴 것이다
        let j;
        try {
          j = await readJson(r, model);
        } catch (e) {
          last = e;             // 본문이 깨졌으면 이 모델은 접고 다음으로
          break;
        }
        const text = answerText(j);
        if (text) { setPreferred(model); return { model, text }; }
        // 200이어도 알맹이가 없으면 실패로 친다. 빈 원고를 성공이라고 넘기면
        // 화면에는 "완료"가 뜨고 상자만 비는 꼴이 된다.
        const why = emptyReason(j);
        last = new Error(`${model}이 빈 응답을 냈다${why ? ` (${why})` : ''}.`);
        break;
      }
      last = await httpError(r);
      if (isKeyFault(last.message)) throw Object.assign(last, { fatal: true });
      // 크레딧이 바닥난 것이면 다음 모델을 두들겨 봐야 똑같이 막힌다. 2초씩 쉬며
      // 목록 전체를 도는 헛수고 대신 곧바로 사유를 들고 나간다.
      if (isBillingFault(last.message)) throw Object.assign(last, { fatal: true, billing: true });
      // 없어진 이름을 계속 물고 있지 않는다
      if (last.status === 404 && model === getPreferred()) setPreferred('');
      // 내려간 모델이면 기억에서 지우고, 구글이 지목한 대체 이름을 그 자리에서 이어 붙인다
      if (isRetired(last.message)) {
        if (model === getPreferred()) setPreferred('');
        const next = replacementIn(last.message);
        last.retired = model;
        last.replacement = next;
        if (next && !models.includes(next) && !isExhausted(next)) models.push(next);
        break;
      }
      if (last.status === 429) {
        if (isDailyQuota(last.message)) {
          // 오늘 이 모델은 끝났다. 장부에 적어 두고 쉬지 않고 다음 모델로 간다.
          markExhausted(model, limitInMessage(last.message));
          last.quota = true;
          break;
        }
        // 분당 몫이면 잠깐 쉬었다 다음 모델로. 마지막이면 쉬어 봐야 헛기다림이다.
        if (!isLast) await sleep(RETRY_MS);
        break;
      }
      if (last.status === 400 && useSchema) continue;
      break;                    // 404 등 — 다음 모델
    }
  }
  if (last && o._listError) {
    last.message += ` (모델 목록도 받지 못했다: ${o._listError})`;
  }
  // 모든 모델이 하루 몫으로 막힌 것이면 그 사실을 분명히 해서 화면이 멈출 수 있게 한다
  if (last && last.quota && !usable(models).length) {
    last.fatal = true;
    last.message = `오늘 쓸 수 있는 무료 몫을 다 썼다 (${last.message})`;
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

/** 연결 확인에 쓰는 최소 프롬프트. 토큰을 거의 안 먹는다. */
export const PING = '연결 확인이다. 다른 말 없이 정확히 OK 라고만 답한다.';

/**
 * 키가 **실제로 원고를 만들 수 있는지**까지 본다.
 *
 * 목록 조회(checkKey)만으로는 두 가지를 못 걸러낸다.
 *   ① 목록은 되는데 generateContent만 막힌 키(결제·지역 제한)
 *   ② 구글이 모델 이름을 갈아 치워 우리가 아는 이름이 하나도 안 남은 경우
 * 그래서 여기서는 목록을 받아 본 뒤 진짜 생성 호출을 한 번 때려 본다.
 * 목록 창구가 막혀도 내장 이름으로 밀어붙이므로, 목록 실패가 곧 실패는 아니다.
 *
 * opts = { key, model }  — model을 주면 그 이름을 맨 앞에 세워 확인한다
 * 돌려주는 값 { ok, model, models, listed, listError, error, fatal, sample, scope }.
 */
export async function verifyKey(opts, deps) {
  const o = opts || {};
  const out = { ok: false, model: '', models: [], listed: false, listError: '',
    error: '', fatal: false, billing: false, quota: false, retired: '', replacement: '',
    switchedFrom: '', sample: '', scope: keyScope() };
  let key;
  try {
    key = needKey(o.key);
  } catch (e) {
    out.error = e.message;
    return out;
  }
  try {
    out.models = await listModels(key, deps);
    out.listed = true;
  } catch (e) {
    // 키가 거부됐거나 크레딧이 바닥난 것이면 생성도 볼 것 없다(둘 다 계정 단위).
    // 그 밖의 사유는 내장 목록으로 계속 간다.
    if (isKeyFault(e && e.message)) { out.error = e.message; out.fatal = true; return out; }
    if (isBillingFault(e && e.message)) {
      out.error = e.message; out.fatal = true; out.billing = true; return out;
    }
    out.models = [...FALLBACK_MODELS];
    out.listError = e.message;
  }
  try {
    const r = await generate(
      { key, model: o.model || '', prompt: PING, temperature: 0 }, deps);
    out.ok = true;
    out.model = r.model;
    // 고정해 둔 이름이 내려가 다른 모델이 답했으면 화면이 그 사실을 알 수 있게 한다
    if (o.model && r.model !== o.model.replace(/^models\//, '')) out.switchedFrom = o.model;
    out.sample = String(r.text || '').trim().slice(0, 40);
    // 오늘 이 키는 확인을 마쳤다. 다음에 페이지를 열 때 같은 몫을 또 쓰지 않는다.
    noteVerified(key);
  } catch (e) {
    out.error = e.message;
    out.fatal = !!e.fatal;
    out.billing = !!e.billing;
    out.quota = !!e.quota;
    out.retired = e.retired || '';
    out.replacement = e.replacement || '';
  }
  return out;
}
