# 모듈 계약 (구현 기준)

플랫폼은 **빌드 과정이 없는 순수 정적 웹앱**이다. 외부 CDN·번들러·npm 의존을 쓰지 않는다.
모든 모듈은 브라우저 네이티브 **ES 모듈**(`<script type="module">`)이며 Node 22에서도
그대로 `import` 되어야 한다(헤드리스 시험 때문). 파일 경로는 항상 상대경로.

---

## 0. 공통 규약

- 문자 인코딩 UTF-8, 들여쓰기 2칸, 세미콜론 사용.
- 주석·오류 메시지·UI 문자열은 **한국어 보고서 반말체**. 존대 금지.
- 브라우저 전용 API(`document`, `window`)를 모듈 최상위에서 건드리지 않는다.
  필요하면 함수 안에서 `typeof document !== 'undefined'` 가드를 둔다.
- 바이너리는 항상 `Uint8Array`로 주고받는다. `Blob`·`ArrayBuffer`를 반환하지 않는다.
- 실패는 `throw new Error('한국어 사유')`. 조용한 `null` 반환 금지.

## 1. `app/assets/hwpx-form.js` — 양식 보존 빌더 (JS 이식)

`hwpx_set`의 `hwpx_studio/export_form.py`가 만들어 내는 `build_form.py`(파이썬)를
브라우저로 이식한 것. **`header.xml`을 한 바이트도 건드리지 않고** 템플릿의
지정 구역(본문 구역) 문단만 갈아 끼운다.

```js
export function parseInput(text, form): Parsed
export function lintParsed(parsed, form): string[]      // 경고 문자열 배열
export async function buildForm(templateBytes, form, text, opts): Result
```

- `templateBytes: Uint8Array` — 원본 양식 hwpx
- `form: object` — `form.json` 그대로. `form.section`이 본문 구역 경로
  (이 프로젝트는 `"Contents/section2.xml"`)
- `opts.images: Map<string, Uint8Array>` — 마커 `![](이름)`의 이름 → PNG/JPEG 바이트
- `opts.chapter: string|null` — 장 번호(로마자) 강제 지정
- `Result = { bytes: Uint8Array, issues: string[], warnings: string[] }`

**필수 동작**

| 항목 | 규칙 |
|---|---|
| 레벨 마커 | `form.levels[].marker`로 매칭. 긴 마커 우선 |
| 기호 출력 | `write_marker`가 참인 레벨만 도구가 기호를 찍는다. `auto_bullet`/`auto_number`가 있으면 찍지 않는다(한글이 붙임) |
| 번호매기기 | `numbering`이 `AUTO_ROMAN`/`AUTO_NUM`/`AUTO_HANGUL`/`AUTO_PAREN`이면 도구가 번호 생성 |
| 표 | `\| a \| b \|` 연속행. 바로 앞줄 `{cols=30,35,35}`로 열 너비 비율 지정 가능 |
| 표 주 | 표 바로 다음 줄의 `※ …`는 `form.table_note` 스타일로 |
| 각주 | `[^1]` 참조 + `[^1]: 내용` 정의 |
| 그림 | `![](이름)` → `BinData/` 엔트리 + `<hp:pic>` + `content.hpf` 매니페스트 |
| 앞부분 보존 | `form.preamble_bytes`만큼의 구역 앞부분(용지·머리말·장표지)은 그대로 둔다 |
| 다른 구역 | 본문 구역이 아닌 구역·`header.xml`·`BinData`·`settings.xml`은 손대지 않는다 |

**그림 삽입 XML** (파이썬 `engine.py`와 동일해야 함. 랜덤 ID만 다름)

```
<hp:pic id="..." zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM"
  textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0"
  instid="..." reverse="0"><hp:offset x="0" y="0"/><hp:orgSz .../><hp:curSz .../>
  ... <hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/> ...
```
- 1mm = 283.47 HWPUNIT. 기본 폭 120mm, 높이는 PNG IHDR/JPEG SOF에서 읽은 비율로 계산
- 구역 루트에 `xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"`가 없으면 추가
- `content.hpf`의 `</opf:manifest>` 앞에 `<opf:item id=".." href="BinData/.." media-type=".." isEmbeded="1"/>` 삽입

## 2. `app/assets/catalog.js` — 절 카탈로그

```js
export async function loadCatalog(): Catalog          // app/data/sections.json
export function findSection(catalog, id): Section|null
export function sectionList(catalog): {id,label,depth}[]   // 화면 선택용 평면 목록
export function promptFor(section): string           // AI 시스템 프롬프트 조립
export function blankForms(section): Form[]          // 빈 표 양식만
export function checkLimits(section, markerText): string[]  // 수량 제약 위반
```

`sections.json` 스키마는 `docs/SECTIONS_SCHEMA.md` 참조.

## 3. `app/assets/attach.js` — 첨부파일 추출

```js
export const SUPPORTED = ['hwpx','xlsx','xlsm','csv','pptx','txt','md','html','htm','pdf','png','jpg','jpeg'];
export async function extractAttachment(file): Attachment
```

```
Attachment = {
  name: string, ext: string,
  mode: 'text' | 'inline',        // text=브라우저에서 뽑음 / inline=Gemini로 원본 전송
  text: string,                   // mode='text'일 때 본문
  tables: string[][][],           // 표 목록(행×열 문자열)
  inline: { mimeType: string, data: string } | null,   // base64(패딩 포함, 접두어 없음)
  bytes: number, note: string     // 화면에 띄울 한 줄 설명
}
```

| 확장자 | 처리 |
|---|---|
| `hwpx` | `readback.js`의 `readBack()` → 마커 텍스트 + 표 |
| `xlsx`/`xlsm` | OOXML zip → `xl/sharedStrings.xml` + `xl/worksheets/sheet*.xml` 직접 파싱 |
| `pptx` | OOXML zip → `ppt/slides/slide*.xml`의 `<a:t>` 수집, 슬라이드 단위로 구분 |
| `csv` | RFC 4180(따옴표·이스케이프·개행 포함). BOM 제거. 구분자 자동추정(`,` `\t` `;`) |
| `txt`/`md` | 그대로. BOM 제거 |
| `html`/`htm` | `DOMParser`로 `script`/`style` 제거 후 텍스트 + `<table>` 추출 |
| `pdf`/`png`/`jpg` | 파싱하지 않고 `mode:'inline'`. Gemini `inline_data`로 원본 전송 |

- 외부 라이브러리 금지. zip 해제는 `./zip.js`의 `unzip()` 재사용
- 20MB 초과 파일은 `throw`

## 4. `app/assets/indicator.js` — 지표 분석

```js
export const KEY_CODES = ['A1','A4','A10','B1','B2','B3','B6','B8','B10','B13','B14',
                          'C1','D2','D7','D11','D15','D17','F1','G4','H4','J3','J5'];
export async function loadIndex(): {catalog, regions}
export function groupCodes(regions, basis, baseCode): string[]   // basis: '광역'|'유형'|'전국'
export async function analyze(opts): Row[]
export function narrate(rows, opts): string      // 절 원고용 마커 텍스트(개조식)
```

```
opts = { region: '41110', basis: '광역', codes: KEY_CODES, year: null }
Row  = { code, name, unit, year, mine, avg, q1, q3, min, max, n, rank,
         peerType: {avg, n} | null, nation: {avg, n} }
```

- `year: null`이면 **지표별 최신 연도**(비교집단에 유효값이 하나라도 있는 가장 최근 연도)
- 평균은 시·군·구 **단순평균**. 결측 지역은 분모에서 제외
- `type7`이 `null`인 지역(대구 군위군)은 유형별 비교에서 `peerType: null`
- 사분위수는 선형보간(`(n-1)*p` 방식) — 기존 대시보드 `quantile()`과 동일해야 함

**`narrate()` 원고 규칙** — 지표가 많을 때 전부 같은 무게로 쓰면 무엇이 문제인지 안 보인다.

- 값이 큰 쪽·작은 쪽 3개씩을 먼저 세우고, 남은 지표를 비교집단 **Q1~Q3 구간**으로 가른다
- 구간 **밖**(뚜렷이 다름) — 개별로 쓴다. 구간 **안**(비슷한 수준) — 이름만 한 줄로 묶는다
- 끝에 「종합 진단과 정책 방향」 자리를 둔다. 값의 뜻과 정책은 자료만으로 나오지 않는다
- **빈칸 표시(`○○○○`)는 줄 끝에 둔다.** 줄머리에 두면 한글이 붙이는 글머리표와 겹쳐
  `checkDoubleBullets`의 [이중 기호]로 걸려 산출이 통째로 막힌다

## 5. `app/assets/chart.js` — Canvas 차트 → PNG

외부 차트 라이브러리를 쓰지 않는다. `OffscreenCanvas` 또는 `<canvas>`에 직접 그린다.

```js
export const PER_SHEET = 12                                          // 한 장에 넣는 지표 줄 수 상한
export function chunkRows(rows, per): Row[][]                        // 장 단위로 고르게 가른다
export async function renderComparisonChart(rows, opts): Uint8Array  // PNG
```

- `opts.part = {index, total}` 이면 머리글에 `(1/2쪽)`을 덧붙인다
- `chunkRows`는 **마지막 장만 짧게 남기지 않는다** — 22개를 상한 12로 자르면 12+10이
  아니라 11+11. 그림은 한글에서 폭 120mm로 들어가므로 12줄(세로 167mm)이 한 쪽에
  들어가는 한계다. 22줄을 한 장에 넣으면 294mm라 쪽을 넘겨 잘린다

- 행 구성: 왼쪽 지표명·단위·연도 / 가운데 우리 값·비교평균 / 오른쪽 분포 그래픽
- 분포 그래픽 = Min~Max 위스커(양끝 캡) + IQR 사각형(Q1~Q3) + 평균 원 + 우리 지역 마름모
- 색: 우리 지역 `#c0392b` / 평균 `#1a4f8a` / IQR `#a8c5ff` / 위스커 `#94a3b8` / 설명 `#64748b`
- 배경 흰색 고정(인쇄용). `devicePixelRatio` 무시하고 `scale` 옵션(기본 2)으로 확대
- 글꼴 `"Malgun Gothic","Apple SD Gothic Neo",sans-serif`

## 5-2. `app/assets/trend.js` — 연도별 추이

그림 구성은 `kihasa-indicator-new`의 「연도별 추이 분석」 탭을 따른다. 그쪽은 Plotly를
쓰고 이 도구는 Canvas에 직접 그린다. **색·선 종류·범례 구성만 같게 맞춘다.**

```js
export const CELL_W = 460, CELL_H = 260, PER_SHEET = 4
export function trendSeries(sr, opts): Series
export async function analyzeTrend(opts): Series[]      // 자료를 읽어 계열을 만든다
export function noteworthy(s): number                   // 자동 선정 점수
export function ticksOf(lo, hi): number[]
export function layoutTrend(series, opts): {width, height, scale, ops}
export async function renderTrendChart(series, opts): Uint8Array   // PNG
export function narrateTrend(series, opts): string      // 사실만. 함의는 담당자 자리
```

```
opts   = { region, basis, codes, from, to, limit }
Series = { code, name, unit, years[], mine[], avg[], q1[], q3[], n[], nation[]|null }
```

- 선 규격 — 우리 지역 실선 2.6(점 r3.2) / 비교집단 평균 파선 2 `[5,3]` /
  Q1~Q3 밴드 `#a8c5ff` alpha .45 / 전국 평균 점선 1.6 `[2,3]`
- 비교 기준이 `'전국'`이면 `nation`은 `null` — 같은 선을 두 번 그리지 않는다
- 비교집단이 4곳 미만이면 사분위를 내지 않는다(`q1`/`q3`가 `null`)
- 결측 연도는 선을 끊는다. 값을 이어 붙여 없는 추세를 만들지 않는다
- `limit > 0`이면 `noteworthy` 순으로 고르되 **돌려줄 때는 원래 차례로** 되돌린다.
  선정 순서가 중요도 순서로 읽히면 없는 뜻이 생긴다
- `ticksOf`는 구간을 5로 나눈다. 4로 나누면 간격을 위로 반올림하는 탓에
  두세 줄밖에 안 서는 구간이 생긴다(예: -3.2~1.8 → -2, 0)

## 5-3. `app/assets/cover.js` — 앞표지 구역 떼기

```js
export function hasFront(files): boolean
export async function stripFront(bytes, bodyPath): Uint8Array
export function wantsFront(sectionId): boolean     // 제1장이면 참
```

- 떼는 것 — `Contents/section0.xml`(빈 구역) `section1.xml`(표지·제출문·심의결과서)
  `masterpage0.xml` `masterpage1.xml`
- 남는 본문 구역은 `Contents/section0.xml`로 앞당기고 `content.hpf`(item·itemref)와
  `META-INF/container.rdf`를 그에 맞춰 다시 쓴다
- `settings.xml`의 `CaretPosition`은 첫 문단으로 되돌린다. 지워진 구역을 가리킨 채
  두면 한글이 없는 문단을 찾아간다
- **`header.xml`은 손대지 않는다.** 글꼴·자동 번호매기기가 그대로여야 한다
- 붙일지 말지는 **부르는 쪽이 정해서 `makeDoc(text, images, front)`로 넘긴다.**
  화면의 [앞표지 넣기]는 절 집필 탭 것이라, 다른 탭이 그 값을 보면 만진 값이 따라붙는다

## 5-4. `app/assets/skillpack.js` — 개발도구용 스킬 꾸러미

```js
export const SKILL_NAME = 'rssp-hwpx'
export const CARRIED    // [[저장소 주소, 꾸러미 안 경로], …]
export const WRITTEN    // {꾸러미 안 경로: 글}
export async function buildSkillPack(read): Uint8Array   // .zip
export async function fetchRead(rel): Uint8Array
```

- 빌더 모듈은 **사본을 두지 않는다.** 내려받는 순간 `app/assets`에서 읽어 담으므로
  도구가 고쳐지면 꾸러미도 같이 고쳐진다. 시험이 바이트 일치를 확인한다
- 꾸러미 안 `build.mjs`는 외부 패키지를 쓰지 않는다. Node 22의
  `CompressionStream('deflate-raw')`만 있으면 돈다
- 실어 나를 파일을 못 읽거나 비어 있으면 **조용히 빠뜨리지 않고 오류**를 던진다

## 6. `app/assets/gemini.js` — 개인 키 기반 LLM 호출

`kihasa-indicator-new/static/assets/nlq.js`의 키 관리·모델 폴백 방식을 그대로 승계한다.

```js
export function getKey(): string
export function setKey(key, persist): void        // persist=true면 localStorage, 아니면 sessionStorage
export function keyScope(): 'local'|'session'|''
export function getPreferred(): string            // 마지막에 성공한 모델
export function setPreferred(name): void          // 못 쓰는 이름은 물리치고 빈 값으로
export async function listModels(key): string[]   // flash 계열 우선 정렬
export async function generate(opts): {model, text}
export async function checkKey(key): {ok, models, model, scope, error}
export async function verifyKey({key, model}): {ok, model, models, listed, listError, error, fatal, sample, scope}
```

```
opts = { system: string, prompt: string,
         files: [{mimeType, data}],       // attach.js의 inline 그대로
         temperature: 0.3, json: false, model: '' }
```

- 엔드포인트 `https://generativelanguage.googleapis.com/v1beta`
- 키는 **`x-goog-api-key` 헤더로만** 보낸다. 쿼리스트링 금지
- 모델 목록에서 `exp|experimental|preview|tts|image|embed|live|audio|thinking` 제외
- 모델 이름은 `^[A-Za-z0-9._-]+$`만 받는다(URL 경로에 그대로 들어가는 값이다)
- 429 → 2초 대기 후 다음 모델 / 404 → 즉시 다음 모델 / 키 오류 → 즉시 중단(`err.fatal = true`)
- 지표 **값 데이터는 전송하지 않는다**. 전송 대상은 사용자 입력·첨부파일·절 지시문뿐

**모델 교체 대비**(구글이 이름을 갈아 치워도 멈추지 않게)

| 규칙 | 구현 |
|---|---|
| 이름을 코드에 박지 않는다 | 호출 때마다 `listModels`로 살아 있는 목록을 받는다 |
| 어제 되던 것을 먼저 | `generate` 성공 시 `setPreferred(model)`. 다음 호출에서 목록 맨 앞에 세운다 |
| 죽은 이름은 즉시 버린다 | 그 모델이 404면 `setPreferred('')` |
| 목록이 막혀도 진행 | `listModels` 실패는 치명적이지 않다. `FALLBACK_MODELS`로 계속하고 실패 사유를 최종 오류 메시지에 덧붙인다. 단 키 오류는 예외(즉시 중단) |
| 확인은 실호출로 | `verifyKey`는 목록 조회 뒤 `PING` 프롬프트로 `generateContent`를 한 번 부른다. `model`을 주면 그 이름만 시험한다(폴백을 타지 않아 죽은 이름이 드러난다) |
| 계정 단위 문제는 즉시 중단 | 크레딧 소진(`prepay`·`credits are depleted`·`out of credits`)은 모델을 바꿔도 똑같이 막히므로 `err.fatal = err.billing = true`로 곧바로 던진다. 모델별 일일 한도(`exceeded your current quota … plan and billing`)는 여기 걸리면 안 된다 — 낱말 'billing'이 아니라 크레딧 소진 문구만 집는다 |
| 기본은 이름이 아니라 계열 | `DEFAULT_FAMILY = /flash-lite/`. `defaultModel(models)`가 살아 있는 목록에서 가장 높은 판을 집는다. 판 번호를 상수로 박지 않는다 |
| 내려간 모델은 갈아탄다 | `no longer available`류 오류에서 `replacementIn(msg)`으로 구글이 지목한 이름을 뽑아 그 자리에서 후보 목록에 이어 붙이고, 기억해 둔 묵은 이름은 지운다. `err.retired`/`err.replacement`로 화면에 올린다 |
| 하루 몫 | 429가 `per day`/`PerDay`/`free_tier_requests`면 `markExhausted(model, limit)`하고 쉬지 않고 다음 모델로. 분당 한도는 종전대로 2초 쉬고 넘어간다. 모두 소진이면 `err.quota = err.fatal = true` |
| 이름 검사 | `^[A-Za-z0-9][A-Za-z0-9._-]*$` + `..` 금지. 모델 이름은 URL 경로에 그대로 들어가므로 상위 경로 탈출을 막는다 |

## 6-2. `app/assets/quota.js` — 무료 몫 장부

```js
export const TZ = 'America/Los_Angeles'
export const FREE_TIER, FREE_TIER_SOURCE      // 참고값 + 출처(단정 금지)
export function ptDay(now): string            // 태평양 기준 날짜 = 장부 한 장
export function nextResetAt(now): Date        // 다음 태평양 자정(서머타임 반영)
export function untilReset(now): {ms,hours,minutes,at}
export function resetText(now, locale, tz): string
export function bump(model, now): number      // 성공한 호출 1회 기록
export function markExhausted(model, limit, now): void
export function isExhausted(model, now): boolean
export function usable(models, now): string[]
export function usage(now): {day,total,models,exhausted}
export function limitOf(model, now): {rpd, source:'observed'|'reference'|'unknown'}
export function setVerified(key, now) / isVerified(key, now) / clearVerified(now)
export function fingerprint(key): string      // 키 원문을 저장하지 않기 위한 지문
export function clearUsage(): void
```

- 장부는 `localStorage`의 `gemini_usage` 하나. 막혀 있으면 메모리로 물러난다
- **한도 숫자로 막지 않는다.** `FREE_TIER`는 화면 표시용 참고값이고, 차단 판정은
  구글이 돌려준 429로만 한다. 429 본문에 `limit: N`이 있으면 관측값으로 적어 두고 그 뒤로는 그것을 쓴다
- 날짜가 바뀌면(태평양 자정) 계수·소진 표시·확인 기록이 모두 새 장으로 넘어간다

화면(`app.js`)은 이 계약 위에 `need → busy → ok/fail/off` 상태 띠를 올린다.
`K.verified`가 참일 때만 AI 단추가 열린다.

## 7. 시험

- `tests/*.mjs` — Node 22에서 `node tests/xxx.mjs`로 바로 돈다. 시험 프레임워크 없음
- 실패는 `process.exitCode = 1` + 사유 출력
- E2E는 Playwright + `/opt/pw-browsers/chromium`. `playwright install` 금지
- **자동 생성 원고는 눈으로 읽고 넘기지 않는다.** `narrate()`·`narrateTrend()` 결과를
  `buildForm`에 실제로 넣어 hwpx가 나오는지 본다(`test_trend.mjs`). 줄머리 기호가
  한글 글머리표와 겹치는 [이중 기호] 같은 것은 빌드에서야 터진다
- 스킬 꾸러미는 **압축을 풀어 `build.mjs`를 진짜로 돌려** 확인한다(`test_skillpack.mjs`)

## 8. `app/assets/workspace.js` — 작업 폴더

```js
export function supported(): boolean          // showDirectoryPicker + indexedDB
export async function pick(): string          // 사용자 클릭 안에서만. 취소하면 ''
export async function restore(): {name, need, handle}
export async function grant(handle): string   // 사용자 클릭 안에서만
export async function forget(): void
export function current() / folderName()
export async function saveFile(name, bytes): string
export async function listFiles(ext): [{name, size, at}]
export async function readFile(name): Uint8Array
export async function readJson(name, dflt) / writeJson(name, obj)
```

- 폴더 핸들은 IndexedDB(`rssp_ws/handles/outdir`)에 담는다. JSON으로 못 바꾸므로 구조적 복제로 저장
- **지원하지 않는 브라우저에서 화면이 멈추면 안 된다.** `supported()`가 거짓이면 쓰는 쪽이
  내려받기로 물러난다
- `listFiles`는 `_`·`.`로 시작하는 파일을 뺀다(맥락 장부를 목록에 노출하지 않는다)

## 9. `app/assets/context.js` — 앞 절 결정 사항 카드

```js
export const CARD_FILE = '_맥락.json'
export const DEFAULT_BUDGET = 6000   // 지시문에 들어갈 맥락 글 상한
export const MAX_CARD = 700          // 카드 하나 상한
export const HEADER_SIZE             // 머리말 길이(예산 계산에 포함)
export function cardFrom(node, text, at): Card    // AI를 부르지 않는다
export function mergeCard(cards, card): Card[]
export function scoreCard(target, card, catalog): number
export function pickCards(target, cards, catalog, budget): Card[]
export function contextBlock(cards): string
export function sizeOf(card): number
export const chapterOf = (id) => string
```

- **절 전문을 나르지 않는다.** 담는 것은 이름(전략·사업)·표 골격·요지·수치뿐
- 카드는 `MAX_CARD` 안으로 줄인다. 덜어 내는 차례는 수치 → 요지 → 표 → 이름(마지막까지 지킴)
- `pickCards`는 `HEADER_SIZE`를 미리 빼고 예산을 잰다. 안 그러면 실제 지시문이 상한을 넘는다
- 아직 쓰지 않은 뒤쪽 절 카드는 0점 — 문서 차례를 거슬러 넣지 않는다
- 고른 카드는 **문서 차례대로** 돌려준다
