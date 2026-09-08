/* 지역사회보장지표 분석 엔진 — docs/CONTRACTS.md 4장 계약 구현.
   산출 수치는 기존 대시보드(kihasa-indicator-new/static/assets/app.js)와 한 자리도
   어긋나면 안 된다. quantile·boxStats·latestYearOf·valAt·fmtRef는 그쪽 구현을 그대로 옮겼다.
   외부 라이브러리를 쓰지 않고, 브라우저와 Node 22에서 똑같이 돈다. */
"use strict";

/* 핵심지표 22개 — 대시보드 「지역별 지표 현황」 기본 화면과 같은 목록·순서 */
export const KEY_CODES = ['A1', 'A4', 'A10', 'B1', 'B2', 'B3', 'B6', 'B8', 'B10', 'B13', 'B14',
  'C1', 'D2', 'D7', 'D11', 'D15', 'D17', 'F1', 'G4', 'H4', 'J3', 'J5'];

/* ───────── 공용 계산 (대시보드 app.js와 동일) ───────── */

/* 사분위수 — 선형보간((n-1)*p 방식). 대시보드와 값이 달라지면 안 된다 */
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

/* 큰 수 축약 표기(조·억). 대시보드 fmt()와 동일 */
export function fmt(v, unit) {
  if (v == null) return '—';
  const u = unit ? ` ${unit}` : '';
  const av = Math.abs(v);
  if (av >= 1e12) return (v / 1e12).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + '조' + u;
  if (av >= 1e8) return (v / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '억' + u;
  if (av >= 1000 || Number.isInteger(v)) return v.toLocaleString('ko-KR') + u;
  return v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + u;
}

/* 참조본 표기 규칙: 1000 이상 정수, 100 이상 소수1, 그 미만 소수2. 1억 이상은 축약 */
export function fmtRef(v) {
  if (v == null || isNaN(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e8) return fmt(v, '');
  if (a >= 1000) return v.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  if (a >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

/* 오름차순 배열 → 박스플롯 통계 */
export function boxStats(sorted) {
  if (!sorted.length) return null;
  const n = sorted.length;
  return {
    min: sorted[0], max: sorted[n - 1], avg: mean(sorted),
    q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75), n,
  };
}

/* 계열에서 한 지역·한 연도 값 뽑기. 없으면 null */
export function valAt(sr, code, year) {
  const a = sr.values[code];
  if (!a) return null;
  const j = sr.years.indexOf(year);
  return j < 0 ? null : a[j];
}

/* 지표별 최신 연도 — 비교집단에 유효값이 하나라도 있는 가장 최근 연도.
   지표마다 생산 주기가 달라 연도를 고정하면 빈 행이 생긴다 */
export function latestYearOf(sr, grp) {
  for (let i = sr.years.length - 1; i >= 0; i--) {
    const y = sr.years[i];
    if (grp.some((c) => valAt(sr, c, y) != null)) return y;
  }
  return sr.years[sr.years.length - 1];
}

/* ───────── 데이터 적재 ───────── */

const DATA_DIR = new URL('../data/', import.meta.url);
const _cache = { index: null, series: new Map() };

/* 브라우저면 fetch, Node면 fs. window 유무로 갈린다(fetch는 Node 22에도 있으므로 기준이 못 된다) */
async function readJSON(rel) {
  const url = new URL(rel, DATA_DIR);
  if (typeof window !== 'undefined') {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${rel} 을(를) 읽지 못했다 — HTTP ${r.status}`);
    return r.json();
  }
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    import('node:fs/promises'), import('node:url'),
  ]);
  let text;
  try {
    text = await readFile(fileURLToPath(url), 'utf8');
  } catch (e) {
    throw new Error(`${rel} 을(를) 읽지 못했다 — ${e.message}`);
  }
  return JSON.parse(text);
}

/* 지표 목록·지역 목록. 두 번째 호출부터는 캐시를 준다 */
export async function loadIndex() {
  if (_cache.index) return _cache.index;
  const [catalog, regions] = await Promise.all([
    readJSON('catalog.json'), readJSON('regions.json'),
  ]);
  if (!catalog || !Array.isArray(catalog.items)) throw new Error('catalog.json 모양이 계약과 다르다');
  if (!Array.isArray(regions) || !regions.length) throw new Error('regions.json 모양이 계약과 다르다');
  _cache.index = { catalog, regions };
  return _cache.index;
}

/* 지표 하나의 시계열. 없는 코드는 null을 주지 않고 오류를 던진다 */
export async function loadSeries(code) {
  if (_cache.series.has(code)) return _cache.series.get(code);
  /* 실패한 약속을 캐시에 남기면 한 번 끊긴 뒤로는 그 지표를 영영 못 읽는다.
     어긋나면 캐시에서 빼서 다음 호출이 다시 시도하게 둔다 */
  const p = readJSON(`series/${code}.json`).then((sr) => {
    if (!sr || !Array.isArray(sr.years) || !sr.values) throw new Error(`${code} 계열 모양이 계약과 다르다`);
    return sr;
  }).catch((e) => { _cache.series.delete(code); throw e; });
  _cache.series.set(code, p);
  return p;
}

/* ───────── 비교집단 ───────── */

const sggAll = (regions) => regions.filter((r) => r.level === '시군구');

/* basis: '광역' | '유형' | '전국'. 돌려주는 것은 시·군·구 코드 배열 */
export function groupCodes(regions, basis, baseCode) {
  const all = sggAll(regions);
  const b = regions.find((r) => r.code === baseCode);
  if (basis === '광역') return all.filter((r) => b && r.sido === b.sido).map((r) => r.code);
  if (basis === '유형') return all.filter((r) => b && r.type7 != null && r.type7 === b.type7).map((r) => r.code);
  return all.map((r) => r.code);
}

export const basisLabel = (b) => ({ 전국: '전국', 광역: '광역(시·도) 내', 유형: '시·군·구 유형별' })[b] || b;

export function regionOf(regions, code) {
  return regions.find((r) => r.code === code) || null;
}

export function regionName(regions, code) {
  const r = regionOf(regions, code);
  return r ? (r.level === '시도' ? r.sido : `${r.sido} ${r.sigungu}`) : String(code);
}

export function typeLabel(catalog, type7) {
  if (type7 == null) return null;
  return (catalog.type7_labels || {})[String(type7)] || null;
}

/* ───────── 분석 ───────── */

/* opts = { region, basis, codes, year }
   year 가 null 이면 지표별 최신 연도를 각각 쓴다 */
export async function analyze(opts) {
  const o = opts || {};
  const { catalog, regions } = await loadIndex();
  const region = regionOf(regions, o.region);
  if (!region) throw new Error(`지역 코드 ${o.region} 을(를) 찾지 못했다`);
  if (region.level !== '시군구') throw new Error('분석 대상은 시·군·구여야 한다');

  const basis = o.basis || '전국';
  if (!['전국', '광역', '유형'].includes(basis)) throw new Error(`비교 기준 ${basis} 은(는) 쓸 수 없다`);
  if (basis === '유형' && region.type7 == null) {
    throw new Error(`${regionName(regions, region.code)}은(는) 시·군·구 유형이 없어 유형별 비교를 쓸 수 없다`);
  }

  /* 연도는 숫자나 null 만 받는다. 화면 <select> 값처럼 문자열이 들어오면
     indexOf 가 어긋나 모든 줄이 조용히 빈 값이 되므로 여기서 걸러 낸다 */
  let want = o.year;
  if (want != null) {
    want = Number(want);
    if (!Number.isFinite(want)) throw new Error(`연도 ${o.year} 을(를) 숫자로 읽지 못했다`);
  }

  const codes = (o.codes && o.codes.length) ? o.codes.slice() : KEY_CODES.slice();
  const grp = groupCodes(regions, basis, region.code);
  if (!grp.length) throw new Error('비교집단이 비어 있다');
  const nation = groupCodes(regions, '전국', region.code);
  const peer = region.type7 == null ? null : groupCodes(regions, '유형', region.code);

  const settled = await Promise.all(codes.map((c) => loadSeries(c).then(
    (sr) => ({ code: c, sr }), (e) => ({ code: c, err: e }))));
  const okOnes = settled.filter((s) => s.sr);
  if (!okOnes.length) throw new Error('산출할 수 있는 지표 계열이 하나도 없다');

  const itemOf = (code) => catalog.items.find((i) => i.code === code) || null;
  const rows = [];
  for (const { code, sr } of okOnes) {
    const it = itemOf(code);
    const year = (want == null) ? latestYearOf(sr, grp) : want;
    const vals = grp.map((c) => valAt(sr, c, year)).filter((v) => v != null).sort((a, b) => a - b);
    const st = boxStats(vals);
    const mine = valAt(sr, region.code, year);

    /* 순위는 대시보드와 같이 내림차순(값이 큰 쪽이 1위). 우리 값이 없으면 순위도 없다 */
    let rank = null;
    if (mine != null && st) {
      rank = grp.map((c) => valAt(sr, c, year)).filter((v) => v != null)
        .sort((a, b) => b - a).findIndex((v) => v === mine) + 1;
      if (rank === 0) rank = null;
    }

    const groupAvg = (codesList) => {
      if (!codesList) return null;
      const vs = codesList.map((c) => valAt(sr, c, year)).filter((v) => v != null);
      return { avg: mean(vs), n: vs.length };
    };

    rows.push({
      code,
      name: sr.name || (it && it.name) || code,
      unit: sr.unit || (it && it.unit) || '',
      area: it ? it.area : null,
      areaName: it ? it.area_name : null,
      year,
      mine,
      avg: st ? st.avg : null,
      q1: st ? st.q1 : null,
      q3: st ? st.q3 : null,
      min: st ? st.min : null,
      max: st ? st.max : null,
      n: st ? st.n : 0,
      rank,
      peerType: peer ? groupAvg(peer) : null,
      nation: groupAvg(nation),
    });
  }
  return rows;
}

/* ───────── 절 원고용 마커 텍스트 ───────── */

/* 상위 백분위 위치. 값이 큰 쪽이 1위이므로 rank가 작을수록 상위 */
const pctOf = (row) => (row.rank == null || !row.n) ? null : (row.rank - 0.5) / row.n * 100;

const valLine = (r) => `${r.name} ${fmtRef(r.mine)}${r.unit ? ' ' + r.unit : ''}(${r.year}년)`;

/* 받침에 따라 은/는을 고른다. 한글 음절이 아니면 '는'으로 둔다 */
function eun(word) {
  const s = String(word || '');
  const last = s.codePointAt(s.length - 1);
  if (last >= 0xAC00 && last <= 0xD7A3) return ((last - 0xAC00) % 28) ? '은' : '는';
  return '는';
}

/* narrate(rows, opts) — 개조식 보고서 반말체 마커 텍스트.
   opts = { region, basis, regionName, regions, catalog, topN } */
export function narrate(rows, opts) {
  const o = opts || {};
  if (!Array.isArray(rows) || !rows.length) throw new Error('원고를 만들 지표 결과가 없다');

  const regions = o.regions || (_cache.index ? _cache.index.regions : null);
  const catalog = o.catalog || (_cache.index ? _cache.index.catalog : null);
  const reg = (regions && o.region) ? regionOf(regions, o.region) : null;
  const rName = o.regionName || (reg ? `${reg.sido} ${reg.sigungu}` : (o.region || '해당 시·군·구'));
  const basis = o.basis || '전국';
  const topN = o.topN || 3;

  const scored = rows.filter((r) => r.mine != null && r.rank != null && r.n >= 5);
  const byPct = scored.slice().sort((a, b) => pctOf(a) - pctOf(b));
  /* 지표 수가 적으면 위·아래 목록이 겹쳐 같은 지표를 '큰 쪽'과 '작은 쪽'에 함께 올리게 된다.
     겹치지 않게 반씩 갈라 준다 */
  let nHigh = topN, nLow = topN;
  if (byPct.length < topN * 2) { nHigh = Math.ceil(byPct.length / 2); nLow = byPct.length - nHigh; }
  const high = byPct.slice(0, nHigh);
  const low = nLow ? byPct.slice(byPct.length - nLow).reverse() : [];

  const ns = rows.map((r) => r.n).filter((n) => n > 0);
  const nMin = ns.length ? Math.min(...ns) : 0;
  const nMax = ns.length ? Math.max(...ns) : 0;
  const years = rows.map((r) => r.year).filter((y) => y != null);
  const yMin = years.length ? Math.min(...years) : null;
  const yMax = years.length ? Math.max(...years) : null;
  const noVal = rows.filter((r) => r.mine == null);

  const L = [];
  L.push('#### 지표로 본 지역 여건');
  L.push('');
  L.push(`○ 비교 기준 — ${rName}, ${basisLabel(basis)} 비교, 대상 지표 ${rows.length}개`);
  L.push(`- 비교집단 규모는 지표별로 ${nMin === nMax ? `${nMax}개` : `${nMin}~${nMax}개`} 시·군·구이며, ` +
    `결측 지역은 평균 계산에서 뺐다`);
  L.push(`- 각 지표는 자료가 나와 있는 최신연도 값을 썼다` +
    (yMin != null ? ` (${yMin === yMax ? `${yMax}년` : `${yMin}~${yMax}년 혼재`})` : ''));
  if (reg && reg.type7 == null) {
    L.push(`- ${rName}${eun(rName)} 시·군·구 7유형 구분에 들어가 있지 않아 유형별 비교는 넣지 않았다`);
  } else if (reg && catalog) {
    const tl = typeLabel(catalog, reg.type7);
    /* 비교 기준이 이미 '유형'이면 유형 평균을 따로 적지 않는다. 머리말도 그에 맞춘다 */
    if (tl) {
      L.push(basis === '유형'
        ? `- ${rName}의 시·군·구 유형은 ${tl}이고, 비교집단이 곧 같은 유형 시·군·구다`
        : `- ${rName}의 시·군·구 유형은 ${tl}이고, 같은 유형 평균을 함께 적었다`);
    }
  }
  if (noVal.length) {
    L.push(`- 값이 비어 있는 지표 ${noVal.length}개(${noVal.slice(0, 3).map((r) => r.name).join(', ')}` +
      `${noVal.length > 3 ? ' 등' : ''})는 해석에서 뺐다`);
  }
  L.push('');

  const bullets = (list, label, side) => {
    L.push(`○ ${label}`);
    if (!list.length) { L.push('- 순위를 매길 수 있는 지표가 모자라 판단을 미룬다'); L.push(''); return; }
    const u = (r) => (r.unit ? ' ' + r.unit : '');
    for (const r of list) {
      const place = side === 'high'
        ? `상위 ${Math.max(1, Math.round(pctOf(r)))}%`
        : `하위 ${Math.max(1, Math.round(100 - pctOf(r)))}%`;
      L.push(`- ${valLine(r)} — 비교집단 ${r.n}곳 중 ${r.rank}위(${place}), ` +
        `비교평균 ${fmtRef(r.avg)}${u(r)}`);
      /* 비교 기준과 겹치는 평균은 되풀이하지 않는다 */
      const bits = [];
      if (basis !== '유형' && r.peerType && r.peerType.n) {
        bits.push(`같은 유형 ${r.peerType.n}곳 평균 ${fmtRef(r.peerType.avg)}${u(r)}`);
      }
      if (basis !== '전국' && r.nation && r.nation.n) {
        bits.push(`전국 ${r.nation.n}곳 평균 ${fmtRef(r.nation.avg)}${u(r)}`);
      }
      if (bits.length) L.push(`· ${bits.join(' / ')}`);
    }
    L.push('');
  };

  bullets(high, `비교집단에서 값이 큰 쪽 지표${high.length ? ` ${high.length}개` : ''}`, 'high');
  bullets(low, `비교집단에서 값이 작은 쪽 지표${low.length ? ` ${low.length}개` : ''}`, 'low');

  L.push('○ 해석 시 유의점');
  L.push('- 값이 높다고 곧 여건이 좋은 것은 아니다. 지표마다 방향이 달라 개별 지표의 의미를 확인하고 읽는다');
  L.push(`- 순위는 비교집단 안에서 값이 큰 순서이며, 분모가 되는 지역 수(${nMin === nMax ? nMax : `${nMin}~${nMax}`}곳)를 함께 본다`);
  if (reg && reg.type7 == null) L.push('- 유형별 평균이 빠져 있으므로 광역·전국 평균으로만 견준다');
  L.push('');
  L.push('※ 자료：보건복지부·한국보건사회연구원, 「지역사회보장지표」. ' +
    '값은 지표별 최신연도 기준이며, 평균은 시·군·구 단순평균임.');

  return L.join('\n');
}

/* 시험·차트에서 캐시를 비울 때 쓴다 */
export function _resetCache() { _cache.index = null; _cache.series.clear(); }
