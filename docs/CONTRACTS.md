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

## 5. `app/assets/chart.js` — Canvas 차트 → PNG

외부 차트 라이브러리를 쓰지 않는다. `OffscreenCanvas` 또는 `<canvas>`에 직접 그린다.

```js
export async function renderComparisonChart(rows, opts): Uint8Array   // PNG
```

- 행 구성: 왼쪽 지표명·단위·연도 / 가운데 우리 값·비교평균 / 오른쪽 분포 그래픽
- 분포 그래픽 = Min~Max 위스커(양끝 캡) + IQR 사각형(Q1~Q3) + 평균 원 + 우리 지역 마름모
- 색: 우리 지역 `#c0392b` / 평균 `#1a4f8a` / IQR `#a8c5ff` / 위스커 `#94a3b8` / 설명 `#64748b`
- 배경 흰색 고정(인쇄용). `devicePixelRatio` 무시하고 `scale` 옵션(기본 2)으로 확대
- 글꼴 `"Malgun Gothic","Apple SD Gothic Neo",sans-serif`

## 6. `app/assets/gemini.js` — 개인 키 기반 LLM 호출

`kihasa-indicator-new/static/assets/nlq.js`의 키 관리·모델 폴백 방식을 그대로 승계한다.

```js
export function getKey(): string
export function setKey(key, persist): void        // persist=true면 localStorage, 아니면 sessionStorage
export function keyScope(): 'local'|'session'|''
export async function listModels(key): string[]   // flash 계열 우선 정렬
export async function generate(opts): {model, text}
```

```
opts = { system: string, prompt: string,
         files: [{mimeType, data}],       // attach.js의 inline 그대로
         temperature: 0.3, json: false }
```

- 엔드포인트 `https://generativelanguage.googleapis.com/v1beta`
- 키는 **`x-goog-api-key` 헤더로만** 보낸다. 쿼리스트링 금지
- 모델 목록에서 `exp|experimental|preview|tts|image|embed|live|audio|thinking` 제외
- 429 → 2초 대기 후 다음 모델 / 404 → 즉시 다음 모델 / 키 오류 → 즉시 중단(`err.fatal = true`)
- 지표 **값 데이터는 전송하지 않는다**. 전송 대상은 사용자 입력·첨부파일·절 지시문뿐

## 7. 시험

- `tests/*.mjs` — Node 22에서 `node tests/xxx.mjs`로 바로 돈다. 시험 프레임워크 없음
- 실패는 `process.exitCode = 1` + 사유 출력
- E2E는 Playwright + `/opt/pw-browsers/chromium`. `playwright install` 금지
