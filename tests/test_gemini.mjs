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
  BASE, RETRY_MS, FALLBACK_MODELS, PING,
  getKey, setKey, keyScope, clearModelCache,
  rankModel, orderModels, listModels,
  getPreferred, setPreferred, verifyKey,
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

/* 모듈은 마지막에 성공한 모델을 기억한다(모델 교체 대비). 시험끼리 그 기억이
   새어 나가면 앞선 시험이 뒤 시험의 모델 차례를 바꿔 버리므로 매번 지우고 시작한다. */
const reset = () => { clearModelCache(); setPreferred(''); };

// ──────────────────────────────────────────────────────────────
// 1) 모델 거르기
// ──────────────────────────────────────────────────────────────
{
  reset();
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
  reset();
  await listModels(KEY, deps(f));
  eq('1 캐시를 버리면 다시 부른다', f.calls.length, 2);

  // generateContent를 지원 안 하는 모델은 뺀다
  reset();
  const g = fakeFetch(() => okRes({
    models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ],
  }));
  eq('1 generateContent 미지원 제외', (await listModels(KEY, deps(g))).join(','), 'gemini-2.5-flash');

  // 하나도 안 남으면 기본 목록으로 버틴다
  reset();
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
  reset();
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
  reset();
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
  reset();
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
  reset();
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
  reset();
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
  reset();
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
  reset();
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
  reset();
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
  reset();
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

  reset();
  const f = fakeFetch(() => modelsRes(['gemini-2.5-flash', 'gemini-2.5-pro']));
  const good = await checkKey(KEY, deps(f));
  eq('11 확인 성공', good.ok, true);
  eq('11 우선 모델', good.model, 'gemini-2.5-flash');
  reset();
  const g = fakeFetch(() => errRes(400, 'API key not valid.'));
  const bad = await checkKey(KEY, deps(g));
  eq('11 확인 실패', bad.ok, false);
  check('11 실패 사유가 담긴다', bad.error.includes('API key not valid'), bad.error);
}

// ──────────────────────────────────────────────────────────────
// 12) 경계 — 검증에서 나온 구멍을 막은 자리
// ──────────────────────────────────────────────────────────────
{
  // 12-1 200인데 본문이 JSON이 아니면(프록시 안내 쪽·잘린 응답) 폴백이 끊기면 안 된다
  reset();
  const f = fakeFetch((c) => (c.model
    ? { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }
    : modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash'])));
  const e = await throws('12 깨진 200이면 다음 모델까지 가고 한국어로 던진다',
    () => generate({ prompt: 'x', key: KEY }, deps(f, fakeSleep())),
    (x) => x.message.includes('JSON으로 읽지 못했다') && !(x instanceof SyntaxError));
  eq('12 깨진 200에도 모델 둘 다 시도', f.gen().length, 2);
  check('12 오류에 모델 이름이 담긴다', e && e.message.startsWith('gemini-2.0-flash'), e && e.message);

  // 12-2 200인데 알맹이가 없으면 성공으로 치지 않는다(빈 원고를 "완료"로 넘기던 자리)
  reset();
  const g = fakeFetch((c) => (c.model
    ? okRes({ promptFeedback: { blockReason: 'SAFETY' } })
    : modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash'])));
  const e2 = await throws('12 빈 응답은 실패로 친다',
    () => generate({ prompt: 'x', key: KEY }, deps(g, fakeSleep())),
    (x) => x.message.includes('빈 응답'));
  check('12 빈 응답 사유가 담긴다', e2 && e2.message.includes('SAFETY'), e2 && e2.message);
  eq('12 빈 응답이면 다음 모델도 본다', g.gen().length, 2);

  // 12-3 마지막 모델이 429면 헛기다림을 하지 않는다
  reset();
  const h = fakeFetch((c) => (c.model ? errRes(429, 'Resource exhausted')
    : modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'])));
  const s = fakeSleep();
  await throws('12 전부 429면 던진다', () => generate({ prompt: 'x', key: KEY }, deps(h, s)));
  eq('12 모델 셋 중 대기는 둘', s.waits.length, 2);

  // 12-4 주소를 비틀 수 있는 모델 이름은 목록에서 물리친다(키가 쿼리스트링으로 새는 길)
  reset();
  const bad = fakeFetch(() => okRes({
    models: [{ name: 'models/gemini 2.5/../evil?key=LEAK', supportedGenerationMethods: ['generateContent'] }],
  }));
  eq('12 못 쓰는 이름은 걸러지고 기본값으로 간다',
    (await listModels(KEY, deps(bad))).join(','), FALLBACK_MODELS.join(','));
  eq('12 orderModels도 같은 이름을 물리친다',
    orderModels(['gemini-2.5-flash', 'a/b', 'c?d=1', 'e f']).join(','), 'gemini-2.5-flash');
  await throws('12 model로 직접 넣어도 물리친다',
    () => generate({ prompt: 'x', key: KEY, model: '../evil?key=LEAK' },
      deps(fakeFetch(() => okRes({})), fakeSleep())),
    (x) => x.message.includes('못 쓰는 글자'));

  // 12-5 같은 키로 동시에 물으면 그물은 한 번만 탄다
  reset();
  const c1 = fakeFetch(() => modelsRes(['gemini-2.5-flash']));
  const three = await Promise.all([
    listModels(KEY, deps(c1)), listModels(KEY, deps(c1)), listModels(KEY, deps(c1)),
  ]);
  eq('12 동시 세 번이어도 목록 호출은 한 번', c1.calls.length, 1);
  eq('12 셋 다 같은 답', three.every((m) => m.join(',') === 'gemini-2.5-flash'), true);
  // 실패하면 캐시에 남지 않아 다음 호출이 다시 시도한다
  reset();
  const c2 = fakeFetch(() => errRes(500, '잠깐 죽었다'));
  await throws('12 목록 실패', () => listModels(KEY, deps(c2)));
  await throws('12 실패 뒤 재시도', () => listModels(KEY, deps(c2)));
  eq('12 실패는 캐시하지 않는다', c2.calls.length, 2);

  // 12-6 이상한 입력에도 한국어 오류를 낸다(날 TypeError 금지)
  await throws('12 files가 배열이 아니면 한국어 오류',
    async () => buildBody({ prompt: 'p', files: { mimeType: 'a', data: 'b' } }),
    (x) => !(x instanceof TypeError) && x.message.includes('배열'));
  reset();
  const w = fakeFetch(() => okRes({ models: '배열이 아니다' }));
  eq('12 목록이 배열이 아니면 기본값',
    (await listModels(KEY, deps(w))).join(','), FALLBACK_MODELS.join(','));
  eq('12 temperature 0도 지켜진다', buildBody({ prompt: 'p', temperature: 0 }).generationConfig.temperature, 0);
}

// ──────────────────────────────────────────────────────────────
// 13) 모델이 바뀌어도 죽지 않는가 — 이 도구의 가장 큰 외부 위험
// ──────────────────────────────────────────────────────────────
{
  // 13-1 마지막에 성공한 모델을 기억했다가 다음번에 맨 앞에 세운다
  reset();
  const f = fakeFetch((c) => (c.model ? textRes('첫 답') : modelsRes(['gemini-2.5-flash', 'gemini-2.0-flash'])));
  await generate({ prompt: 'x', key: KEY }, deps(f, fakeSleep()));
  eq('13 성공한 모델을 기억한다', getPreferred(), 'gemini-2.5-flash');

  reset();
  const g = fakeFetch((c) => (c.model ? textRes('또 답') : modelsRes(['gemini-2.0-flash', 'gemini-2.5-flash'])));
  const out = await generate({ prompt: 'x', key: KEY }, deps(g, fakeSleep()));
  eq('13 기억한 모델이 목록 차례를 제친다', g.gen()[0].model, 'gemini-2.5-flash');
  eq('13 그 모델이 답한다', out.model, 'gemini-2.5-flash');

  // 13-2 기억한 이름이 없어지면(404) 곧바로 버리고 다음 모델로 간다
  const OLD = 'gemini-1.0-flash-legacy';
  reset(); setPreferred(OLD);
  const h = fakeFetch((c) => {
    if (!c.model) return modelsRes(['gemini-3.0-flash']);
    if (c.model === OLD) return errRes(404, `models/${OLD} is not found`);
    return textRes('새 이름이 답했다');
  });
  const out2 = await generate({ prompt: 'x', key: KEY }, deps(h, fakeSleep()));
  eq('13 없어진 이름은 건너뛴다', out2.model, 'gemini-3.0-flash');
  eq('13 없어진 이름은 기억에서 지운다', getPreferred(), 'gemini-3.0-flash');
  eq('13 묵은 이름을 먼저 한 번은 시도한다', h.gen()[0].model, OLD);

  // 13-3 목록 창구가 통째로 막혀도 내장 이름으로 밀어붙인다
  reset();
  const i = fakeFetch((c) => (c.model
    ? (c.model === FALLBACK_MODELS[0] ? textRes('내장 이름으로 연결') : errRes(404, 'nope'))
    : errRes(500, '목록 창구가 죽었다')));
  const out3 = await generate({ prompt: 'x', key: KEY }, deps(i, fakeSleep()));
  eq('13 목록 실패해도 생성은 된다', out3.model, FALLBACK_MODELS[0]);
  eq('13 목록 실패해도 내장 목록을 쓴다', out3.text, '내장 이름으로 연결');

  // 13-4 목록도 못 받고 생성도 다 막히면 두 사유를 함께 알린다
  reset();
  const j = fakeFetch((c) => (c.model ? errRes(404, '그런 모델 없다') : errRes(500, '목록 창구가 죽었다')));
  const e = await throws('13 둘 다 막히면 던진다', () => generate({ prompt: 'x', key: KEY }, deps(j, fakeSleep())));
  check('13 생성 실패 사유가 담긴다', e && e.message.includes('그런 모델 없다'), e && e.message);
  check('13 목록 실패 사유도 함께 담긴다', e && e.message.includes('목록도 받지 못했다'), e && e.message);

  // 13-5 목록 조회 단계의 키 오류는 즉시 중단(내장 이름으로 두들겨 봐야 똑같이 막힌다)
  reset();
  const k = fakeFetch(() => errRes(400, 'API key not valid. Please pass a valid API key.'));
  const e2 = await throws('13 목록 단계 키 오류는 즉시 중단',
    () => generate({ prompt: 'x', key: KEY }, deps(k, fakeSleep())));
  eq('13 그 오류도 fatal', e2 && e2.fatal, true);
  eq('13 생성은 시도조차 안 한다', k.gen().length, 0);

  // 13-6 못 쓰는 이름은 기억하지 않는다(주소를 비트는 값 차단)
  setPreferred('a/b?key=LEAK');
  eq('13 못 쓰는 이름은 기억에서 물리친다', getPreferred(), '');
  setPreferred('models/gemini-2.5-flash');
  eq('13 models/ 접두어는 벗겨서 기억한다', getPreferred(), 'gemini-2.5-flash');
  setPreferred('');
}

// ──────────────────────────────────────────────────────────────
// 14) verifyKey — 목록만 보지 않고 실제 생성까지 해 본다
// ──────────────────────────────────────────────────────────────
{
  // 14-1 정상
  reset();
  const f = fakeFetch((c) => (c.model ? textRes('OK') : modelsRes(['gemini-2.5-flash', 'gemini-2.5-pro'])));
  const v = await verifyKey({ key: KEY }, deps(f, fakeSleep()));
  eq('14 확인 성공', v.ok, true);
  eq('14 답한 모델', v.model, 'gemini-2.5-flash');
  eq('14 목록을 받았다', v.listed, true);
  eq('14 모델 개수', v.models.length, 2);
  eq('14 응답 맛보기', v.sample, 'OK');
  eq('14 실제 생성까지 불렀다', f.gen().length, 1);
  check('14 확인용 프롬프트를 쓴다', f.gen()[0].body.contents[0].parts[0].text === PING,
    f.gen()[0].body.contents[0].parts[0].text);

  // 14-2 목록은 되는데 생성만 막힌 키 — 목록 조회만 하는 checkKey는 못 걸러 낸다
  reset();
  const g = fakeFetch((c) => (c.model
    ? errRes(403, 'Generative Language API has not been used in project')
    : modelsRes(['gemini-2.5-flash'])));
  const chk = await checkKey(KEY, deps(g));
  eq('14 목록만 보면 통과해 버린다', chk.ok, true);
  const v2 = await verifyKey({ key: KEY }, deps(g, fakeSleep()));
  eq('14 실호출까지 하면 걸러진다', v2.ok, false);
  check('14 실패 사유가 담긴다', v2.error.includes('has not been used'), v2.error);

  // 14-3 목록 창구만 죽은 경우 — 실패가 아니다
  reset();
  const h = fakeFetch((c) => (c.model
    ? (c.model === FALLBACK_MODELS[0] ? textRes('OK') : errRes(404, 'nope'))
    : errRes(503, '목록 창구가 죽었다')));
  const v3 = await verifyKey({ key: KEY }, deps(h, fakeSleep()));
  eq('14 목록이 죽어도 확인은 통과', v3.ok, true);
  eq('14 목록을 못 받았다고 표시', v3.listed, false);
  check('14 목록 실패 사유를 남긴다', v3.listError.includes('목록 창구가 죽었다'), v3.listError);
  eq('14 내장 이름을 목록 자리에 채운다', v3.models.join(','), FALLBACK_MODELS.join(','));

  // 14-4 키 자체가 거부되면 생성은 두들기지도 않는다
  reset();
  const i = fakeFetch(() => errRes(400, 'API key not valid. Please pass a valid API key.'));
  const v4 = await verifyKey({ key: KEY }, deps(i, fakeSleep()));
  eq('14 키 거부는 실패', v4.ok, false);
  eq('14 키 거부는 fatal', v4.fatal, true);
  eq('14 키 거부면 생성 호출 없음', i.gen().length, 0);

  // 14-5 모델을 지정하면 그 이름만 본다(폴백을 타지 않아 죽은 이름이 드러난다)
  reset();
  const j = fakeFetch((c) => (c.model ? errRes(404, '그런 모델 없다') : modelsRes(['gemini-2.5-flash'])));
  const v5 = await verifyKey({ key: KEY, model: 'gemini-9.9-flash' }, deps(j, fakeSleep()));
  eq('14 지정 모델만 시도', j.gen().length, 1);
  eq('14 지정한 이름 그대로', j.gen()[0].model, 'gemini-9.9-flash');
  eq('14 죽은 지정 모델은 실패로 드러난다', v5.ok, false);

  // 14-6 키가 없으면 그물을 타지 않는다
  const n = fakeFetch(() => okRes({}));
  const v6 = await verifyKey({}, deps(n, fakeSleep()));
  eq('14 키 없으면 실패', v6.ok, false);
  check('14 키 없음 사유', v6.error.includes('키가 없다'), v6.error);
  eq('14 키 없으면 호출 없음', n.calls.length, 0);
}

console.log(`통과 ${passed} / 실패 ${failed}`);
if (failed) {
  console.error(`시험 실패 — 위 ${failed}건을 고칠 것.`);
  process.exitCode = 1;
}
