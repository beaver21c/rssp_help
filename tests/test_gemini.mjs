/**
 * app/assets/gemini.js 시험 — 개인 키 기반 Gemini 호출.
 *
 * 진짜 키가 없으니 실제 API는 부르지 않는다. 대신 요청 URL·헤더·본문을 받아 적는
 * 가짜 fetch를 꽂아 넣고, 모델 거르기·정렬·폴백 순서·헤더 규칙·첨부 파트를 확인한다.
 * 프레임워크 없이 돈다. 실패하면 사유를 찍고 process.exitCode = 1.
 *   node tests/test_gemini.mjs
 */
"use strict";

import {
  BASE, RETRY_MS, FALLBACK_MODELS,
  getKey, setKey, keyScope, clearModelCache,
  rankModel, orderModels, listModels,
  buildBody, requestSize, answerText, generate, checkKey,
} from '../app/assets/gemini.js';

let failed = 0;
let passed = 0;
function check(name, ok, why) {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${name}${why ? ` — ${why}` : ''}`);
}
const eq = (name, got, want) => check(name, got === want, `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
async function throws(name, fn, test) {
  try {
    await fn();
    check(name, false, '오류가 안 났다');
    return null;
  } catch (e) {
    check(name, test ? test(e) : true, `사유가 다르다: ${e.message}`);
    return e;
  }
}

const KEY = 'AIza-가짜키-0123456789';

// ──────────────────────────────────────────────────────────────
// 가짜 fetch — 부른 내역을 전부 남긴다
// ──────────────────────────────────────────────────────────────
const okRes = (obj) => ({ ok: true, status: 200, json: async () => obj });
const errRes = (status, message) => ({
  ok: false, status, json: async () => ({ error: { message, code: status } }),
});
const modelsRes = (names) => okRes({
  models: names.map((n) => ({
    name: `models/${n}`, supportedGenerationMethods: ['generateContent', 'countTokens'],
  })),
});
const textRes = (text) => okRes({ candidates: [{ content: { parts: [{ text }] } }] });

/** route(call) → 응답. call = {url, method, headers, body(파싱본), model} */
function fakeFetch(route) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = {
      url,
      method: init.method || 'GET',
      headers: init.headers || {},
      raw: init.body || '',
      body: init.body ? JSON.parse(init.body) : null,
      model: (String(url).match(/\/models\/([^:]+):/) || [])[1] || '',
    };
    calls.push(call);
    const res = route(call, calls.length - 1);
    if (!res) throw new Error(`가짜 fetch에 준비된 응답이 없다: ${url}`);
    return res;
  };
  fn.calls = calls;
  fn.gen = () => calls.filter((c) => c.model);
  return fn;
}

/** 대기 호출을 받아 적되 실제로는 기다리지 않는다. */
function fakeSleep() {
  const waits = [];
  const fn = async (ms) => { waits.push(ms); };
  fn.waits = waits;
  return fn;
}

const deps = (fetchImpl, sleep) => ({ fetchImpl, sleep });

// ──────────────────────────────────────────────────────────────
// 1) 모델 거르기
// ──────────────────────────────────────────────────────────────
{
  clearModelCache();
  const raw = [
    'gemini-2.0-flash-exp', 'gemini-2.5-flash-preview-05-20', 'gemini-2.5-flash-tts',
    'imagen-3.0-generate', 'gemini-embedding-001', 'gemini-live-2.5-flash',
    'gemini-2.5-flash-native-audio', 'gemini-2.5-flash-thinking', 'gemini-2.0-flash-image',
    'gemini-2.5-flash', 'gemini-2.5-pro',
  ];
  const f = fakeFetch(() => modelsRes(raw));
  const got = await listModels(KEY, deps(f));
  check('1 실험·미리보기 계열이 걸러진다', !got.some((n) => /exp|preview|tts|image|embed|live|audio|thinking/i.test(n)),
    `남은 것: ${got.join(', ')}`);
  check('1 멀쩡한 모델은 남는다', got.includes('gemini-2.5-flash') && got.includes('gemini-2.5-pro'),
    got.join(', '));
  eq('1 남은 개수', got.length, 2);
  eq('1 models/ 접두어가 벗겨진다', got.every((n) => !n.startsWith('models/')), true);
  eq('1 목록 호출은 한 번', f.calls.length, 1);

  // 캐시: 같은 키로 또 부르면 그물을 다시 안 탄다
  await listModels(KEY, deps(f));
  eq('1 같은 키는 캐시를 쓴다', f.calls.length, 1);
  clearModelCache();
  await listModels(KEY, deps(f));
  eq('1 캐시를 버리면 다시 부른다', f.calls.length, 2);

  // generateContent를 지원 안 하는 모델은 뺀다
  clearModelCache();
  const g = fakeFetch(() => okRes({
    models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ],
  }));
  eq('1 generateContent 미지원 제외', (await listModels(KEY, deps(g))).join(','), 'gemini-2.5-flash');

  // 하나도 안 남으면 기본 목록으로 버틴다
  clearModelCache();
  const h = fakeFetch(() => modelsRes(['gemini-2.0-flash-exp']));
  eq('1 빈 목록이면 기본값', (await listModels(KEY, deps(h))).join(','), FALLBACK_MODELS.join(','));
}

// ──────────────────────────────────────────────────────────────
// 2) 정렬 — flash 우선, 높은 버전 우선, lite는 뒤로
// ──────────────────────────────────────────────────────────────
{
  const got = orderModels([
    'gemini-1.5-pro', 'gemini-2.0-flash-lite', 'gemini-1.5-flash',
    'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash',
  ]);
  eq('2 정렬 결과',
    got.join(','),
    ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite',
      'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.5-pro'].join(','));
  check('2 flash가 pro보다 앞', got.indexOf('gemini-2.5-flash') < got.indexOf('gemini-1.5-pro'));
  check('2 버전 높은 쪽이 앞', got.indexOf('gemini-2.5-flash') < got.indexOf('gemini-2.0-flash'));
  check('2 lite는 동버전 뒤', got.indexOf('gemini-2.5-flash') < got.indexOf('gemini-2.5-flash-lite'));
  check('2 flash 아닌 것은 원래 차례대로', got.slice(-2).join(',') === 'gemini-1.5-pro,gemini-2.5-pro');
  eq('2 rankModel 값', JSON.stringify(rankModel('gemini-2.5-flash-lite')), JSON.stringify([1, 205, -1]));
}

// ──────────────────────────────────────────────────────────────
// 3) 429 — 쉬었다가 다음 모델
// ──────────────────────────────────────────────────────────────
{
  clearModelCache();
  const f = fakeFetch((c) => {
    if (!c.model) return modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash']);
    if (c.model === 'gemini-2.5-flash') return errRes(429, 'Resource has been exhausted');
    return textRes('둘째 모델이 답했다');
  });
  const s = fakeSleep();
  const out = await generate({ prompt: '한 줄 써 봐', key: KEY }, deps(f, s));
  eq('3 429면 다음 모델이 답한다', out.model, 'gemini-2.0-flash');
  eq('3 응답 본문', out.text, '둘째 모델이 답했다');
  eq('3 시도한 모델 수', f.gen().length, 2);
  eq('3 대기 횟수', s.waits.length, 1);
  eq('3 대기 시간', s.waits[0], RETRY_MS);
  eq('3 대기는 2초', RETRY_MS, 2000);
}

// ──────────────────────────────────────────────────────────────
// 4) 404 — 기다리지 않고 바로 다음 모델
// ──────────────────────────────────────────────────────────────
{
  clearModelCache();
  const f = fakeFetch((c) => {
    if (!c.model) return modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash']);
    if (c.model === 'gemini-2.5-flash') return errRes(404, 'models/gemini-2.5-flash is not found');
    return textRes('넘어와서 답했다');
  });
  const s = fakeSleep();
  const out = await generate({ prompt: '뭐라도', key: KEY }, deps(f, s));
  eq('4 404면 다음 모델', out.model, 'gemini-2.0-flash');
  eq('4 404에는 안 쉰다', s.waits.length, 0);
  eq('4 첫 모델은 한 번만 부른다', f.gen().filter((c) => c.model === 'gemini-2.5-flash').length, 1);
}

// ──────────────────────────────────────────────────────────────
// 5) 키 오류 — 즉시 중단, err.fatal
// ──────────────────────────────────────────────────────────────
{
  clearModelCache();
  const f = fakeFetch((c) => {
    if (!c.model) return modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash']);
    return errRes(400, 'API key not valid. Please pass a valid API key.');
  });
  const s = fakeSleep();
  const e = await throws('5 키 오류는 던진다',
    () => generate({ prompt: '아무거나', key: KEY }, deps(f, s)),
    (x) => /API key not valid/.test(x.message));
  eq('5 fatal 표시', e && e.fatal, true);
  eq('5 상태 코드', e && e.status, 400);
  eq('5 다음 모델로 안 넘어간다', f.gen().length, 1);

  // permission·expired 문구도 같은 취급
  clearModelCache();
  const g = fakeFetch((c) => (c.model
    ? errRes(403, 'Permission denied on resource')
    : modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash'])));
  const e2 = await throws('5 권한 오류도 중단', () => generate({ prompt: 'x', key: KEY }, deps(g, s)));
  eq('5 권한 오류도 fatal', e2 && e2.fatal, true);
  eq('5 권한 오류도 한 번만', g.gen().length, 1);
}

// ──────────────────────────────────────────────────────────────
// 6) 키는 헤더로만 — URL에 절대 안 들어간다
// ──────────────────────────────────────────────────────────────
{
  clearModelCache();
  const f = fakeFetch((c) => (c.model ? textRes('좋아') : modelsRes(['gemini-2.5-flash'])));
  await generate({ prompt: '헤더 확인', system: '너는 도우미다', key: KEY }, deps(f, fakeSleep()));
  eq('6 부른 횟수', f.calls.length, 2);
  for (const c of f.calls) {
    const tag = c.model || '모델 목록';
    eq(`6 ${tag} URL에 키 없음`, String(c.url).includes(KEY), false);
    eq(`6 ${tag} URL에 key= 없음`, /[?&]key=/.test(String(c.url)), false);
    eq(`6 ${tag} 헤더에 키 있음`, c.headers['x-goog-api-key'], KEY);
  }
  check('6 목록 주소', f.calls[0].url === `${BASE}/models?pageSize=1000`, f.calls[0].url);
  check('6 생성 주소', f.calls[1].url === `${BASE}/models/gemini-2.5-flash:generateContent`, f.calls[1].url);
  eq('6 생성은 POST', f.calls[1].method, 'POST');
  eq('6 Content-Type', f.calls[1].headers['Content-Type'], 'application/json');
  eq('6 systemInstruction 자리', f.calls[1].body.systemInstruction.parts[0].text, '너는 도우미다');
  eq('6 기본 온도', f.calls[1].body.generationConfig.temperature, 0.3);
}

// ──────────────────────────────────────────────────────────────
// 7) 첨부 — inline_data 파트, 텍스트가 먼저
// ──────────────────────────────────────────────────────────────
{
  clearModelCache();
  const f = fakeFetch((c) => (c.model ? textRes('읽었다') : modelsRes(['gemini-2.5-flash'])));
  const files = [
    { mimeType: 'application/pdf', data: 'JVBERi0xLjQK' },
    { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ];
  await generate({ prompt: '이 자료를 읽어라', files, key: KEY, temperature: 0.1, json: true },
    deps(f, fakeSleep()));
  const parts = f.gen()[0].body.contents[0].parts;
  eq('7 파트 개수', parts.length, 3);
  eq('7 텍스트가 첫 파트', parts[0].text, '이 자료를 읽어라');
  eq('7 첫 파트에 inline_data 없음', 'inline_data' in parts[0], false);
  eq('7 둘째 파트 mime', parts[1].inline_data.mime_type, 'application/pdf');
  eq('7 둘째 파트 data', parts[1].inline_data.data, 'JVBERi0xLjQK');
  eq('7 셋째 파트 mime', parts[2].inline_data.mime_type, 'image/png');
  eq('7 첨부 차례 유지', parts.slice(1).every((p, i) => p.inline_data.data === files[i].data), true);
  eq('7 온도 반영', f.gen()[0].body.generationConfig.temperature, 0.1);
  eq('7 json이면 응답 형식 지정', f.gen()[0].body.generationConfig.responseMimeType, 'application/json');

  // attach.js가 주는 모양(mimeType)과 API 모양(mime_type) 둘 다 받는다
  const b = buildBody({ prompt: 'p', files: [{ mime_type: 'text/plain', data: 'aGk=' }] });
  eq('7 mime_type 표기도 받는다', b.contents[0].parts[1].inline_data.mime_type, 'text/plain');
  await throws('7 mime 빠지면 오류',
    async () => buildBody({ prompt: 'p', files: [{ data: 'aGk=' }] }),
    (e) => e.message.includes('mimeType'));
  await throws('7 data 빠지면 오류',
    async () => buildBody({ prompt: 'p', files: [{ mimeType: 'image/png' }] }));
}

// ──────────────────────────────────────────────────────────────
// 8) 전부 실패하면 마지막 오류를 던진다
// ──────────────────────────────────────────────────────────────
{
  clearModelCache();
  const f = fakeFetch((c) => {
    if (!c.model) return modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro']);
    if (c.model === 'gemini-1.5-pro') return errRes(500, '마지막 모델까지 터졌다');
    return errRes(503, 'Service unavailable');
  });
  const e = await throws('8 모두 실패하면 던진다',
    () => generate({ prompt: 'x', key: KEY }, deps(f, fakeSleep())),
    (x) => x.message === '마지막 모델까지 터졌다');
  eq('8 마지막 상태 코드', e && e.status, 500);
  eq('8 모델 셋 다 시도', f.gen().length, 3);
  eq('8 마지막이 pro', f.gen()[2].model, 'gemini-1.5-pro');

  // 그물이 끊긴 경우(fetch 자체가 튐)도 다음 모델로 넘어간다
  clearModelCache();
  let n = 0;
  const g = fakeFetch((c) => {
    if (!c.model) return modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash']);
    n += 1;
    if (n === 1) throw new Error('네트워크가 끊겼다');
    return textRes('둘째가 받았다');
  });
  const out = await generate({ prompt: 'x', key: KEY }, deps(g, fakeSleep()));
  eq('8 네트워크 오류 뒤 다음 모델', out.model, 'gemini-2.0-flash');
}

// ──────────────────────────────────────────────────────────────
// 9) 스키마 400 → 스키마 빼고 같은 모델 재시도
// ──────────────────────────────────────────────────────────────
{
  clearModelCache();
  const f = fakeFetch((c) => {
    if (!c.model) return modelsRes(['gemini-2.5-flash']);
    if (c.body.generationConfig.responseSchema) return errRes(400, 'responseSchema is not supported');
    return textRes('{"ok":true}');
  });
  const out = await generate(
    { prompt: 'x', key: KEY, json: true, schema: { type: 'OBJECT' } }, deps(f, fakeSleep()));
  eq('9 스키마 빼고 성공', out.text, '{"ok":true}');
  eq('9 같은 모델 두 번', f.gen().length, 2);
  eq('9 둘째 시도엔 스키마 없음', 'responseSchema' in f.gen()[1].body.generationConfig, false);
  eq('9 두 번 다 같은 모델', f.gen()[0].model === f.gen()[1].model, true);
}

// ──────────────────────────────────────────────────────────────
// 10) 키 보관 — 저장소가 없는 Node에서도 안 죽는다
// ──────────────────────────────────────────────────────────────
{
  eq('10 처음엔 키 없음', getKey(), '');
  eq('10 처음 보관 위치 없음', keyScope(), '');
  await throws('10 키 없이 부르면 오류',
    () => generate({ prompt: 'x' }, deps(fakeFetch(() => okRes({})))),
    (e) => e.message.includes('키가 없다'));

  setKey('키-세션', false);
  eq('10 세션 보관', keyScope(), 'session');
  eq('10 세션 키 읽기', getKey(), '키-세션');

  setKey('키-로컬', true);
  eq('10 로컬 보관', keyScope(), 'local');
  eq('10 로컬 키 읽기', getKey(), '키-로컬');
  eq('10 갈아 끼우면 세션 자리는 빈다', getKey(), '키-로컬');

  setKey('', false);
  eq('10 지우면 빈다', getKey(), '');
  eq('10 지우면 위치도 없다', keyScope(), '');
  setKey('  띄어쓰기  ', false);
  eq('10 앞뒤 공백은 턴다', getKey(), '띄어쓰기');
  setKey('', false);
}

// ──────────────────────────────────────────────────────────────
// 11) requestSize·answerText·checkKey
// ──────────────────────────────────────────────────────────────
{
  const small = requestSize({ prompt: '짧다' });
  const big = requestSize({ prompt: '짧다', files: [{ mimeType: 'image/png', data: 'A'.repeat(1000) }] });
  check('11 첨부가 붙으면 커진다', big > small + 1000, `${small} → ${big}`);
  eq('11 잰 값은 실제 바이트 수',
    small, new TextEncoder().encode(JSON.stringify(buildBody({ prompt: '짧다' }, true))).length);
  check('11 한글은 3바이트로 잡힌다',
    requestSize({ prompt: '가' }) - requestSize({ prompt: 'a' }) === 2,
    `차이 ${requestSize({ prompt: '가' }) - requestSize({ prompt: 'a' })}`);
  await throws('11 빈 프롬프트는 오류', async () => requestSize({ prompt: '   ' }));

  eq('11 여러 파트를 이어 붙인다',
    answerText({ candidates: [{ content: { parts: [{ text: '앞' }, { text: '뒤' }] } }] }), '앞뒤');
  eq('11 후보가 없으면 빈 문자열', answerText({}), '');

  clearModelCache();
  const f = fakeFetch(() => modelsRes(['gemini-2.5-flash', 'gemini-2.5-pro']));
  const good = await checkKey(KEY, deps(f));
  eq('11 확인 성공', good.ok, true);
  eq('11 우선 모델', good.model, 'gemini-2.5-flash');
  clearModelCache();
  const g = fakeFetch(() => errRes(400, 'API key not valid.'));
  const bad = await checkKey(KEY, deps(g));
  eq('11 확인 실패', bad.ok, false);
  check('11 실패 사유가 담긴다', bad.error.includes('API key not valid'), bad.error);
}

console.log(`통과 ${passed} / 실패 ${failed}`);
if (failed) {
  console.error(`시험 실패 — 위 ${failed}건을 고칠 것.`);
  process.exitCode = 1;
}
