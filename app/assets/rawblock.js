/* 안내서의 체계도를 원본 XML 그대로 산출물에 옮겨 붙인다.
 *
 * 전략체계도(27×29·16×15)는 칸을 잘게 나눠 병합하고 테두리를 지웠다 그렸다 하며 그린
 * 표다. 머리행이 없고 칸마다 테두리가 달라 파이프 표로는 받아쓸 수 없다. 그래서 안내서
 * 본문 구역에서 그 문단을 통째로 떼어 두었다가
 * (`tools/build_catalog.py`가 app/data/layout/*.xml로 뽑아 둔다) 산출할 때 자리표를
 * 그 문단으로 갈아 끼운다.
 *
 * 이 방식이 되는 까닭은 배포용 template.hwpx의 header.xml이 안내서 원본과 바이트가
 * 같기 때문이다. 도식이 참조하는 borderFill·charPr·paraPr·style 번호가 그대로 유효하다.
 * header.xml이 달라지면 이 방식은 곧바로 깨지므로, 시험이 해시 일치를 함께 본다.
 */
"use strict";

import { unzip, zip } from './zip.js';
import { spanOf, eachSpan } from './docread.js';

const DEC = new TextDecoder();
const ENC = new TextEncoder();

/** 원고에 넣을 자리표. 본문 한 줄로 들어갔다가 산출할 때 도식으로 바뀐다. */
export const token = (key) => `[[도식:${key}]]`;

const TOKEN_RE = /\[\[도식:([^\]]+)\]\]/;

/** 원고에서 쓰인 도식 열쇠를 차례대로 뽑는다. */
export function usedKeys(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = TOKEN_RE.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 산출된 hwpx의 자리표 문단을 도식 문단으로 갈아 끼운다.
 *
 * @param {Uint8Array} bytes    buildForm이 낸 hwpx
 * @param {string} sectionPath  본문 구역 경로(form.section)
 * @param {Map<string,string>} blocks  열쇠 → 도식 문단 XML(`<hp:p …>…</hp:p>`)
 * @returns {Promise<{bytes: Uint8Array, placed: string[], missing: string[]}>}
 */
export async function injectRawBlocks(bytes, sectionPath, blocks) {
  if (!blocks || !blocks.size) return { bytes, placed: [], missing: [] };

  const entries = await unzip(bytes);
  const xml = entries.get(sectionPath);
  if (!xml) throw new Error(`산출물에 ${sectionPath}이 없다`);
  let body = DEC.decode(xml);

  const placed = [];
  const missing = [];
  // 자리표를 담은 최상위 문단을 뒤에서부터 갈아 끼운다(앞을 바꾸면 뒤 자리가 밀린다)
  const hits = [];
  const sec = spanOf(body, 'hs:sec', 0);
  const base = sec ? body.indexOf(sec.inner, sec.start) : 0;
  for (const p of eachSpan(sec ? sec.inner : body, 'hp:p')) {
    const m = TOKEN_RE.exec(p.inner);
    if (m) hits.push({ key: m[1], start: base + p.start, end: base + p.end });
  }
  for (const hit of hits.reverse()) {
    const block = blocks.get(hit.key);
    if (!block) { missing.push(hit.key); continue; }
    body = body.slice(0, hit.start) + block + body.slice(hit.end);
    placed.unshift(hit.key);
  }
  for (const key of blocks.keys()) {
    if (!placed.includes(key) && !missing.includes(key)) missing.push(key);
  }

  // 원본 조각이 hc 네임스페이스를 쓰면(도형이 섞인 조각) 선언이 있어야 한다
  if (/<hc:/.test(body) && !/xmlns:hc=/.test(body)) {
    body = body.replace(/(<hs:sec\b[^>]*?)(\s*>)/,
      '$1 xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"$2');
  }

  entries.set(sectionPath, ENC.encode(body));
  const ordered = new Map();
  if (entries.has('mimetype')) ordered.set('mimetype', entries.get('mimetype'));
  for (const [name, data] of entries) if (name !== 'mimetype') ordered.set(name, data);
  /* 항목 틀을 그대로 물려준다 — 도식을 끼워 넣는다고 꾸러미 꼴이 달라지면 안 된다 */
  const out = await zip(ordered, { stored: ['mimetype'], frames: entries.frames });
  return { bytes: out, placed, missing };
}
