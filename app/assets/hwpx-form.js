/**
 * 양식 보존 빌더 — `build_form.py`(파이썬)의 브라우저 이식.
 *
 * 양식(`template.hwpx`)을 고치지 않는다. `Contents/header.xml`은 한 바이트도
 * 건드리지 않고, 본문 구역의 **앞부분(용지·머리말·장 표지)을 그대로 둔 채**
 * 그 뒤 문단만 새로 만들어 갈아 끼운다. 서식은 재현이 아니라 보존이다.
 *
 * 파이썬 쪽이 단일 원본이고 이 파일은 같은 XML을 내야 한다.
 * `tests/test_form_parity.mjs`가 두 산출물의 `Contents/section2.xml`을 맞대어 본다.
 *
 * 파이썬에 없는 것은 그림뿐이다. 그림 XML은 `hwpx_studio/engine.py`의
 * `_replace_image_placeholders`를 글자 그대로 옮겼다(id·instid만 난수).
 */

import { unzip, zip } from './zip.js';
import { scan } from './xml.js';
import { preambleCut } from './formkit.js';

export const ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ', 'Ⅺ', 'Ⅻ'];
const ROMAN_CHARS = ROMAN.join('');
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮';
const HANGUL_ORDER = '가나다라마바사아자차카타파하';

//: 문장 끝으로 보는 문장부호(각주 번호 자리 검사)
const SENTENCE_END = '.。!?';

//: 개조식 줄머리 기호. 한글이 자동으로 붙이는 자리에 또 쓰면 이중이 된다
const BULLET_CHARS = '□○-·･•▪◦∙※';

const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;
const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:\s*(.*)$/;
const CAPTION_RE = /^\[표\s*[:：]\s*(.+?)\]\s*$/;
const CHAPTER_RE = /^\[장\s*[:：]\s*(.+?)\]\s*$/;
const COLS_RE = /^\{cols\s*=\s*([\d.,\s]+)\}\s*$/;
const SEP_ROW_RE = /^\|[\s:|\-]+\|$/;
//: 그림 자리. 파이썬 빌더에는 없고 이 이식본에서만 쓴다
const IMAGE_RE = /^!\[[^\]]*\]\(([^)]+)\)\s*$/;

const HEADER_PATH = 'Contents/header.xml';
const HPF_PATH = 'Contents/content.hpf';

const MM = 283.47;          // 1mm ≈ 283.47 HWPUNIT
const IMAGE_WIDTH_MM = 120; // 그림 기본 폭(engine.py 프로파일 기본값)
const HC_NS = 'http://www.hancom.co.kr/hwpml/2011/core';

/** 파이썬 `round`는 짝수 반올림이다. 크기 계산이 1 어긋나지 않게 맞춘다. */
function pyRound(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const mmToUnit = (value) => pyRound(value * MM);

/**
 * 파이썬 `str.splitlines()`와 같게 자른다. 끝의 줄바꿈 하나는 빈 줄이 아니다.
 * 파이썬은 `\n \r \r\n` 말고도 `\v \f \x1c \x1d \x1e \x85 \u2028 \u2029`에서
 * 줄을 나눈다. JS `split(/\n/)`만 쓰면 PDF에서 붙여넣은 원고가 파이썬과
 * 다르게 잘리고, 그 글자가 그대로 XML로 새어 나간다.
 */
const LINE_BREAK = /\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/g;

function splitLines(text) {
  if (!text) return [];
  const src = String(text);
  const out = [];
  let start = 0;
  let m;
  LINE_BREAK.lastIndex = 0;
  while ((m = LINE_BREAK.exec(src)) !== null) {
    out.push(src.slice(start, m.index));
    start = m.index + m[0].length;
  }
  if (start < src.length) out.push(src.slice(start));
  return out;
}

const rstrip = (text) => text.replace(/\s+$/, '');

/** 파이썬 `s[:1] in "…"`은 s가 비면 참이다. 그 판정을 그대로 옮긴다. */
const leadIn = (text, chars) => {
  const lead = text.slice(0, 1);
  return lead === '' || chars.includes(lead);
};

// ──────────────────────────────────────────────────────────────
// 양식 카드
// ──────────────────────────────────────────────────────────────
/** `form.json`을 읽어 쓰기 좋게 감싼 것. 원본 객체는 건드리지 않는다. */
export class Form {
  constructor(data) {
    if (data instanceof Form) return data;
    if (!data || typeof data !== 'object') throw new Error('양식 카드(form.json)가 없다');
    // 레벨은 --bullets 때문에 고쳐 쓴다. 부른 쪽 객체가 바뀌면 안 되니 베껴 둔다
    this.data = { ...data, levels: (data.levels || []).map((lv) => ({ ...lv })) };
    this.levels = this.data.levels;
    this.byKey = new Map(this.levels.map((lv) => [lv.key, lv]));
    // 긴 마커부터 맞춰 본다('##'가 '#'보다 먼저)
    this.markers = this.levels.filter((lv) => lv.marker)
      .map((lv) => [lv.marker, lv])
      .sort((a, b) => b[0].length - a[0].length);
  }

  get name() { return this.data.name || '양식'; }

  get section() { return this.data.section || 'Contents/section0.xml'; }

  get bodyStyles() { return this.levels.map((lv) => Number.parseInt(lv.style, 10)); }

  /**
   * 마커 없는 줄이 갈 **제 자리**. 없으면 null.
   * 양식이 이런 레벨을 두었다면 마커 없는 줄은 서술식 본문이라는 뜻이다.
   * 앞 문단에 이어 붙이면 안 된다.
   */
  plainLevel() {
    return this.levels.find((lv) => !lv.marker) || null;
  }

  /** 마커가 없는 줄에 쓸 레벨. 마커 없는 레벨 → 없으면 가장 얕은 레벨. */
  fallback() {
    return this.plainLevel() || (this.levels.length ? this.levels[this.levels.length - 1] : null);
  }

  get tableNote() { return this.data.table_note || null; }

  /** 양식에 들어 있던 장 로마자(표지·표 번호에 쓰인 값). */
  get chapterRoman() {
    const chapter = this.data.chapter || {};
    const caption = (this.data.table || {}).caption || {};
    return chapter.roman || caption.chapter_roman || null;
  }

  refs(block) {
    const node = this.data[block] || {};
    return [toInt(node.style), toInt(node.para), toInt(node.char)];
  }

  /**
   * 줄머리 기호를 누가 붙일지 이 자리에서 바꾼다(form.json은 그대로 둔다).
   * 고른 값이 양식과 어긋나면 말한다.
   */
  applyBulletSource(source) {
    if (!['auto', 'hangul', 'text'].includes(source)) {
      throw new Error(`글머리표 담당은 auto·hangul·text 중 하나여야 한다: ${source}`);
    }
    const warnings = [];
    if (source === 'auto') return warnings;
    for (const level of this.levels) {
      const marker = level.marker || '';
      if (!marker || marker.startsWith('#')) continue;
      if (source === 'hangul') {
        level.write_marker = false;
        if (!level.auto_bullet) {
          warnings.push(`'${level.name || ''}' 레벨을 한글에 맡겼지만 이 양식에는 `
            + `자동 글머리표가 없다 → '${marker}' 기호가 아무 데서도 찍히지 않는다`);
        }
      } else {
        level.write_marker = true;
        if (level.auto_bullet) {
          warnings.push(`'${level.name || ''}' 레벨은 한글이 `
            + `'${level.auto_bullet}'를 자동으로 붙이는데 도구까지 적도록 `
            + '골랐다 → 기호가 두 번 찍힌다');
        }
      }
    }
    return warnings;
  }

  /** 이 양식이 알아듣는 마커 표(화면 안내용). */
  markerTable() {
    const rows = ['| 마커 | 레벨 | 스타일 | 기호·번호 |', '|---|---|---|---|'];
    for (const lv of this.levels) {
      let who;
      if (lv.auto_bullet) who = `한글이 자동으로 ${lv.auto_bullet}`;
      else if (lv.auto_number) who = '한글이 자동으로 번호';
      else if (lv.numbering) who = `도구가 번호(${lv.numbering})`;
      else if (lv.write_marker) who = `도구가 ${lv.marker}`;
      else who = '없음';
      rows.push(`| \`${lv.marker || '(없음)'}\` | ${lv.key} | ${lv.name || ''} | ${who} |`);
    }
    return rows.join('\n');
  }
}

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

// ──────────────────────────────────────────────────────────────
// 입력 파서
// ──────────────────────────────────────────────────────────────
function makeItem(kind, extra = {}) {
  return {
    kind, level: null, text: '', notes: [], rows: [], caption: '',
    colPct: null, name: '', line: 0, ...extra,
  };
}

/**
 * 마커 텍스트 → 블록 목록.
 * @returns {{items: Object[], warnings: string[], chapter: string|null}}
 */
export function parseInput(text, formLike) {
  const form = new Form(formLike);
  const out = { items: [], warnings: [], chapter: null };
  const warn = (msg) => out.warnings.push(msg);
  const lines = splitLines(text);
  const notes = new Map();
  let pendCap = '';
  let pendCols = null;
  let i = 0;

  const last = () => (out.items.length ? out.items[out.items.length - 1] : null);

  while (i < lines.length) {
    const raw = rstrip(lines[i]);
    const ln = i + 1;
    i += 1;

    if (!raw.trim()) {
      if (out.items.length && last().kind !== 'blank') {
        out.items.push(makeItem('blank', { line: ln }));
      }
      continue;
    }

    const stripped = raw.trim();

    let m = FOOTNOTE_DEF_RE.exec(stripped);
    if (m) {
      const label = m[1];
      const body = m[2].trim();
      if (notes.has(label)) warn(`${ln}행: 각주 [^${label}]의 내용 줄이 두 번 → 뒤엣것을 쓴다`);
      if (!body) warn(`${ln}행: 각주 [^${label}]의 내용이 비었다`);
      notes.set(label, { text: body, used: 0 });
      if (out.items.length && last().kind === 'blank') out.items.pop();
      continue;
    }

    m = CHAPTER_RE.exec(stripped);
    if (m) {
      if (out.chapter !== null) warn(`${ln}행: [장: …]이 두 번 나왔다 → 뒤엣것을 쓴다`);
      out.chapter = m[1].trim();
      continue;
    }

    m = CAPTION_RE.exec(stripped);
    if (m) { pendCap = m[1].trim(); continue; }

    m = COLS_RE.exec(stripped);
    if (m) {
      const parts = m[1].split(',');
      const values = [];
      let bad = false;
      for (const part of parts) {
        const value = Number(part);
        if (!part.trim() || !Number.isFinite(value)) { bad = true; break; }
        values.push(value);
      }
      const total = values.reduce((a, b) => a + b, 0);
      if (bad) {
        warn(`${ln}행: {cols=…}의 숫자를 읽지 못했다 → 균등 분배`);
        pendCols = null;
      } else if (!(total > 0)) {
        // 합이 0이면 비율을 나눌 수 없다. 그냥 두면 셀 너비가 NaN이 되어
        // 한글이 열지 못하는 문서가 조용히 나간다
        warn(`${ln}행: {cols=…}의 합이 0이라 비율을 낼 수 없다 → 균등 분배`);
        pendCols = null;
      } else {
        pendCols = values;
      }
      continue;
    }

    m = IMAGE_RE.exec(stripped);
    if (m) {
      out.items.push(makeItem('image', { name: m[1].trim(), line: ln }));
      continue;
    }

    if (raw.replace(/^\s+/, '').startsWith('|')) {
      const rows = [];
      let j = i - 1;
      while (j < lines.length && lines[j].replace(/^\s+/, '').startsWith('|')) {
        const row = lines[j].trim();
        if (!SEP_ROW_RE.test(row)) {
          rows.push(row.replace(/^\|+/, '').replace(/\|+$/, '')
            .split('|').map((c) => c.trim()));
        }
        j += 1;
      }
      i = j;
      if (rows.length) {
        const width = rows[0].length;
        rows.forEach((row, k) => {
          if (row.length !== width) {
            warn(`${ln}행 표: ${k + 1}번째 행의 칸이 ${row.length}개 `
              + `(머리행은 ${width}개) → 빈 칸을 채우거나 잘라 맞췄다`);
            rows[k] = [...row, ...Array(width).fill('')].slice(0, width);
          }
        });
        if (pendCols && pendCols.length !== width) {
          warn(`${ln}행 표: {cols}가 ${pendCols.length}개인데 칸은 ${width}개 `
            + '→ 무시하고 균등 분배');
          pendCols = null;
        }
        if (rows.some((row) => row.some((c) => hasNoteRef(c)))) {
          warn(`${ln}행: 표 안에는 각주를 달 수 없다 → 표 아래 문단에 달 것`);
        }
        if (pendCap && !((form.data.table || {}).caption)) {
          warn(`${ln}행: 이 양식에는 표 제목(캡션) 자리가 없어 `
            + `'${pendCap}'을 넣지 못한다 → 표 위 문단으로 쓸 것`);
        }
        out.items.push(makeItem('table', {
          rows, caption: pendCap, colPct: pendCols, line: ln,
        }));
      }
      pendCap = '';
      pendCols = null;
      continue;
    }

    if (pendCap) {
      warn(`${ln}행: [표: ${pendCap}] 다음에 표가 없다 → 제목을 버렸다`);
      pendCap = '';
    }

    const noteLevel = form.tableNote;
    if (noteLevel && noteLevel.marker) {
      const head = `${noteLevel.marker} `;
      if (stripped.startsWith(head)) {
        out.items.push(makeItem('table_note', {
          level: noteLevel, text: stripped.slice(head.length).trim(), line: ln,
        }));
        continue;
      }
    }

    let [level, body] = matchMarker(raw, form);
    if (level === null) {
      body = stripped;
      const plain = form.plainLevel();
      if (plain !== null) {
        // 양식에 서술식 본문 자리가 있다 → 새 문단이다. 알릴 것 없다
        level = plain;
      } else {
        level = form.fallback();
        if (out.items.length && last().kind === 'para') {
          last().text += ` ${body}`;
          warn(`${ln}행: 마커가 없는 줄 → 앞 문단에 이어 붙였다`);
          continue;
        }
        warn(`${ln}행: 마커가 없는 줄 → '${(level || {}).name || '기본'}' 레벨로 넣었다`);
      }
    }
    if (level === null) {
      warn(`${ln}행: 쓸 수 있는 레벨이 없어 줄을 버렸다`);
      continue;
    }

    if (level.auto_bullet && leadIn(body, BULLET_CHARS)) {
      warn(`${ln}행: 이 양식은 한글이 기호를 자동으로 붙인다`
        + `('${raw.slice(0, 8)}…') → 마커 뒤에 기호를 또 쓰지 말 것`);
    }
    out.items.push(makeItem('para', { level, text: body, line: ln }));
  }

  resolveNotes(out, notes);
  return out;
}

function hasNoteRef(text) {
  FOOTNOTE_REF_RE.lastIndex = 0;
  return FOOTNOTE_REF_RE.test(text);
}

function matchMarker(raw, form) {
  const stripped = raw.trim();
  for (const [marker, level] of form.markers) {
    if (stripped.startsWith(`${marker} `)) {
      return [level, stripped.slice(marker.length + 1).trim()];
    }
  }
  return [null, stripped];
}

function resolveNotes(out, notes) {
  for (const item of out.items) {
    if (item.kind !== 'para') continue;
    const [text, found] = splitNotes(item.text, notes, out.warnings, item.line);
    item.text = text;
    item.notes = found;
  }
  for (const [label, note] of notes) {
    if (!note.used) {
      out.warnings.push(`각주 [^${label}]의 내용만 있고 본문에서 부르지 않았다 `
        + '→ 각주를 만들지 않았다');
    }
  }
}

function splitNotes(text, notes, warnings, line) {
  const out = [];
  const found = [];
  let pos = 0;
  FOOTNOTE_REF_RE.lastIndex = 0;
  let m;
  while ((m = FOOTNOTE_REF_RE.exec(text)) !== null) {
    out.push(text.slice(pos, m.index));
    pos = m.index + m[0].length;
    const label = m[1];
    const note = notes.get(label);
    if (note === undefined) {
      warnings.push(`${line}행: 각주 [^${label}]의 내용을 찾지 못했다 `
        + `(\`[^${label}]: 내용\` 줄이 없다) → 본문에 그대로 남긴다`);
      out.push(m[0]);
      continue;
    }
    note.used += 1;
    if (note.used > 1) {
      warnings.push(`${line}행: 각주 [^${label}]을 두 번 이상 불렀다 `
        + '→ 한글에는 각주 재사용이 없어 따로 만들어진다');
    }
    const before = out.join('');
    found.push({
      label, text: note.text, offset: before.length,
      before: before.slice(-1), after: text.slice(pos, pos + 1),
    });
  }
  out.push(text.slice(pos));
  return [out.join(''), found];
}

// ──────────────────────────────────────────────────────────────
// 검사
// ──────────────────────────────────────────────────────────────
/** 1층 입력 검사. 경고 문자열 배열을 돌려준다. */
export function lintParsed(parsed, formLike) {
  const form = new Form(formLike);
  const issues = [...parsed.warnings];
  const depth = new Map(form.levels.map((lv, i) => [lv.key, i]));
  // 마커도 자동 번호도 없는 레벨(서술식 본문·참고문헌 따위)은 어느 제목 밑에나
  // 온다. 계층 순서를 따질 대상이 아니라 레벨 점프 검사에서 뺀다.
  const freeKeys = new Set(form.levels
    .filter((lv) => !lv.marker || !(lv.auto_bullet || lv.auto_number || lv.write_marker))
    .map((lv) => lv.key));
  let prevKey = null;
  let noteNo = 0;

  parsed.items.forEach((item, index) => {
    if (item.kind === 'table_note') {
      const before = previousKind(parsed.items, index);
      if (before !== 'table') {
        issues.push(`${item.line}행: 표 주는 표 바로 아래에 두는 줄이다 `
          + `(지금은 ${before === null ? '문서 맨 앞' : before} 뒤) `
          + '→ 자리를 옮기거나 본문 레벨로 쓸 것');
      }
      return;
    }
    if (item.kind === 'table' || item.kind === 'blank' || item.kind === 'image') return;

    const key = (item.level || {}).key || '';
    if (!item.text.trim()) issues.push(`${item.line}행: 내용이 빈 문단`);
    if (prevKey !== null && depth.has(key) && depth.has(prevKey)
      && !freeKeys.has(key) && !freeKeys.has(prevKey)) {
      if (depth.get(key) - depth.get(prevKey) > 1) {
        issues.push(`${item.line}행: ${prevKey} 다음에 ${key}가 왔다 → 중간 레벨을 건너뛰었다`);
      }
    }
    prevKey = key;

    for (const note of item.notes) {
      noteNo += 1;
      issues.push(...noteIssues(note, noteNo, item.line, item.level || {}));
    }
  });

  parsed.items.forEach((item, idx) => {
    if (item.kind !== 'table') return;
    const before = idx > 0 ? parsed.items[idx - 1].kind : 'blank';
    const after = idx + 1 < parsed.items.length ? parsed.items[idx + 1].kind : 'blank';
    if (before !== 'blank') issues.push(`${item.line}행: 표 앞에 빈 줄이 없다`);
    // 표 주는 표에 딸린 줄이라 사이에 빈 줄을 두지 않는다
    if (after !== 'blank' && after !== 'table_note') {
      issues.push(`${item.line}행: 표 뒤에 빈 줄이 없다`);
    }
  });
  return issues;
}

/** 빈 줄을 건너뛰고 바로 앞 블록의 종류. */
function previousKind(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i].kind !== 'blank') return items[i].kind;
  }
  return null;
}

function noteIssues(note, number, line, level) {
  const out = [];
  const where = `각주 ${number}`;
  const before = String(note.before || '');
  const after = String(note.after || '');
  const label = String(note.label || '');
  void after;
  if (['#', '##', '###', '####'].includes(level.marker || '') || level.auto_number) {
    out.push(`${line}행: ${where} — 제목에 각주를 달았다 → 본문 문단으로 옮길 것`);
  }
  if (!before) {
    out.push(`${line}행: ${where} — 문단 맨 앞에 번호가 왔다 → 근거가 되는 말 뒤에 붙일 것`);
  } else if (/^\s+$/.test(before)) {
    out.push(`${line}행: ${where} — 번호 앞에 빈칸이 있다 → 앞말에 붙여 쓸 것`);
  }
  if (before && SENTENCE_END.includes(before)) {
    out.push(`${line}행: ${where} — 마침표 뒤에 번호가 왔다 → 마침표 앞에 붙일 것`);
  }
  if (/^[0-9]+$/.test(label) && Number.parseInt(label, 10) !== number) {
    out.push(`${line}행: ${where} — [^${label}]로 적었지만 문서 순서로는 ${number}번째다 `
      + '→ 번호는 한글이 매긴다');
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// XML 만들기
// ──────────────────────────────────────────────────────────────
/**
 * XML 1.0이 받아 주지 않는 제어문자. 원고를 PDF·한글에서 붙여넣으면 딸려 온다.
 * 그대로 내보내면 `checkOutput`의 태그 세기는 통과하지만 한글은 파일을 열지
 * 못한다 — 조용히 깨진 문서가 나가는 자리라 여기서 떨어뜨린다.
 */
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

export function esc(text) {
  return String(text).replace(XML_FORBIDDEN, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const tag = (text) => (text ? `<hp:t>${esc(text)}</hp:t>` : '<hp:t/>');

export function paragraph(style, para, char, text, notes = [], firstNote = 1,
  noteRefs = [0, 0, 0]) {
  const runs = notes.length
    ? runsWithNotes(char, text, notes, firstNote, noteRefs)
    : `<hp:run charPrIDRef="${char}">${tag(text)}</hp:run>`;
  return `<hp:p id="0" paraPrIDRef="${para}" styleIDRef="${style}" `
    + `pageBreak="0" columnBreak="0" merged="0">${runs}</hp:p>`;
}

//: 각주 instid. 파이썬 쪽 시작값과 같아야 산출물이 글자까지 같다
const sequences = { note: 1500000000, table: 900000000 };

/** 빌드마다 처음으로 되돌린다. 파이썬은 프로세스 하나가 곧 한 번의 빌드다. */
export function resetSequences() {
  sequences.note = 1500000000;
  sequences.table = 900000000;
}

export function footNoteXml(number, refs, text) {
  const [style, para, char] = refs;
  sequences.note += 1;
  return '<hp:ctrl>'                                 // 각주는 ctrl로 감싼다
    + `<hp:footNote number="${number}" suffixChar="41" instid="${sequences.note}">`
    + '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" '
    + 'linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" '
    + 'hasTextRef="0" hasNumRef="0">'
    + `<hp:p id="0" paraPrIDRef="${para}" styleIDRef="${style}" `
    + 'pageBreak="0" columnBreak="0" merged="0">'
    + `<hp:run charPrIDRef="${char}"><hp:ctrl>`
    + `<hp:autoNum num="${number}" numType="FOOTNOTE">`
    + '<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" '
    + 'supscript="0"/></hp:autoNum></hp:ctrl>'
    + `${tag(text)}</hp:run></hp:p></hp:subList></hp:footNote></hp:ctrl>`;
}

/** 각주 번호가 놓일 자리에서 run을 끊는다. 자리가 지켜지는 근거다. */
function runsWithNotes(char, text, notes, firstNumber, refs) {
  const clamp = (n) => Math.min(Math.max(toInt(n.offset), 0), text.length);
  const marks = notes.map(clamp).sort((a, b) => a - b);
  const order = notes.map((_, i) => i).sort((a, b) => clamp(notes[a]) - clamp(notes[b]));
  const chunks = [{ text: text.slice(0, marks[0]), notes: [] }];
  order.forEach((idx, pos) => {
    chunks[chunks.length - 1].notes.push(
      footNoteXml(firstNumber + pos, refs, String(notes[idx].text || '')));
    const end = pos + 1 < marks.length ? marks[pos + 1] : text.length;
    const piece = text.slice(marks[pos], end);
    if (piece) chunks.push({ text: piece, notes: [] });
  });
  return chunks.map((c) => `<hp:run charPrIDRef="${char}">${tag(c.text)}`
    + `${c.notes.join('')}</hp:run>`).join('');
}

export function cellParagraphs(text, refs) {
  const [style, para, char] = refs;
  const parts = String(text).split(/<br\s*\/?>/).map((p) => p.trim());
  return parts.map((part) => paragraph(style, para, char, part)).join('');
}

export function captionXml(title, shape, width, roman = null) {
  let before = shape.before || '<표 ';
  const after = shape.after || '> ';
  const old = shape.chapter_roman;
  if (roman && old && old !== roman) {
    before = before.split(old).join(roman);        // <표 Ⅱ- → <표 Ⅲ-
  }
  const fmt = shape.auto_num_format
    || '<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/>';
  const number = shape.auto_num
    ? `<hp:ctrl><hp:autoNum num="1" numType="TABLE">${fmt}</hp:autoNum></hp:ctrl>` : '';
  return `<hp:caption side="${shape.side === undefined ? 'TOP' : shape.side}" fullSz="0" `
    + `width="${shape.width === undefined ? 8504 : shape.width}" `
    + `gap="${shape.gap === undefined ? 850 : shape.gap}" lastWidth="${width}">`
    + '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" '
    + 'linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" '
    + 'hasTextRef="0" hasNumRef="0">'
    + `<hp:p id="0" paraPrIDRef="${shape.para === undefined ? 0 : shape.para}" `
    + `styleIDRef="${shape.style === undefined ? 0 : shape.style}" `
    + 'pageBreak="0" columnBreak="0" merged="0">'
    + `<hp:run charPrIDRef="${shape.char === undefined ? 0 : shape.char}">`
    + `${tag(before)}${number}${tag(after + title)}`
    + '</hp:run></hp:p></hp:subList></hp:caption>';
}

export function tableXml(item, formLike, roman = null) {
  const form = new Form(formLike);
  const spec = form.data.table || {};
  const cellSpec = spec.cell_para || {};
  const cellRefs = [toInt(cellSpec.style), toInt(cellSpec.para), toInt(cellSpec.char)];
  const width = spec.width === undefined ? 39456 : toInt(spec.width);
  const rowH = spec.row_min_height === undefined ? 1182 : toInt(spec.row_min_height);
  const headerFill = spec.header_fill === undefined ? 1 : toInt(spec.header_fill);
  const bodyFill = spec.body_fill === undefined ? 1 : toInt(spec.body_fill);
  const margin = spec.cell_margin || { left: 494, right: 494, top: 0, bottom: 0 };
  const inMargin = spec.in_margin || { left: 141, right: 141, top: 141, bottom: 141 };

  const ncols = item.rows[0].length;
  const pctTotal = item.colPct ? item.colPct.reduce((a, b) => a + b, 0) : 0;
  let widths;
  // 합이 0·음수·NaN이면 나눌 수 없다. 균등 분배로 물러선다(NaN 너비 금지)
  if (item.colPct && pctTotal > 0) {
    widths = item.colPct.map((p) => Math.trunc(width * p / pctTotal));
  } else {
    widths = Array(ncols).fill(Math.floor(width / ncols));
  }
  // 합이 표 폭과 어긋나지 않게
  widths[widths.length - 1] = width - widths.slice(0, -1).reduce((a, b) => a + b, 0);

  sequences.table += 1;
  const tid = sequences.table;

  const rowsXml = item.rows.map((row, r) => {
    const fill = r === 0 ? headerFill : bodyFill;
    const cells = row.map((cell, c) => `<hp:tc name="" header="${r === 0 ? 1 : 0}" `
      + 'hasMargin="0" protect="0" editable="0" dirty="0" '
      + `borderFillIDRef="${fill}">`
      + '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" '
      + 'vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" '
      + 'textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">'
      + `${cellParagraphs(cell, cellRefs)}</hp:subList>`
      + `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/>`
      + '<hp:cellSpan colSpan="1" rowSpan="1"/>'
      + `<hp:cellSz width="${widths[c]}" height="${rowH}"/>`
      + `<hp:cellMargin left="${margin.left}" right="${margin.right}" `
      + `top="${margin.top}" bottom="${margin.bottom}"/></hp:tc>`);
    return `<hp:tr>${cells.join('')}</hp:tr>`;
  });

  const captionShape = spec.caption;
  const caption = (item.caption && captionShape)
    ? captionXml(item.caption, captionShape, width, roman) : '';

  const tbl = `<hp:tbl id="${tid}" zOrder="${tid % 1000}" numberingType="TABLE" `
    + 'textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" '
    + `pageBreak="CELL" repeatHeader="1" rowCnt="${item.rows.length}" colCnt="${ncols}" `
    + `cellSpacing="0" borderFillIDRef="${spec.border_fill === undefined ? 1 : spec.border_fill}" `
    + 'noAdjust="0">'
    + `<hp:sz width="${width}" widthRelTo="ABSOLUTE" `
    + `height="${rowH * item.rows.length}" heightRelTo="ABSOLUTE" protect="0"/>`
    + '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" '
    + 'holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" '
    + 'horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
    + '<hp:outMargin left="0" right="0" top="0" bottom="0"/>'
    + `${caption}`
    + `<hp:inMargin left="${inMargin.left}" right="${inMargin.right}" `
    + `top="${inMargin.top}" bottom="${inMargin.bottom}"/>`
    + `${rowsXml.join('')}</hp:tbl>`;

  const [style, para, char] = form.refs('table_wrap');
  return `<hp:p id="0" paraPrIDRef="${para}" styleIDRef="${style}" `
    + 'pageBreak="0" columnBreak="0" merged="0">'
    + `<hp:run charPrIDRef="${char}">${tbl}<hp:t/></hp:run></hp:p>`;
}

/** 도구가 직접 매기는 번호(양식이 한글 번호매기기를 안 쓸 때). */
export class Numbering {
  constructor(formLike) {
    const form = new Form(formLike);
    this.depth = new Map(form.levels.map((lv, i) => [lv.key, i]));
    this.counts = new Map();
  }

  next(key, kind) {
    const n = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, n);
    for (const other of [...this.counts.keys()]) {      // 아래 레벨은 다시 1부터
      if (other !== key && (this.depth.get(other) || 0) > (this.depth.get(key) || 0)) {
        this.counts.set(other, 0);
      }
    }
    if (kind === 'AUTO_ROMAN') return `${ROMAN[(n - 1) % ROMAN.length]}. `;
    if (kind === 'AUTO_NUM') return `${n}. `;
    if (kind === 'AUTO_PAREN') return `${n}) `;
    if (kind === 'AUTO_ALPHA') return `${String.fromCharCode(65 + ((n - 1) % 26))}. `;
    if (kind === 'AUTO_CIRCLED') return `${CIRCLED[(n - 1) % CIRCLED.length]} `;
    if (kind === 'AUTO_HANGUL') return `${HANGUL_ORDER[(n - 1) % HANGUL_ORDER.length]}. `;
    return '';
  }
}

/**
 * 블록 목록 → 본문 XML.
 * 그림은 자리표만 남기고 `replaceImagePlaceholders`가 나중에 바꿔 끼운다.
 * @returns {{xml: string, stats: Object, images: Object[], warnings: string[]}}
 */
export function buildBody(parsed, formLike, roman = null, imageBank = null) {
  const form = new Form(formLike);
  const stats = { 문단: 0, 표: 0, 각주: 0, '표 주': 0, 그림: 0 };
  const noteRefs = form.data.footnote ? form.refs('footnote') : [0, 0, 0];
  const numbering = new Numbering(form);
  const images = [];
  const warnings = [];
  const nonce = placeholderNonce();
  let noteNo = 1;
  const out = [];

  for (const item of parsed.items) {
    if (item.kind === 'blank') {
      const [style, para, char] = form.refs('blank');
      out.push(paragraph(style, para, char, ''));
      continue;
    }
    if (item.kind === 'table') {
      out.push(tableXml(item, form, roman));
      stats['표'] += 1;
      continue;
    }
    if (item.kind === 'image') {
      out.push(imageParagraph(item, form, images, imageBank, warnings, nonce));
      stats['그림'] += 1;
      continue;
    }
    if (item.kind === 'table_note') {
      const note = item.level || {};
      const text = note.write_marker
        ? `${note.marker || ''} ${item.text}`.trim() : item.text;
      out.push(paragraph(toInt(note.style), toInt(note.para), toInt(note.char), text));
      stats['표 주'] += 1;
      continue;
    }
    const level = item.level || {};
    let text = item.text;
    let shift = 0;
    let prefix = '';
    if (level.numbering) prefix = numbering.next(level.key, level.numbering);
    else if (level.write_marker) prefix = `${level.marker} `;
    if (prefix) {
      text = prefix + text;
      shift = prefix.length;
    }
    const notes = item.notes.map((n) => ({ ...n, offset: toInt(n.offset) + shift }));
    out.push(paragraph(toInt(level.style), toInt(level.para), toInt(level.char),
      text, notes, noteNo, noteRefs));
    noteNo += notes.length;
    stats['각주'] += notes.length;
    stats['문단'] += 1;
  }
  return { xml: out.join(''), stats, images, warnings };
}

// ──────────────────────────────────────────────────────────────
// 그림 (engine.py: _add_image / _detect_image_size / _replace_image_placeholders)
// ──────────────────────────────────────────────────────────────
const MEDIA_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpg', '.jpeg': 'image/jpg',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

/** PNG는 IHDR, JPEG는 SOF0/1/2에서 픽셀 크기를 읽는다. 못 읽으면 [0,0]. */
export function detectImageSize(data, ext) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (ext === '.png' && data.length > 24 && png.every((b, i) => data[i] === b)) {
      return [view.getUint32(16, false), view.getUint32(20, false)];
    }
    if (ext === '.jpg' || ext === '.jpeg') {
      let i = 2;
      while (i < data.length - 1) {
        if (data[i] !== 0xff) break;
        const marker = data[i + 1];
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          return [view.getUint16(i + 7, false), view.getUint16(i + 5, false)];
        }
        i += 2 + view.getUint16(i + 2, false);
      }
    }
  } catch { /* 못 읽으면 아래 기본값 */ }
  return [0, 0];
}

/** 확장자를 이름에서, 없으면 바이트 서명에서 알아낸다. */
function imageExt(name, data) {
  const m = /\.[A-Za-z0-9]+$/.exec(name || '');
  if (m) return m[0].toLowerCase();
  if (data.length > 3 && data[0] === 0x89 && data[1] === 0x50) return '.png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return '.jpg';
  return '.png';
}

/**
 * 자리표는 원고 글자와 겹치면 안 된다. 겹치면 사용자가 적은 글이 그림으로
 * 바뀌어 나간다. 빌드마다 난수 토막을 섞어 겹칠 길을 막는다.
 */
const placeholderNonce = () => Math.floor(Math.random() * 0xffffffff)
  .toString(36).toUpperCase();

function imageParagraph(item, form, images, imageBank, warnings, nonce) {
  const [style, para, char] = form.refs('table_wrap');
  const data = imageBank ? imageBank.get(item.name) : undefined;
  if (!data) {
    warnings.push(`${item.line}행: 그림 '${item.name}'의 바이트를 받지 못했다 `
      + '→ 자리만 글자로 남긴다');
    return paragraph(style, para, char, `[이미지 누락: ${item.name}]`);
  }
  const ext = imageExt(item.name, data);
  const [wPx, hPx] = detectImageSize(data, ext);
  const targetW = mmToUnit(IMAGE_WIDTH_MM);
  const targetH = (wPx && hPx) ? pyRound(targetW * hPx / wPx) : pyRound(targetW * 0.75);
  const idx = images.length;
  const token = `__IMAGE_PLACEHOLDER_${nonce}_${idx}__`;
  images.push({
    id: '', ext, data, width: targetW, height: targetH,
    mediaType: MEDIA_TYPES[ext] || 'image/png', token,
  });
  return `<hp:p id="0" paraPrIDRef="${para}" styleIDRef="${style}" `
    + 'pageBreak="0" columnBreak="0" merged="0">'
    + `<hp:run charPrIDRef="${char}"><hp:t>${token}</hp:t>`
    + '</hp:run></hp:p>';
}

const randomId = (low, high) => low + Math.floor(Math.random() * (high - low + 1));

/** 자리표 → `<hp:pic>`. engine.py의 XML을 글자 그대로 옮겼다. */
export function replaceImagePlaceholders(xml, images, treatAsChar = true) {
  if (!images.length) return xml;
  let out = xml;
  if (!out.includes('xmlns:hc=')) {
    out = out.replace(/(<hs:sec\b[^>]*?)(\s*>)/, `$1 xmlns:hc="${HC_NS}"$2`);
  }
  const tac = treatAsChar ? '1' : '0';
  images.forEach((img, idx) => {
    const w = img.width;
    const h = img.height;
    const pic = `<hp:pic id="${randomId(100000000, 999999999)}" zOrder="0" `
      + 'numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" '
      + 'lock="0" dropcapstyle="None" href="" groupLevel="0" '
      + `instid="${randomId(10000000, 99999999)}" reverse="0">`
      + '<hp:offset x="0" y="0"/>'
      + `<hp:orgSz width="${w}" height="${h}"/>`
      + `<hp:curSz width="${w}" height="${h}"/>`
      + '<hp:flip horizontal="0" vertical="0"/>'
      + '<hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="1"/>'
      + '<hp:renderingInfo>'
      + '<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
      + '<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
      + '<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
      + '</hp:renderingInfo>'
      + `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/>`
      + `<hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>`
      + '<hp:imgClip left="0" right="0" top="0" bottom="0"/>'
      + '<hp:inMargin left="0" right="0" top="0" bottom="0"/>'
      + `<hc:img binaryItemIDRef="${img.id}" bright="0" contrast="0" `
      + 'effect="REAL_PIC" alpha="0"/>'
      + '<hp:effects/>'
      + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" `
      + 'heightRelTo="ABSOLUTE" protect="0"/>'
      + `<hp:pos treatAsChar="${tac}" affectLSpacing="0" flowWithText="1" `
      + 'allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PARA" '
      + 'horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" '
      + 'vertOffset="0" horzOffset="0"/>'
      + '<hp:outMargin left="0" right="0" top="0" bottom="0"/>'
      + '</hp:pic>';
    const token = img.token || `__IMAGE_PLACEHOLDER_${idx}__`;
    out = out.split(`<hp:t>${token}</hp:t>`).join(pic);
  });
  return out;
}

/** `content.hpf`의 매니페스트 끝에 BinData 항목을 끼운다. */
export function addBindataToHpf(xml, images) {
  const items = images.map((img) => `<opf:item id="${img.id}" `
    + `href="BinData/${img.id}${img.ext}" media-type="${img.mediaType}" `
    + 'isEmbeded="1"/>').join('');
  return xml.replace('</opf:manifest>', `${items}</opf:manifest>`);
}

/**
 * 양식에 이미 든 그림과 겹치지 않는 이름을 준다.
 * 겹치면 한글이 다른 그림을 보여 준다 — 조용히 지나갈 일이 아니다.
 */
function nameImages(images, entries, hpf) {
  const used = new Set();
  for (const m of hpf.matchAll(/<opf:item\s+id="([^"]*)"/g)) used.add(m[1]);
  for (const name of entries.keys()) {
    if (name.startsWith('BinData/')) used.add(name.slice(8).replace(/\.[^.]*$/, ''));
  }
  let seq = 0;
  for (const img of images) {
    let id;
    do { seq += 1; id = `image${seq}`; } while (used.has(id));
    used.add(id);
    img.id = id;
  }
}

// ──────────────────────────────────────────────────────────────
// 템플릿 조작
// ──────────────────────────────────────────────────────────────
/** (보존할 앞부분, 닫는 꼬리). 본문 스타일이 처음 나오는 문단에서 자른다. */
export function splitPreamble(sectionXml, bodyStyles) {
  const cut = preambleCut(sectionXml, bodyStyles);
  if (cut === sectionXml.length && sectionXml.lastIndexOf('</hs:sec>') < 0) {
    throw new Error('템플릿 본문에서 </hs:sec>를 찾지 못했다 — 양식 파일이 맞는지 확인할 것');
  }
  return [sectionXml.slice(0, cut), '</hs:sec>'];
}

/**
 * 장 표지의 로마자와 'Ⅱ. 제목'을 바꾼다.
 * 보존 구간을 건드리는 유일한 곳이다. 그래서 **찾은 것만** 바꾸고, 못 찾으면
 * 바꾸지 않고 그 사실을 말한다. 조용히 지나가면 옛 장 번호가 남은 문서가 나온다.
 */
export function replaceChapter(preamble, roman, title) {
  const notes = [];
  let out = preamble;
  if (!roman && !title) return [out, notes];

  if (roman) {
    const head = out.indexOf('<hp:container');
    const tail = head >= 0 ? out.indexOf('</hp:container>', head) : -1;
    if (head >= 0 && tail >= 0) {
      let hits = 0;
      const segment = out.slice(head, tail).replace(
        new RegExp(`(<hp:t>)[${ROMAN_CHARS}](</hp:t>)`, 'g'),
        (...args) => { hits += 1; return `${args[1]}${roman}${args[2]}`; });
      out = out.slice(0, head) + segment + out.slice(tail);
      if (!hits) notes.push('표지 상자에서 로마자를 찾지 못해 장 번호를 바꾸지 않았다');
    } else {
      notes.push('표지 상자(hp:container)가 없어 장 번호를 바꾸지 않았다');
    }
  }

  if (title) {
    let hits = 0;
    out = out.replace(new RegExp(`(<hp:t>)[${ROMAN_CHARS}]\\.\\s*[^<]*(</hp:t>)`),
      (...args) => { hits += 1; return `${args[1]}${roman || ''}. ${esc(title)}${args[2]}`; });
    if (!hits) {
      notes.push("장 제목('Ⅱ. …' 꼴)을 찾지 못해 제목을 바꾸지 않았다 "
        + '→ 이 양식은 장 표지에 제목이 없을 수 있다');
    }
  }
  return [out, notes];
}

// ──────────────────────────────────────────────────────────────
// 산출물 검사
// ──────────────────────────────────────────────────────────────
/** 새로 쓴 본문이 양식에 없는 번호를 가리키지 않는지. */
export function checkRefs(sectionXml, headerXml) {
  const pools = {
    styleIDRef: /<hh:style id="(\d+)"/g,
    paraPrIDRef: /<hh:paraPr id="(\d+)"/g,
    charPrIDRef: /<hh:charPr id="(\d+)"/g,
    borderFillIDRef: /<hh:borderFill id="(\d+)"/g,
  };
  const errs = [];
  for (const [attrName, pattern] of Object.entries(pools)) {
    const pool = new Set([...headerXml.matchAll(pattern)].map((m) => m[1]));
    const used = new Set([...sectionXml.matchAll(new RegExp(`${attrName}="(\\d+)"`, 'g'))]
      .map((m) => m[1]));
    const missing = [...used].filter((id) => !pool.has(id)).sort();
    if (missing.length) errs.push(`[참조 오류] 양식에 없는 ${attrName}: ${missing.join(', ')}`);
  }
  return errs;
}

/** 한글이 기호를 붙이는 문단인데 텍스트도 기호로 시작하면 이중이다. */
export function checkDoubleBullets(sectionXml, formLike) {
  const form = new Form(formLike);
  const auto = new Map();
  for (const lv of form.levels) {
    if (lv.auto_bullet) auto.set(String(lv.para), lv.auto_bullet);
  }
  if (!auto.size) return [];
  const errs = [];
  for (const m of sectionXml.matchAll(
    /<hp:p [^>]*paraPrIDRef="(\d+)"[^>]*>([\s\S]*?)<\/hp:p>/g)) {
    const paraId = m[1];
    if (!auto.has(paraId)) continue;
    const text = [...m[2].matchAll(/<hp:t>([^<]*)<\/hp:t>/g)]
      .map((t) => t[1]).join('').replace(/^\s+/, '');
    // 빈 문단은 이중 기호가 아니다. 파이썬 `text[:1] in "…"`이 빈 글자에 참을
    // 내주는 탓에 멀쩡한 원고가 통째로 막히던 자리다
    if (text && leadIn(text, BULLET_CHARS)) {
      errs.push(`[이중 기호] 한글이 '${auto.get(paraId)}'를 붙이는 문단인데 `
        + `텍스트도 기호로 시작한다: ${JSON.stringify(text.slice(0, 24))} `
        + '→ 본문에서 기호를 빼거나 글머리표를 한글에 맡길 것');
    }
  }
  return errs;
}

/** XML 조각이 형태만이라도 온전한지. DOMParser 없이도 돌아야 한다. */
function xmlWellFormed(text) {
  const stack = [];
  let roots = 0;
  for (const token of scan(text)) {
    if (token.selfClose) {
      if (!stack.length) roots += 1;
      continue;
    }
    if (token.close) {
      if (!stack.length) return `닫는 태그가 남았다: </${token.raw}>`;
      const open = stack.pop();
      if (open !== token.raw) return `태그가 어긋난다: <${open}> ↔ </${token.raw}>`;
      if (!stack.length) roots += 1;
      continue;
    }
    stack.push(token.raw);
  }
  if (stack.length) return `닫지 않은 태그가 있다: <${stack[stack.length - 1]}>`;
  if (roots !== 1) return `뿌리 원소가 ${roots}개다`;
  return '';
}

/** 3층 검사. 만들어 낸 hwpx 바이트를 다시 풀어 본다. */
export async function checkOutput(bytes) {
  const errs = [];
  let entries;
  try {
    entries = await unzip(bytes);
  } catch (err) {
    return [`[열기 실패] ${err.message}`];
  }
  for (const need of ['mimetype', HEADER_PATH, HPF_PATH, 'META-INF/container.xml']) {
    if (!entries.has(need)) errs.push(`[zip 누락] ${need}`);
  }
  const decoder = new TextDecoder();
  for (const [name, data] of entries) {
    if (!name.endsWith('.xml') && !name.endsWith('.hpf')) continue;
    const bad = xmlWellFormed(decoder.decode(data));
    if (bad) errs.push(`[XML 오류] ${name}: ${bad}`);
  }
  return errs;
}

// ──────────────────────────────────────────────────────────────
// 조립
// ──────────────────────────────────────────────────────────────
/** 로마자 지정을 받아 준다. 1~12 숫자도, 'Ⅲ' 같은 글자도 된다. */
function toRoman(chapter) {
  if (chapter === null || chapter === undefined || chapter === '') return null;
  if (typeof chapter === 'number' || /^\d+$/.test(String(chapter))) {
    const n = Number.parseInt(chapter, 10);
    if (!(n >= 1 && n <= ROMAN.length)) {
      throw new Error(`장 번호는 1~${ROMAN.length} 사이여야 한다: ${chapter}`);
    }
    return ROMAN[n - 1];
  }
  const roman = String(chapter);
  if (!ROMAN.includes(roman)) throw new Error(`장 번호로 쓸 수 없는 값이다: ${chapter}`);
  return roman;
}

//: 미리보기 글은 한글이 다시 저장할 때 갱신한다. 자리만 채워 둔다
const PREVIEW_TEXT = 'build_form.py로 만든 문서 — 한글에서 저장하면 미리보기가 갱신된다';

function utf16le(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = code >>> 8;
  }
  return out;
}

/**
 * 양식 + 마커 텍스트 → hwpx 바이트.
 *
 * @param {Uint8Array} templateBytes 원본 양식 hwpx
 * @param {Object} formLike `form.json` 그대로
 * @param {string} text 마커 텍스트 원고
 * @param {Object} [opts] `{images: Map<string,Uint8Array>, chapter, bullets}`
 * @returns {Promise<{bytes: Uint8Array, issues: string[], warnings: string[]}>}
 */
//: 각주·표 일련번호가 모듈 하나에 얹혀 있다. 두 빌드가 겹치면 서로의 번호를
//: 가져가 같은 원고가 다른 문서를 낸다. 한 번에 하나씩만 돌린다
let buildQueue = Promise.resolve();

export function buildForm(templateBytes, formLike, text, opts = {}) {
  const run = buildQueue.then(
    () => buildFormOnce(templateBytes, formLike, text, opts),
    () => buildFormOnce(templateBytes, formLike, text, opts));
  buildQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function buildFormOnce(templateBytes, formLike, text, opts) {
  resetSequences();
  const form = new Form(formLike);
  const chosen = form.applyBulletSource(opts.bullets || 'auto');
  const parsed = parseInput(text, form);
  const issues = [...lintParsed(parsed, form), ...chosen];
  const warnings = [];

  let roman = form.chapterRoman;
  const forced = toRoman(opts.chapter === undefined ? null : opts.chapter);
  if (forced) roman = forced;
  if (parsed.chapter && !form.data.chapter) {
    issues.push('[장: …]을 적었지만 이 양식에는 장 표지가 없다 → 반영되지 않는다');
  }

  const entries = await unzip(templateBytes);
  if (!entries.has(form.section)) {
    throw new Error(`템플릿에 ${form.section}이 없다 — 양식 카드의 section을 확인할 것`);
  }
  const decoder = new TextDecoder();
  const sectionXml = decoder.decode(entries.get(form.section));
  const headerXml = decoder.decode(entries.get(HEADER_PATH) || new Uint8Array());

  if (!form.data.footnote && parsed.items.some((item) => item.notes.length)) {
    warnings.push('이 양식에는 각주 스타일이 없다 → 한글에서 각주 서식이 흐트러질 수 있다');
  }

  let [preamble, tail] = splitPreamble(sectionXml, form.bodyStyles);
  if (parsed.chapter || (forced && roman)) {
    const [changed, notes] = replaceChapter(preamble, roman, parsed.chapter);
    preamble = changed;
    warnings.push(...notes);
  }

  const imageBank = opts.images instanceof Map ? opts.images
    : new Map(Object.entries(opts.images || {}));
  const body = buildBody(parsed, form, roman, imageBank);
  warnings.push(...body.warnings);

  let newSection = preamble + body.xml + tail;
  let hpf = decoder.decode(entries.get(HPF_PATH) || new Uint8Array());
  if (body.images.length) {
    nameImages(body.images, entries, hpf);
    newSection = replaceImagePlaceholders(newSection, body.images);
    hpf = addBindataToHpf(hpf, body.images);
  }

  const errs = [...checkRefs(newSection, headerXml), ...checkDoubleBullets(newSection, form)];
  if (errs.length) throw new Error(`2층 구조 검사에서 걸렸다 — ${errs.join(' / ')}`);

  const encoder = new TextEncoder();
  const files = new Map(entries);
  files.set(form.section, encoder.encode(newSection));
  if (body.images.length) files.set(HPF_PATH, encoder.encode(hpf));
  files.set('Preview/PrvText.txt', utf16le(PREVIEW_TEXT));
  for (const img of body.images) files.set(`BinData/${img.id}${img.ext}`, img.data);

  // 한글은 mimetype이 무압축으로 맨 앞에 있어야 hwpx로 읽는다
  const ordered = new Map();
  if (files.has('mimetype')) ordered.set('mimetype', files.get('mimetype'));
  for (const [name, data] of files) {
    if (name !== 'mimetype') ordered.set(name, data);
  }
  const bytes = await zip(ordered, ['mimetype']);

  const broken = await checkOutput(bytes);
  if (broken.length) throw new Error(`3층 산출물 검사에서 걸렸다 — ${broken.join(' / ')}`);

  return { bytes, issues, warnings };
}
