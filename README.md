# 지역사회보장계획 작성지원 플랫폼

제6기(2027~2030) **시·군·구** 지역사회보장계획을 장·절 단위로 작성해 한글 문서(.hwpx)로
산출하는 도구. 설치 없이 브라우저에서 돌고, 계획서 원고·첨부파일·API 키는 기기 밖으로
나가지 않는다(Gemini 호출만 예외).

## 세 가지 기능

| | 무엇 | 어떻게 |
|---|---|---|
| ① | **AI로 절 쓰기** | 절을 고르면 「수립 안내」의 해당 절 작성 지침과 표 양식이 자동으로 붙는다. 요청·참고 원문·첨부파일을 넣어 초안을 만들고, 검사를 통과하면 그 절만 hwpx로 낸다 |
| ② | **지표로 지역여건 분석** | 시·군·구를 고르면 「지역사회보장지표」 핵심 22개를 비교집단과 대조해 그래프를 그리고, 그림이 박힌 절 hwpx를 낸다 |
| ③ | **양식 점검·수정** | 이미 쓴 hwpx를 올리면 마커 원고로 되돌려 계층·기호·표 양식·수량 제약을 검사하고, 안내서 서식을 다시 입혀 낸다 |

합본은 만들지 않는다. 장·절 단위로 내고 한글에서 이어 붙인다.

## 서식이 어떻게 지켜지는가

산출물은 **안내서 원본을 템플릿으로 두고 본문 구역(`Contents/section2.xml`)의 문단만
갈아 끼우는** 방식으로 만든다. `header.xml`을 한 바이트도 건드리지 않으므로 글꼴·한글
자동 번호매기기·자동 글머리표·쪽 설정이 원본 그대로 남는다. 표지·제출문·심의결과서·
발간사도 그대로 유지된다.

서식을 JSON으로 베껴 새 문서를 짓는 방식(프로파일 방식)은 쓰지 않는다. 안내서가 한글의
`hh:heading` 자동 번호매기기를 쓰고 있어 그 방식으로는 번호가 사라지기 때문이다.

**전략체계도**(27×29·16×15)는 칸을 잘게 나눠 병합하고 칸마다 테두리를 달리 준 표라 글로
받아쓸 수 없다. 그래서 안내서의 그 문단을 통째로 떼어 두었다가(`app/data/layout/*.xml`)
산출할 때 그대로 끼워 넣는다. `header.xml`이 같으므로 병합·테두리·글꼴이 원본 그대로
살아나고, 담당자는 한글에서 칸의 글자만 고치면 된다.

## 여는 법

빌드 과정이 없다. `app/`을 정적으로 서빙하면 그대로 돈다.

```bash
python3 -m http.server 8000 --directory app     # http://localhost:8000
```

GitHub Pages로 배포하려면 저장소 Settings → Pages → Source를 **GitHub Actions**로 두면
`.github/workflows/pages.yml`이 `app/`을 올린다.

## Gemini API 키

기능 ①과 문장 다듬기에만 쓴다. 키가 없어도 **②와 ③은 그대로 동작**한다.

- 키는 브라우저 저장소에만 둔다. 기본은 세션 저장(탭을 닫으면 삭제), 선택하면 이 브라우저에 유지
- 요청은 `x-goog-api-key` 헤더로만 보낸다. 주소창·리퍼러·프록시 기록에 남지 않는다
- 모델은 실행 시점에 목록을 조회해 무료 한도가 높은 flash 계열 최신 안정판을 고르고,
  한도 초과(429)·지원 중단(404)이면 다음 모델로 넘어간다

## 첨부파일

| 형식 | 처리 |
|---|---|
| `hwpx` `xlsx` `pptx` `csv` `txt` `md` `html` | **브라우저 안에서** 텍스트·표를 뽑는다. 파일이 밖으로 나가지 않는다 |
| `pdf` `png` `jpg` | 파싱하지 않고 **원본을 Gemini로 보낸다**. 미공개 자료는 올리기 전에 확인할 것 |
| `hwp` | 읽지 못한다. 한글에서 [다른 이름으로 저장] → HWPX 문서로 저장할 것 |

외부 라이브러리를 쓰지 않는다. xlsx·pptx는 OOXML(zip+XML)을 직접 뜯어 읽는다.

## 폴더

```
app/                        # ★ 배포 대상. 이 폴더만 웹에 올라간다
├── index.html
├── assets/
│   ├── app.js              # 화면 제어
│   ├── catalog.js          # 절 카탈로그(지침·표 양식·수량 제약)
│   ├── hwpx-form.js        # 양식 보존 빌더(build_form.py의 브라우저 이식 + 그림 삽입)
│   ├── attach.js           # 첨부파일 추출
│   ├── indicator.js        # 지표 산출·비교
│   ├── chart.js            # Canvas 비교 그래프 → PNG
│   ├── gemini.js           # 개인 키 기반 LLM 호출
│   ├── docread.js          # 올린 hwpx를 본문 구역만 마커 원고로 되돌리기
│   ├── rawblock.js         # 안내서 체계도를 원본 XML 그대로 끼워 넣기
│   ├── style.css
│   └── (hwpx_set 이식본) zip.js xml.js hwpx-studio.js readback.js formkit.js hwpx-assets.js
└── data/
    ├── sections.json       # 절 카탈로그(안내서에서 기계 추출)
    ├── form.json           # 양식 카드
    ├── template.hwpx       # 배포용 템플릿(본문 비움)
    ├── catalog.json regions.json series/*.json    # 지역사회보장지표
tools/build_catalog.py      # 안내서 → sections.json + template.hwpx + layout/*.xml
tools/make_xlsx_fixture.py  # 첨부 시험용 엑셀 고정 자료 다시 만들기
tests/                      # 시험(프레임워크 없음. node/python으로 바로 실행)
docs/CONTRACTS.md           # 모듈 계약
docs/SECTIONS_SCHEMA.md     # sections.json 스키마
docs/BACKLOG.md             # 다음 과제 — 왜 지금 안 되는지, 무엇이 있어야 되는지
source/                     # 원본 안내서(웹 미공개)
```

## 시험

```bash
python3 tests/test_catalog.py        # 카탈로그 추출 결과·템플릿 무결성
node tests/test_form_parity.mjs      # 양식 보존 빌더가 파이썬판과 같은 XML을 내는가
node tests/test_docread.mjs          # 되돌리기 — 본문 구역만·마커 왕복       (27건)
node tests/test_attach.mjs           # 첨부파일 추출                         (139건)
node tests/test_indicator.mjs        # 지표 산출·비교집단·차트                (59건)
node tests/test_catalog_js.mjs       # 절 카탈로그 소비 모듈                  (79건)
node tests/test_gemini.mjs           # 키 관리·모델 폴백(가짜 fetch)          (105건)
node tests/test_e2e.mjs              # 브라우저에서 65개 마디 전부 산출        (708건)
```

`test_e2e.mjs`는 Chromium을 띄워 실제 화면을 조작한다. 마디마다 양식을 넣고 hwpx를
받아 열어 보며 ①표지·제출문·글꼴이 원본과 해시가 같은지 ②안내서가 정한 표가 다
들어갔는지 ③열 수와 머리행이 그대로인지 ④전략체계도가 칸 병합·테두리째 들어갔는지를
확인한다. `--max=3`으로 줄여 돌릴 수 있고
`--only=02-나-1`로 한 마디만 볼 수도 있다.

최근 실행 결과 — 65/65 마디 산출, 단언 708건 전부 통과.

## 산출 방식에 관한 주의

- 지표의 모든 "평균"은 시·군·구 **단순평균**(unweighted)이며 시·도 공식 소계와 산출 방식이 다르다
- 예산 관련 데이터의 시·도 행은 본청값이라 화면에서는 시·군·구 값만 쓴다
- 지표마다 생산 주기가 달라(2025·2024 혼재) 연도를 고정하지 않고 **지표별 최신값**을 쓰고 연도를 병기한다
- 대구광역시 군위군은 시·군·구 7대 유형이 부여돼 있지 않아 유형별 비교에서 빠진다(광역·전국 비교는 정상)
- 아직 못 붙인 것들은 `docs/BACKLOG.md`에 사유와 함께 적어 두었다
- AI가 쓴 문장은 초안이다. 통계·법조문·사업명은 반드시 담당자가 확인한다

## 출처

- 보건복지부, 「제6기(2027~2030) 지역사회보장계획 수립 안내 [시·군·구]」 — 절 구조·표 양식·작성 지침
- 보건복지부·한국보건사회연구원, 「지역사회보장지표」 — 지표 데이터
  ([kihasa-indicator-new](https://github.com/beaver21c/kihasa-indicator-new))
- [beaver21c/hwpx_set](https://github.com/beaver21c/hwpx_set) — hwpx 생성·해부 엔진 (Apache-2.0)
