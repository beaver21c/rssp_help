/**
 * app/assets/quota.js 시험 — 무료 티어 사용량 장부.
 *
 * 저장소가 없는 Node에서도 메모리로 물러나 돌아야 한다. 날짜 갈이·서머타임·
 * 관측 한도 우선·확인 캐시를 확인한다. 프레임워크 없이 돈다.
 *   node tests/test_quota.mjs
 */
"use strict";

import {
  TZ, FREE_TIER, FREE_TIER_SOURCE,
  ptDay, nextResetAt, untilReset, resetText,
  load, clearUsage, bump, markExhausted, isExhausted, usable, usage, limitOf,
  fingerprint, setVerified, isVerified, clearVerified,
} from '../app/assets/quota.js';

let failed = 0;
let passed = 0;
const check = (name, ok, why) => {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${name}${why ? ` — ${why}` : ''}`);
};
const eq = (name, got, want) => check(name, got === want, `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);

const iso = (s) => new Date(s);

// ──────────────────────────────────────────────────────────────
// 1) 태평양 날짜 — 장부 한 장의 기준
// ──────────────────────────────────────────────────────────────
{
  eq('1 기준 시간대', TZ, 'America/Los_Angeles');
  // 2026-09-08 13:00Z = PDT(UTC-7) 06:00 → 같은 날
  eq('1 낮 시간 날짜', ptDay(iso('2026-09-08T13:00:00Z')), '2026-09-08');
  // 2026-09-08 06:00Z = PDT 전날 23:00 → 하루 앞
  eq('1 UTC 새벽은 태평양 전날', ptDay(iso('2026-09-08T06:00:00Z')), '2026-09-07');
  // PT 자정 직후
  eq('1 PT 자정 직후', ptDay(iso('2026-09-08T07:00:01Z')), '2026-09-08');
  eq('1 PT 자정 직전', ptDay(iso('2026-09-08T06:59:59Z')), '2026-09-07');
}

// ──────────────────────────────────────────────────────────────
// 2) 리셋 시각 — 서머타임을 넘어도 맞아야 한다
// ──────────────────────────────────────────────────────────────
{
  // 여름(PDT, UTC-7): 다음 PT 자정 = 07:00Z
  eq('2 여름 리셋', nextResetAt(iso('2026-09-08T13:00:00Z')).toISOString(), '2026-09-09T07:00:00.000Z');
  // 겨울(PST, UTC-8): 다음 PT 자정 = 08:00Z
  eq('2 겨울 리셋', nextResetAt(iso('2026-01-15T13:00:00Z')).toISOString(), '2026-01-16T08:00:00.000Z');
  // 서머타임 시작일(2026-03-08 미국 PT) 언저리에서도 자정은 자정이다
  const dst = nextResetAt(iso('2026-03-07T20:00:00Z'));
  eq('2 서머타임 시작 전날', dst.toISOString(), '2026-03-08T08:00:00.000Z');
  eq('2 그 다음 날은 한 시간 당겨진다',
    nextResetAt(iso('2026-03-08T20:00:00Z')).toISOString(), '2026-03-09T07:00:00.000Z');

  const u = untilReset(iso('2026-09-08T13:00:00Z'));
  eq('2 남은 시간(시)', u.hours, 18);
  eq('2 남은 시간(분)', u.minutes, 0);
  check('2 남은 시간이 음수가 되지 않는다', untilReset(iso('2026-09-09T06:59:59Z')).ms > 0);

  // 한국시간 표기 — 여름 오후 4시, 겨울 오후 5시
  check('2 여름은 한국시간 오후 4시',
    /4:00/.test(resetText(iso('2026-09-08T13:00:00Z'), 'ko-KR', 'Asia/Seoul')),
    resetText(iso('2026-09-08T13:00:00Z'), 'ko-KR', 'Asia/Seoul'));
  check('2 겨울은 한국시간 오후 5시',
    /5:00/.test(resetText(iso('2026-01-15T13:00:00Z'), 'ko-KR', 'Asia/Seoul')),
    resetText(iso('2026-01-15T13:00:00Z'), 'ko-KR', 'Asia/Seoul'));
}

// ──────────────────────────────────────────────────────────────
// 3) 계수와 날짜 갈이
// ──────────────────────────────────────────────────────────────
{
  clearUsage();
  const day1 = iso('2026-09-08T13:00:00Z');
  eq('3 처음엔 0회', usage(day1).total, 0);
  eq('3 한 번 쓰면 1', bump('gemini-3.5-flash-lite', day1), 1);
  eq('3 두 번 쓰면 2', bump('gemini-3.5-flash-lite', day1), 2);
  eq('3 다른 모델도 합산', bump('gemini-3.5-flash', day1), 3);
  eq('3 모델별 계수', usage(day1).models['gemini-3.5-flash-lite'].n, 2);
  eq('3 장부 날짜', usage(day1).day, '2026-09-08');

  // 태평양 자정을 넘기면 새 장
  const day2 = iso('2026-09-09T07:00:01Z');
  eq('3 날이 바뀌면 0부터', usage(day2).total, 0);
  eq('3 새 장 날짜', usage(day2).day, '2026-09-09');
  eq('3 모델별 계수도 비워진다', Object.keys(usage(day2).models).length, 0);
}

// ──────────────────────────────────────────────────────────────
// 4) 하루 몫 소진 표시
// ──────────────────────────────────────────────────────────────
{
  clearUsage();
  const t = iso('2026-09-08T13:00:00Z');
  eq('4 처음엔 안 막혔다', isExhausted('gemini-3.5-flash-lite', t), false);
  markExhausted('gemini-3.5-flash-lite', 1000, t);
  eq('4 막힌 것으로 표시', isExhausted('gemini-3.5-flash-lite', t), true);
  eq('4 다른 모델은 그대로', isExhausted('gemini-3.5-flash', t), false);
  eq('4 쓸 수 있는 이름만 남긴다',
    usable(['gemini-3.5-flash-lite', 'gemini-3.5-flash'], t).join(','), 'gemini-3.5-flash');
  eq('4 소진 목록', usage(t).exhausted.join(','), 'gemini-3.5-flash-lite');
  // 날이 바뀌면 풀린다
  eq('4 다음 날에는 풀린다', isExhausted('gemini-3.5-flash-lite', iso('2026-09-09T08:00:00Z')), false);
}

// ──────────────────────────────────────────────────────────────
// 5) 한도 — 관측값이 참고값을 이긴다
// ──────────────────────────────────────────────────────────────
{
  clearUsage();
  const t = iso('2026-09-08T13:00:00Z');
  const ref = limitOf('gemini-2.5-flash-lite', t);
  eq('5 참고값을 쓴다', ref.source, 'reference');
  eq('5 참고값 숫자', ref.rpd, FREE_TIER['gemini-2.5-flash-lite'].rpd);
  markExhausted('gemini-2.5-flash-lite', 50, t);
  const obs = limitOf('gemini-2.5-flash-lite', t);
  eq('5 관측값이 앞선다', obs.source, 'observed');
  eq('5 관측값 숫자', obs.rpd, 50);
  eq('5 모르는 모델은 모른다고 한다', limitOf('gemini-9.9-unknown', t).source, 'unknown');

  check('5 참고값에 출처가 붙어 있다',
    /ai\.google\.dev/.test(FREE_TIER_SOURCE.url) && FREE_TIER_SOURCE.note.length > 20,
    JSON.stringify(FREE_TIER_SOURCE));
  check('5 참고값임을 문구가 밝힌다', /참고값/.test(FREE_TIER_SOURCE.note), FREE_TIER_SOURCE.note);
}

// ──────────────────────────────────────────────────────────────
// 6) 확인 캐시 — 페이지를 열 때마다 몫을 쓰지 않게
// ──────────────────────────────────────────────────────────────
{
  clearUsage();
  const t = iso('2026-09-08T13:00:00Z');
  const KEY = 'AIza-가짜키-0123456789';
  eq('6 처음엔 확인 기록 없음', isVerified(KEY, t), false);
  setVerified(KEY, t);
  eq('6 확인 기록이 남는다', isVerified(KEY, t), true);
  eq('6 다른 키는 아니다', isVerified('AIza-다른키', t), false);
  eq('6 날이 바뀌면 다시 확인한다', isVerified(KEY, iso('2026-09-09T08:00:00Z')), false);
  clearVerified(t);
  eq('6 기록을 지우면 없다', isVerified(KEY, t), false);

  // 지문에 키 원문이 남으면 안 된다
  const fp = fingerprint(KEY);
  check('6 지문에 키가 그대로 담기지 않는다', !fp.includes(KEY) && !fp.includes('0123456789'), fp);
  check('6 같은 키는 같은 지문', fingerprint(KEY) === fp);
  check('6 다른 키는 다른 지문', fingerprint(KEY + 'x') !== fp);
  eq('6 빈 키는 빈 지문', fingerprint(''), '');
  eq('6 빈 키는 확인된 적 없다', isVerified('', t), false);
}

// ──────────────────────────────────────────────────────────────
// 7) 저장소가 없어도 죽지 않는다
// ──────────────────────────────────────────────────────────────
{
  clearUsage();
  const t = iso('2026-09-08T13:00:00Z');
  check('7 저장소 없이도 load가 돈다', !!load(t).day, JSON.stringify(load(t)));
  eq('7 저장소 없이도 계수가 된다', bump('m', t), 1);
  clearUsage();
  eq('7 지우면 0으로', usage(t).total, 0);
}

console.log(`통과 ${passed} / 실패 ${failed}`);
if (failed) {
  console.error(`시험 실패 — 위 ${failed}건을 고칠 것.`);
  process.exitCode = 1;
}
