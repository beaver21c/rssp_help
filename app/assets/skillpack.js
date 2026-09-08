/**
 * 클로드 코드·코덱스에 붙여 쓰는 스킬 꾸러미를 만든다.
 *
 * 이 도구는 브라우저 안에서만 돌지만, 담당자가 자기 개발도구(클로드 코드·코덱스)에서
 * 원고를 쓰다가 **그 자리에서 hwpx로 뽑고 싶을 때**가 있다. 그때 붙여 넣을 수 있게
 * 양식·빌더·작성 지시를 한 벌로 묶어 내려준다.
 *
 * 꾸러미에 넣는 빌더는 **이 저장소가 실제로 쓰는 모듈 파일 그대로**다. 사본을 따로
 * 두지 않고 내려받는 순간 `assets/`에서 읽어 담으므로, 이 도구가 고쳐지면 꾸러미도
 * 같이 고쳐진다. 두 벌이 어긋날 자리를 아예 만들지 않는다.
 *
 * 빌더가 Node에서 도는 근거 — `zip.js`는 `CompressionStream('deflate-raw')`만 쓰고,
 * Node 22는 이를 전역으로 가지고 있다. 저장소 시험(`tests/*.mjs`)이 같은 모듈을
 * Node에서 그대로 돌린다.
 */
"use strict";

import { zip } from './zip.js';

/** 꾸러미 안 폴더 이름. 클로드 코드 스킬 이름과 같게 둔다. */
export const SKILL_NAME = 'rssp-hwpx';

/** 저장소에서 그대로 실어 나르는 파일. [내려받을 주소, 꾸러미 안 경로] */
export const CARRIED = [
  ['assets/zip.js', 'lib/zip.js'],
  ['assets/xml.js', 'lib/xml.js'],
  ['assets/formkit.js', 'lib/formkit.js'],
  ['assets/hwpx-form.js', 'lib/hwpx-form.js'],
  ['assets/cover.js', 'lib/cover.js'],
  ['data/template.hwpx', 'assets/template.hwpx'],
  ['data/form.json', 'assets/form.json'],
];

const enc = (s) => new TextEncoder().encode(s);

/* ───────── SKILL.md — 클로드 코드가 읽는 스킬 정의 ───────── */

const SKILL_MD = `---
name: ${SKILL_NAME}
description: 지역사회보장계획 원고를 「제6기 지역사회보장계획 수립 안내」 서식 그대로 hwpx(한글) 파일로 만든다. 계획서·절 원고·지역여건 분석처럼 한글 보고서 산출물이 필요할 때 쓴다. 표지·제출문 붙이기, 개조식 마커 문법, 표·표주·그림 삽입을 함께 처리한다.
---

# 지역사회보장계획 hwpx 산출

원고를 **마커 텍스트**로 쓰고 \`build.mjs\`로 hwpx를 만든다.
서식은 안내서 원본을 템플릿으로 삼아 **본문 구역 문단만 갈아 끼우는** 방식이라
글꼴·자동 번호매기기·표지·제출문이 원본 그대로 유지된다.

## 언제 쓰나

- 지역사회보장계획의 장·절 원고를 한글 파일로 내야 할 때
- 이미 쓴 마커 원고를 안내서 서식에 다시 입힐 때
- 지역여건 분석처럼 표·그림이 섞인 보고서 마디를 낼 때

## 쓰는 법

\`\`\`bash
node build.mjs <원고.txt> <산출.hwpx> [옵션]
\`\`\`

| 옵션 | 뜻 |
|---|---|
| \`--cover\` | 앞표지·제출문·심의결과서를 붙인다. **제1장 산출물에만** 쓴다 |
| \`--image 이름=경로.png\` | 원고의 \`![](이름)\` 자리에 그림을 넣는다(여러 번 쓸 수 있다) |
| \`--chapter 3\` | 장 번호를 강제로 지정한다(로마자로 찍힌다) |

기본값은 표지를 **붙이지 않는다**. 절을 따로따로 뽑아 한글에서 이어 붙이는 방식이라
절마다 표지가 나오면 매번 지워야 하기 때문이다.

\`\`\`bash
# 제1장 — 표지까지
node build.mjs 원고/01-계획수립개요.txt 산출/01-계획수립개요.hwpx --cover

# 제2장 이후 — 본문만
node build.mjs 원고/02-지역분석.txt 산출/02-지역분석.hwpx

# 그림이 있는 마디
node build.mjs 원고/여건분석.txt 산출/여건분석.hwpx \\
  --image indicator1.png=그림/지표1.png --image indicator2.png=그림/지표2.png
\`\`\`

돌리면 원고 검사 결과(계층 균형·기호·표 꼴)를 함께 찍는다.
**경고가 나와도 파일은 나온다.** 경고를 읽고 원고를 고친 뒤 다시 돌린다.

## 원고를 쓸 때

\`reference/마커문법.md\` — 줄머리 기호·표·표주·그림·각주 적는 법
\`reference/작성지시.md\` — 문체·계층·지표 해석·금지 사항

두 문서를 **원고를 쓰기 전에 읽는다.** 특히 다음 셋은 어기면 산출이 막히거나
한글에서 서식이 어긋난다.

1. 제목은 \`#\` \`##\` \`###\` \`####\`, 본문 항목은 \`○\` \`▪\` \`-\` \`·\` 순서로 내려간다.
   단계를 건너뛰지 않는다(\`#\` 다음에 \`###\`은 안 된다).
2. 표 주(\`※ 자료：…\`)는 **표 바로 다음 줄**에만 둔다. 그림 바로 뒤에 두면 검사에 걸린다.
3. 확인되지 않은 통계·법조문·사업명·연도를 지어내지 않는다. 빈칸은 \`○○\`로 둔다.

## 다 만든 뒤

- 산출물은 한글에서 열어 **차례·쪽번호·표 넘침**을 눈으로 본다. 이 도구는 그것까지 보지 않는다.
- 여러 절을 냈으면 한글에서 이어 붙인다. 합본은 이 스킬이 하지 않는다.
`;

/* ───────── AGENTS.md — 코덱스가 읽는 자리 ───────── */

const AGENTS_MD = `# 지역사회보장계획 hwpx 산출 (${SKILL_NAME})

이 폴더는 지역사회보장계획 원고를 한글(hwpx) 파일로 뽑는 도구다.
**한글 보고서 산출물을 만들어 달라는 요청을 받으면 이 도구를 쓴다.**

## 절차

1. \`reference/마커문법.md\`와 \`reference/작성지시.md\`를 읽는다.
2. 원고를 마커 텍스트(\`.txt\`)로 쓴다. 개조식·보고서 반말체를 지킨다.
3. \`node build.mjs <원고.txt> <산출.hwpx>\`로 hwpx를 만든다.
   제1장이면 \`--cover\`를 붙여 표지·제출문을 넣는다.
4. 찍히는 검사 경고를 읽고 원고를 고친 뒤 다시 돌린다.

## 필요한 것

- Node 22 이상. 외부 패키지를 설치하지 않는다(\`npm install\` 필요 없음).
- \`assets/template.hwpx\`(안내서 원본 양식)과 \`assets/form.json\`(서식 지도).
  둘 중 하나라도 없으면 만들지 못한다.

## 하지 않는 것

- 계획서 합본 — 한글에서 이어 붙인다.
- 표지 서식 고치기 — 안내서 원본을 그대로 쓴다.
- 통계 값 만들어 넣기 — 빈칸은 \`○○\`로 둔다.

자세한 사용법은 \`SKILL.md\`와 같다.
`;

/* ───────── 적용 안내 ───────── */

const INSTALL_MD = `# 적용 안내 — 클로드 코드·코덱스에 붙이기

이 꾸러미는 **폴더 하나**다. 어디에 두느냐만 도구마다 다르다.

## 1. 클로드 코드 (Claude Code)

스킬은 \`.claude/skills/<스킬이름>/SKILL.md\`를 읽는다. 두 자리 중 하나에 둔다.

| 두는 자리 | 적용 범위 | 명령 |
|---|---|---|
| \`~/.claude/skills/${SKILL_NAME}/\` | 내 계정 전체 | \`mkdir -p ~/.claude/skills && cp -r ${SKILL_NAME} ~/.claude/skills/\` |
| \`<사업폴더>/.claude/skills/${SKILL_NAME}/\` | 그 사업폴더에서만 | \`mkdir -p .claude/skills && cp -r ${SKILL_NAME} .claude/skills/\` |

여러 사람이 같은 저장소에서 일하면 **사업폴더 쪽**에 두고 함께 관리하는 편이 낫다.

붙였는지 확인 — 클로드 코드에서 \`/\`를 치면 목록에 \`${SKILL_NAME}\`이 보인다.
안 보이면 클로드 코드를 다시 띄운다.

부르는 법은 둘 중 아무거나.
- 그냥 시킨다 — “제2장 지역여건 분석 원고를 hwpx로 만들어라”
  (스킬 설명이 걸려 알아서 발동한다)
- 이름을 댄다 — \`/${SKILL_NAME}\`

## 2. 코덱스 (Codex)

코덱스는 작업 폴더의 \`AGENTS.md\`를 읽는다. 꾸러미를 작업 폴더 안에 두고,
꾸러미의 \`AGENTS.md\` 내용을 작업 폴더의 \`AGENTS.md\`에 이어 붙인다.

\`\`\`bash
cp -r ${SKILL_NAME} <작업폴더>/
cd <작업폴더>
cat ${SKILL_NAME}/AGENTS.md >> AGENTS.md      # 없으면 새로 생긴다
\`\`\`

이어 붙인 뒤 \`AGENTS.md\`에서 경로가 \`${SKILL_NAME}/build.mjs\`를 가리키게
한 줄 고쳐 둔다(꾸러미가 하위 폴더에 있으므로).

## 3. 잘 붙었는지 보기

\`\`\`bash
cd ${SKILL_NAME}
node build.mjs 예시/원고예시.txt /tmp/시험.hwpx
\`\`\`

\`산출: /tmp/시험.hwpx\`가 찍히고 파일이 생기면 된 것이다.
한글에서 열어 표지가 없고 본문만 있는지 본다(\`--cover\` 없이 돌렸으므로).

## 4. 안 될 때

| 증상 | 까닭 | 손볼 곳 |
|---|---|---|
| \`CompressionStream is not defined\` | Node가 낮다 | Node 22 이상으로 올린다 |
| \`템플릿에 Contents/section2.xml이 없다\` | 양식과 \`form.json\`이 짝이 안 맞는다 | \`assets/\` 두 파일을 꾸러미째 다시 내려받는다 |
| \`2층 구조 검사에서 걸렸다\` | 원고 계층·기호가 어긋났다 | 찍힌 사유대로 원고를 고친다 |
| 스킬 목록에 안 보인다 | 자리가 틀렸거나 \`SKILL.md\` 머리말이 깨졌다 | 경로를 다시 보고 클로드 코드를 재시작한다 |

## 5. 이 꾸러미와 웹 도구의 관계

꾸러미의 \`lib/\`는 웹 도구가 실제로 쓰는 모듈 파일 그대로다(사본이 아니라 같은 파일).
서식이 바뀌면 웹 도구에서 다시 내려받으면 된다.

- 웹 도구: https://beaver21c.github.io/rssp_help/
- 웹 도구가 더 하는 일 — 절별 작성 지침 자동 첨부, 지표 22개 비교 분석과 그래프,
  연도별 추이, 이미 쓴 문서 되돌려 점검하기.
- 이 꾸러미가 하는 일 — **원고 → hwpx 산출**, 그 하나.
`;

/* ───────── 마커 문법 ───────── */

const SYNTAX_MD = `# 마커 문법

원고는 그냥 텍스트 파일이다. 줄머리 기호로 계층을 나타낸다.

## 1. 제목

\`\`\`
# 제1장 계획 수립 개요
## 1. 계획의 배경
### 가. 법적 근거
#### (1) 사회보장급여법
\`\`\`

- \`#\`부터 \`####\`까지 넉 단계. **단계를 건너뛰지 않는다.**
- 번호는 안내서 서식이 자동으로 붙이는 자리가 있다. 제목 글만 적어도 되는 자리와
  직접 적어야 하는 자리가 있으므로, 산출한 뒤 한글에서 눈으로 본다.

## 2. 본문 항목

\`\`\`
○ 큰 항목
- 그 아래 항목
· 더 아래 항목
▪ 강조 항목
\`\`\`

- 위에서 아래로 \`○\` → \`▪\` → \`-\` → \`·\`.
- 기호 뒤에 **빈칸 한 칸**을 둔다(\`○ 내용\`, \`○내용\`은 안 된다).
- **기호 바로 뒤에 또 기호를 두지 않는다.** 한글이 글머리표를 붙이는 단계인데
  본문까지 기호로 시작하면 [이중 기호]로 걸려 산출이 통째로 막힌다.

  \`\`\`
  - ○○○○ (무엇을 채울지)      ← 막힌다
  - 무엇을 채울지 → ○○○○      ← 이렇게 쓴다
  \`\`\`

  빈칸 표시(\`○○\`)는 **줄 끝**에 둔다.

## 3. 표

\`\`\`
{cols=30,35,35}
| 구분 | 2023년 | 2024년 |
|---|---|---|
| 인구수 | 1,190,000 | 1,185,000 |
| 노인 비율 | 14.2% | 15.0% |
※ 자료：통계청, 「주민등록인구현황」, 2024.
\`\`\`

- 머리행 → 구분선(\`|---|---|\`) → 자료 행 차례.
- \`{cols=…}\`는 **표 바로 앞줄**에 두는 열 너비 비율(합이 100이 되게).  없어도 된다.
- \`※\`로 시작하는 표 주는 **표 바로 다음 줄**에만 둔다. 다른 자리에 두면 검사에 걸린다.
- 숫자는 천 단위 쉼표를 찍고 단위를 붙인다.

## 4. 그림

\`\`\`
![](indicator1.png)
\`\`\`

- 괄호 안은 **이름표**다. 파일 경로가 아니다.
- 실제 파일은 \`--image indicator1.png=그림/지표1.png\` 로 이어 준다.
- 폭 120mm로 들어가고 높이는 원본 비율대로 계산한다.
  세로가 길면 한글이 다음 쪽으로 넘긴다 — 한 쪽에 앉히려면 세로/가로가 2 아래여야 한다.
- 그림 바로 뒤에 \`※\`를 두지 않는다(표 주 자리로 읽힌다). 그림 설명은 \`○\`로 적는다.

## 5. 각주

\`\`\`
지역사회보장협의체[^1]가 심의한다.

[^1]: 「사회보장급여의 이용·제공 및 수급권자 발굴에 관한 법률」 제41조.
\`\`\`

참조(\`[^1]\`)와 정의(\`[^1]: …\`)를 짝으로 둔다.

## 6. 장 표지

\`\`\`
[장: 계획 수립 개요]
\`\`\`

맨 위에 두면 장 표지의 제목이 바뀐다. 장 번호(로마자)는 \`--chapter\`로 준다.

## 7. 빈 줄

빈 줄은 문단을 나누는 뜻이 없다. 읽기 좋으라고 넣는 것이며 산출물에는 영향이 없다.
`;

/* ───────── 작성 지시 ───────── */

const WRITING_MD = `# 작성 지시

## 1. 문체

- **개조식**으로 쓴다. 줄글 서술을 늘어놓지 않는다.
- **보고서 반말체**(“~한다”, “~이다”)로 맺는다. 존대·구어는 쓰지 않는다.
- 조사는 뜻 전달에 꼭 필요할 때만 남긴다(“분석을 실시함” → “분석 실시”).
- 접속사(“그리고”, “따라서”) 대신 화살표(→)·빗금(/)·더하기(+)를 쓴다.
- 종결을 “~함”, “~임”으로만 맺지 않는다. 명사형 종결(“도입 시급”)과
  괄호 부연(“(익월 예정)”)을 섞는다.
- “다양한”, “효율적인” 같은 두루뭉술한 형용사 대신 숫자·고유명사·기관명을 쓴다.
- 사회복지·보건복지 분야의 학술 용어를 쓴다.

## 2. 계층

한 마디 안에서 단계를 건너뛰지 않는다.

\`\`\`
### 가. 인구 구조
○ 총인구 1,185천 명 (2024년 기준)
- 최근 5년 연 0.4% 감소 → 2019년 대비 2.1% 축소
· 감소 폭은 원도심(△4.8%)에 몰려 있음
\`\`\`

같은 단계 항목이 하나뿐이면 단계를 만들지 않는다.
\`○\` 아래에 \`-\`가 하나만 오면 그냥 \`○\` 한 줄로 쓴다.

## 3. 지표를 해석할 때

**지표 값을 그대로 옮겨 적는 일은 최소로 한다.** 그 값이 무엇을 뜻하는지가 본문이다.

순서를 이렇게 잡는다.

1. **비교** — 다른 지역(광역 내 시·군·구, 유사 유형, 전국)과 견주어 어디에 서 있는가
2. **진단** — 그 위치가 우리 지역의 무엇을 말하는가
3. **함의** — 그래서 어떤 정책·사업 방향이 필요한가

\`\`\`
○ 노인 인구 비율 15.24% — 경기도 31개 시·군 평균 20.12%보다 4.9%p 낮음
- 도내 하위권이나 2018년 9.8% → 2025년 15.2%로 7년간 5.4%p 상승(도내 상승 폭 상위)
- 현재 부담은 낮으나 진입 속도가 빨라, 시설 확충보다 **예방·건강관리 선투자**가 유효
\`\`\`

### 지표가 많을 때(20개 이상·22개 전체)

전부 같은 무게로 쓰면 읽는 사람이 무엇이 문제인지 못 찾는다.

- **비교집단과 비슷한 수준**(Q1~Q3 구간 안)인 지표 — 이름만 묶어 한 줄로 적고 넘어간다.
- **뚜렷이 다른 지표**(Q1~Q3 구간 밖) — 개별로 쓰되, 위 1~3 순서를 지킨다.
- 마지막에 **종합 진단과 정책 방향**을 따로 둔다. 지표별 서술을 반복하지 않고,
  묶어서 무엇이 우리 지역의 과제인지 적는다.

### 연도별 추이를 쓸 때

- 시작 연도 값 → 끝 연도 값 → 방향(증가/감소/큰 변화 없음)과 폭을 먼저 적는다.
- 그다음 **비교집단의 같은 기간 움직임과 견준다**. 우리만 오르는지, 다 같이 오르는데
  우리가 더 빠른지가 다른 이야기다.
- 마지막에 그 흐름이 정책에 무엇을 뜻하는지 적는다.

## 4. 표

- 안내서가 정한 표 말고 새 표를 만들지 않는다.
- 표 바로 아래에 \`※ 자료：<기관>, 「<자료명>」, <연도>.\` 꼴로 출처를 단다.
- 표 안에서 값이 없으면 \`-\`로 둔다. 0과 구별한다.

## 5. 금지

- 지시에 없는 표를 만들지 않는다.
- **확인되지 않은 통계·법조문·사업명·연도를 지어내지 않는다.**
  근거를 못 찾으면 빈칸을 \`○○\`로 두고 무엇을 채워야 하는지 적는다.
- 지표 해석에서 원인을 단정하지 않는다. 자료로 확인되지 않은 인과는
  “~로 보인다”, “~일 가능성” 처럼 지위를 밝혀 적는다.
- 다른 지자체 계획서 문장을 그대로 옮기지 않는다.
`;

/* ───────── 예시 원고 ───────── */

const SAMPLE_TXT = `# 제2장 지역사회보장 여건 분석

## 1. 지역 일반 현황

### 가. 인구 구조

○ 총인구 ○○○천 명 (○○○○년 ○○월 기준)
- 최근 5년 연평균 ○.○% 변동 → ○○○○년 대비 ○.○% 증감
- 노인(65세 이상) 인구 비율 ○○.○% — 광역 내 시·군·구 평균 ○○.○% 대비 ○.○%p 차이

{cols=34,33,33}
| 구분 | ○○○○년 | ○○○○년 |
|---|---|---|
| 총인구(명) | ○○○,○○○ | ○○○,○○○ |
| 노인 인구 비율(%) | ○○.○ | ○○.○ |
※ 자료：행정안전부, 「주민등록인구현황」, ○○○○.

○ 진단 — ○○○○
- 비교집단과의 차이가 우리 지역에 무엇을 뜻하는지 → ○○○○
- 그래서 어떤 정책·사업 방향이 필요한지 → ○○○○

### 나. 지역사회보장지표 비교

![](indicator1.png)

○ 비교 기준 — ○○도 ○○시, 광역(시·도) 내 비교, 대상 지표 ○○개
`;

/* ───────── build.mjs — 꾸러미 안에서 도는 CLI ───────── */

const BUILD_MJS = `#!/usr/bin/env node
/**
 * 마커 원고 → hwpx.
 *
 *   node build.mjs <원고.txt> <산출.hwpx> [--cover] [--chapter N]
 *                  [--image 이름=경로.png ...]
 *
 * 외부 패키지를 쓰지 않는다. Node 22 이상이면 그대로 돈다
 * (\`CompressionStream('deflate-raw')\`을 전역으로 가지고 있어야 한다).
 *
 * lib/ 아래 모듈은 웹 도구(https://beaver21c.github.io/rssp_help/)가 쓰는 것과 같은 파일이다.
 */
"use strict";

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildForm } from './lib/hwpx-form.js';
import { stripFront } from './lib/cover.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function usage(why) {
  if (why) console.error('오류 — ' + why + '\\n');
  console.error([
    '쓰는 법  node build.mjs <원고.txt> <산출.hwpx> [옵션]',
    '',
    '  --cover                앞표지·제출문을 붙인다 (제1장 산출물에만)',
    '  --chapter N            장 번호를 강제로 지정한다',
    '  --image 이름=경로.png   원고의 ![](이름) 자리에 넣을 그림 (여러 번 가능)',
    '',
    '보기  node build.mjs 원고/02-여건분석.txt 산출/02-여건분석.hwpx \\\\',
    '        --image indicator1.png=그림/지표1.png',
  ].join('\\n'));
  process.exit(why ? 1 : 0);
}

function parseArgs(argv) {
  const out = { cover: false, chapter: undefined, images: new Map(), rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cover') out.cover = true;
    else if (a === '--help' || a === '-h') usage(null);
    else if (a === '--chapter') { out.chapter = argv[i += 1]; }
    else if (a === '--image') {
      const pair = argv[i += 1] || '';
      const at = pair.indexOf('=');
      if (at < 1) usage(\`--image 는 이름=경로 꼴로 준다 (받은 값: \${pair})\`);
      out.images.set(pair.slice(0, at), pair.slice(at + 1));
    } else if (a.startsWith('--')) usage(\`모르는 옵션 \${a}\`);
    else out.rest.push(a);
  }
  return out;
}

const opt = parseArgs(process.argv.slice(2));
if (opt.rest.length !== 2) usage('원고 파일과 산출 파일 두 개를 준다');
const [srcPath, outPath] = opt.rest;

const need = (p, what) => {
  if (!fs.existsSync(p)) { console.error(\`오류 — \${what}을(를) 찾지 못했다: \${p}\`); process.exit(1); }
  return p;
};

const text = fs.readFileSync(need(srcPath, '원고 파일'), 'utf8');
const template = new Uint8Array(fs.readFileSync(
  need(path.join(HERE, 'assets/template.hwpx'), '양식 파일(assets/template.hwpx)')));
const form = JSON.parse(fs.readFileSync(
  need(path.join(HERE, 'assets/form.json'), '서식 지도(assets/form.json)'), 'utf8'));

const images = new Map();
for (const [name, file] of opt.images) {
  images.set(name, new Uint8Array(fs.readFileSync(need(file, \`그림 파일(\${name})\`))));
}

const res = await buildForm(template, form, text, {
  images, chapter: opt.chapter === undefined ? undefined : opt.chapter,
});

let bytes = res.bytes;
if (!opt.cover) bytes = await stripFront(bytes, form.section);

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, bytes);

const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB');
console.log(\`산출: \${outPath} (\${kb(bytes.length)})\` + (opt.cover ? ' · 표지 포함' : ' · 본문만'));
if (images.size) console.log(\`그림 \${images.size}개 삽입\`);

const notes = [...(res.issues || []), ...(res.warnings || [])];
if (notes.length) {
  console.log(\`\\n검사 \${notes.length}건 — 파일은 나왔다. 아래를 읽고 원고를 고친 뒤 다시 돌린다.\`);
  notes.forEach((m) => console.log('  · ' + m));
} else {
  console.log('검사 통과 — 걸린 것 없음');
}
console.log('\\n한글에서 열어 차례·쪽번호·표 넘침을 눈으로 볼 것.');
`;

/* 원고 파일과 그림을 담을 빈 자리. ZIP은 빈 폴더를 못 담으므로 안내문을 한 장 둔다 */
const WORKDIR_MD = `이 폴더에 마커 원고(\`.txt\`)와 그림(\`.png\`)을 둔다.

    node build.mjs 원고/내원고.txt 산출/내원고.hwpx
`;

/** 꾸러미에 들어가는, 이 파일이 지어내는 문서들 */
export const WRITTEN = {
  'SKILL.md': SKILL_MD,
  'AGENTS.md': AGENTS_MD,
  '적용안내.md': INSTALL_MD,
  'build.mjs': BUILD_MJS,
  'reference/마커문법.md': SYNTAX_MD,
  'reference/작성지시.md': WRITING_MD,
  '예시/원고예시.txt': SAMPLE_TXT,
  '원고/README.md': WORKDIR_MD,
};

/**
 * 꾸러미 ZIP 바이트를 만든다.
 * @param {(rel:string)=>Promise<Uint8Array>} read 저장소 파일 읽기(주소 → 바이트)
 */
export async function buildSkillPack(read) {
  if (typeof read !== 'function') throw new Error('파일 읽기 함수를 받지 못했다');
  const files = new Map();
  for (const [name, body] of Object.entries(WRITTEN)) {
    files.set(`${SKILL_NAME}/${name}`, enc(body));
  }
  for (const [from, to] of CARRIED) {
    let data;
    try {
      data = await read(from);
    } catch (e) {
      throw new Error(`꾸러미에 넣을 ${from} 을(를) 읽지 못했다 — ${e.message}`);
    }
    if (!data || !data.length) throw new Error(`꾸러미에 넣을 ${from} 이(가) 비어 있다`);
    files.set(`${SKILL_NAME}/${to}`, data);
  }
  return zip(files);
}

/** 브라우저에서 쓰는 기본 읽기 — 같은 출처의 정적 파일을 그대로 가져온다. */
export async function fetchRead(rel) {
  const r = await fetch(rel);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
