/**
 * 무료 티어 사용량 장부.
 *
 * 무료 등급은 하루 요청 수(RPD)가 정해져 있고 그 몫은 **태평양 자정에 되돌아온다**.
 * 이 모듈은 ①오늘 몇 번 썼는지 ②어느 모델이 오늘 한도를 넘겼는지 ③언제 풀리는지를
 * 브라우저 저장소에 적어 둔다. 날짜가 바뀌면 장부는 저절로 새 장으로 넘어간다.
 *
 * 설계 원칙 — **적어 둔 한도 숫자를 믿지 않는다.**
 * 구글이 공지하는 무료 등급 한도는 바뀌고, 계정 등급에 따라도 다르다. 그래서
 *   · 화면에 보여 주는 한도는 출처·확인 시점을 밝힌 **참고값**이고
 *   · 실제로 막을지 말지는 **구글이 돌려준 429 응답**으로 판정한다
 *   · 429 본문에 limit 값이 들어 있으면 그것을 관측값으로 적어 두고 그다음부터는 그걸 쓴다
 * 이 모듈은 DOM을 건드리지 않는다. 화면 표시는 쓰는 쪽이 맡는다.
 */
"use strict";

/** 구글의 일일 한도가 되돌아오는 기준 시간대. */
export const TZ = 'America/Los_Angeles';

const NAME = 'gemini_usage';

/**
 * 무료 등급 한도 참고값.
 *
 * [검색·스니펫 추정] 구글 공식 문서(ai.google.dev/gemini-api/docs/rate-limits)의 값으로
 * 검색 결과에 나타난 것이며, 이 저장소에서 문서 원문을 직접 열어 확인하지는 못했다.
 * 화면에는 반드시 「참고값」과 출처를 함께 적을 것. 실제 차단 판정에는 쓰지 않는다.
 */
export const FREE_TIER = {
  'gemini-2.5-flash-lite': { rpm: 15, tpm: 250000, rpd: 1000 },
  'gemini-2.5-flash': { rpm: 10, tpm: 250000, rpd: 250 },
  'gemini-2.5-pro': { rpm: 5, tpm: 250000, rpd: 100 },
};

/** 참고값의 출처. 화면·문서에 그대로 인용한다. */
export const FREE_TIER_SOURCE = {
  url: 'https://ai.google.dev/gemini-api/docs/rate-limits',
  note: '구글 「Rate limits」 문서 기준 참고값(검색 결과로 확인, 원문 직접 열람은 못 함). '
    + '한도는 구글 공지·계정 등급에 따라 바뀔 수 있다.',
};

// ──────────────────────────────────────────────────────────────
// 저장소 — 막혀 있어도 죽지 않는다
// ──────────────────────────────────────────────────────────────
let mem = null;
let memoryOnly = false;

function box() {
  try {
    const s = globalThis.localStorage;
    if (!s || typeof s.getItem !== 'function') return null;
    return s;
  } catch (e) {
    return null;
  }
}

/** 저장소가 막혀 장부가 메모리에만 있는 상태인가. */
export function storageBlocked() {
  return memoryOnly;
}

// ──────────────────────────────────────────────────────────────
// 태평양 시각 — 날짜 갈이와 리셋 시점
// ──────────────────────────────────────────────────────────────
function parts(t) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const o = {};
  for (const p of f.formatToParts(t)) if (p.type !== 'literal') o[p.type] = p.value;
  // hour가 '24'로 나오는 구현이 있어(자정) 0으로 눕힌다
  const h = Number(o.hour) % 24;
  return { y: +o.year, mo: +o.month, d: +o.day, h, mi: +o.minute, s: +o.second };
}

/** 그 순간 태평양이 UTC보다 얼마나 뒤인지(ms, 음수). */
function offsetOf(t) {
  const p = parts(t);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t.getTime();
}

/** 태평양 기준 날짜. 장부의 한 장이 이 값 하나에 대응한다. */
export function ptDay(now) {
  const p = parts(now || new Date());
  const two = (n) => String(n).padStart(2, '0');
  return `${p.y}-${two(p.mo)}-${two(p.d)}`;
}

/**
 * 다음 리셋 시각(다음 태평양 자정)을 실제 시각으로 돌려준다.
 * 서머타임이 걸린 날에는 벽시계 자정과 UTC 간격이 달라지므로 두 번 맞춘다.
 */
export function nextResetAt(now) {
  const t = now || new Date();
  const p = parts(t);
  const wall = Date.UTC(p.y, p.mo - 1, p.d + 1, 0, 0, 0);
  let at = wall - offsetOf(t);
  at = wall - offsetOf(new Date(at));
  return new Date(at);
}

/** 리셋까지 남은 시간. { ms, hours, minutes, at } */
export function untilReset(now) {
  const t = now || new Date();
  const at = nextResetAt(t);
  const ms = Math.max(0, at.getTime() - t.getTime());
  return { ms, hours: Math.floor(ms / 3600000), minutes: Math.floor((ms % 3600000) / 60000), at };
}

/** 리셋 시각을 보는 사람의 시간대로 적는다(한국이면 한국시간). */
export function resetText(now, locale, tz) {
  const at = nextResetAt(now || new Date());
  try {
    const f = new Intl.DateTimeFormat(locale || 'ko-KR', {
      ...(tz ? { timeZone: tz } : {}),
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    return f.format(at);
  } catch (e) {
    return at.toISOString();
  }
}

// ──────────────────────────────────────────────────────────────
// 장부
// ──────────────────────────────────────────────────────────────
const blank = (day) => ({ day, total: 0, models: {}, verified: '' });

function read() {
  const s = box();
  if (!s) { memoryOnly = true; return mem; }
  try {
    const raw = s.getItem(NAME);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    memoryOnly = true;
    return mem;
  }
}

function write(led) {
  mem = led;
  const s = box();
  if (!s) { memoryOnly = true; return; }
  try {
    s.setItem(NAME, JSON.stringify(led));
  } catch (e) {
    memoryOnly = true;
  }
}

/** 오늘 장부. 날짜가 바뀌었으면 새 장을 편다. */
export function load(now) {
  const day = ptDay(now);
  const got = read();
  if (!got || got.day !== day || typeof got.total !== 'number') {
    const fresh = blank(day);
    write(fresh);
    return fresh;
  }
  if (!got.models || typeof got.models !== 'object') got.models = {};
  return got;
}

/** 장부를 비운다(키를 지울 때 함께 부른다). */
export function clearUsage() {
  mem = null;
  const s = box();
  if (!s) return;
  try { s.removeItem(NAME); } catch (e) { /* 막혀 있으면 메모리만 비운 것으로 족하다 */ }
}

/** 성공한 호출 1회를 적는다. 돌려주는 값은 오늘 누적 횟수. */
export function bump(model, now) {
  const led = load(now);
  const key = String(model || '(이름 없음)');
  const m = led.models[key] || (led.models[key] = { n: 0, exhausted: false, limit: 0 });
  m.n += 1;
  led.total += 1;
  write(led);
  return led.total;
}

/**
 * 그 모델의 오늘 몫이 끝났음을 적는다.
 * limit은 구글이 429 본문에 적어 준 값(있을 때만). 관측값이라 참고값보다 앞선다.
 */
export function markExhausted(model, limit, now) {
  const led = load(now);
  const key = String(model || '(이름 없음)');
  const m = led.models[key] || (led.models[key] = { n: 0, exhausted: false, limit: 0 });
  m.exhausted = true;
  if (Number.isFinite(limit) && limit > 0) m.limit = limit;
  write(led);
}

/** 그 모델이 오늘 이미 한도에 걸렸는가. */
export function isExhausted(model, now) {
  const m = load(now).models[String(model || '')];
  return !!(m && m.exhausted);
}

/** 오늘 쓸 수 있는 이름만 남긴다. */
export function usable(models, now) {
  return (Array.isArray(models) ? models : []).filter((m) => !isExhausted(m, now));
}

/** 화면에 뿌릴 오늘 사용 현황. */
export function usage(now) {
  const led = load(now);
  return {
    day: led.day,
    total: led.total,
    models: led.models,
    exhausted: Object.keys(led.models).filter((k) => led.models[k].exhausted),
  };
}

/**
 * 그 모델의 하루 한도. 관측값(429가 알려 준 limit)이 있으면 그것을,
 * 없으면 참고값을 돌려준다. source로 어느 쪽인지 밝힌다.
 */
export function limitOf(model, now) {
  const key = String(model || '');
  const m = load(now).models[key];
  if (m && m.limit) return { rpd: m.limit, source: 'observed' };
  const ref = FREE_TIER[key];
  if (ref) return { rpd: ref.rpd, rpm: ref.rpm, tpm: ref.tpm, source: 'reference' };
  return { rpd: 0, source: 'unknown' };
}

// ──────────────────────────────────────────────────────────────
// 키 확인 캐시 — 페이지를 열 때마다 한 번씩 쓰는 몫을 아낀다
// ──────────────────────────────────────────────────────────────
/** 키를 그대로 두지 않기 위한 짧은 지문(djb2). 되돌릴 수 없다. */
export function fingerprint(key) {
  const s = String(key || '');
  if (!s) return '';
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length}:${h.toString(36)}`;
}

/** 오늘 이 키로 실호출 확인을 이미 마쳤다고 적는다. */
export function setVerified(key, now) {
  const led = load(now);
  led.verified = fingerprint(key);
  write(led);
}

/** 오늘 이 키가 이미 확인된 적 있는가(부팅 자동 확인을 건너뛸지 판단). */
export function isVerified(key, now) {
  const fp = fingerprint(key);
  return !!fp && load(now).verified === fp;
}

/** 확인 기록만 지운다(키를 바꿨을 때). */
export function clearVerified(now) {
  const led = load(now);
  led.verified = '';
  write(led);
}
