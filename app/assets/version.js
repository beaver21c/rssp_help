/**
 * 이 화면이 어느 판인가.
 *
 * 왜 필요한가 — 이 도구는 빌드 과정이 없는 정적 페이지다. 주소가 늘 같은 탓에
 * 브라우저가 `assets/*.js`를 캐시에 쥐고 있으면 **새 판을 올려도 열어 둔 탭은
 * 옛 코드를 그대로 돌린다.** 그 상태로 만든 hwpx는 고치기 전과 똑같이 한글에서
 * 「손상된 파일」이 된다. 화면에는 아무 표시가 없으니 담당자는 무엇이 잘못됐는지
 * 알 길이 없다.
 *
 * 그래서 두 자리에 같은 판 번호를 둔다.
 *   · 이 파일의 `BUILD`      — 코드와 함께 캐시된다(옛 탭이면 옛 번호)
 *   · `data/build.json`      — 캐시를 건너뛰고 받아 온다(늘 새 번호)
 * 둘이 어긋나면 이 탭이 옛 코드를 돌리고 있다는 뜻이다.
 *
 * 두 값은 배포할 때 `.github/workflows/pages.yml`이 커밋 해시로 함께 고쳐 쓴다.
 * 손으로 맞추지 않는다.
 */
"use strict";

/** 이 코드가 배포된 판. 배포 때 커밋 해시로 바뀐다. */
export const BUILD = 'dev';

/** 배포된 판 번호를 캐시를 건너뛰고 받아 온다. 못 받으면 null(판정하지 않는다). */
export async function liveBuild() {
  try {
    const r = await fetch(`data/build.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    const v = j && typeof j.build === 'string' ? j.build : null;
    return v || null;
  } catch (e) {
    return null;                       // 망이 끊겼을 뿐일 수 있다. 겁주지 않는다
  }
}

/**
 * 이 탭이 옛 코드를 돌리고 있는가.
 * 돌려주는 값 `{ stale, here, there }` — 판정할 수 없으면 `stale: false`.
 *
 * 개발 중(`BUILD === 'dev'`)에는 판정하지 않는다. 로컬에서 띄울 때마다
 * 「옛 판이다」가 뜨면 진짜 경고를 무시하게 된다.
 */
export async function checkStale(fetchLive = liveBuild) {
  const here = BUILD;
  if (here === 'dev') return { stale: false, here, there: null };
  /* 이 함수는 던지지 않는다. 판 번호를 못 받은 것 때문에 화면이 멈추면
     본래 하려던 일(계획서 산출)까지 막힌다 */
  let there = null;
  try { there = await fetchLive(); } catch (e) { there = null; }
  if (!there) return { stale: false, here, there: null };
  return { stale: there !== here, here, there };
}
