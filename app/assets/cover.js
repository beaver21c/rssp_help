/**
 * 앞표지 구역 떼어내기.
 *
 * 안내서 원본은 구역이 셋이다.
 *   section0 — 빈 구역(표지 앞 여백)
 *   section1 — 표지·제출문·심의결과서 (문단 194개·표 8개)
 *   section2 — 본문. 우리가 원고를 채워 넣는 자리
 * 양식 보존 방식이라 산출물에는 이 셋이 늘 함께 나갔다. 계획서 앞부분(제1장)에는
 * 표지가 있어야 하지만, 뒤 장이나 지역여건 분석 절에까지 표지가 딸려 나오면
 * 담당자가 한글에서 매번 지워야 한다.
 *
 * 그래서 **앞 두 구역과 그 바탕쪽을 통째로 덜어 낸다.** `header.xml`은 손대지 않으므로
 * 글꼴·자동 번호매기기·서식은 그대로다. 남는 본문 구역은 이름을 `section0.xml`로
 * 앞당겨 번호가 0부터 이어지게 하고, 매니페스트(`content.hpf`)와 메타(`container.rdf`)를
 * 그에 맞춰 다시 쓴다.
 */
"use strict";

import { unzip, zip } from './zip.js';

/** 덜어 낼 파일과 그 짝. 남는 본문 구역은 section0으로 앞당긴다. */
const DROP = ['Contents/section0.xml', 'Contents/section1.xml',
  'Contents/masterpage0.xml', 'Contents/masterpage1.xml'];

const dec = (u8) => new TextDecoder().decode(u8);
const enc = (s) => new TextEncoder().encode(s);

/** 이 문서에서 표지 구역을 떼어낼 수 있는가(구역이 둘 이상이어야 뜻이 있다). */
export function hasFront(files) {
  return files.has('Contents/section1.xml') && files.has('Contents/section2.xml');
}

/**
 * `content.hpf`에서 덜어 낸 항목을 빼고, 남는 본문 구역의 경로를 새 이름으로 고친다.
 * item·itemref 양쪽을 함께 손봐야 한글이 구역을 찾는다.
 */
function fixHpf(xml, bodyPath, newPath, newId) {
  let out = xml;
  // 덜어 낸 파일의 item 과 itemref 제거
  for (const path of DROP) {
    const id = (out.match(new RegExp(`<opf:item[^>]*href="${path}"[^>]*id="([^"]+)"`))
      || out.match(new RegExp(`<opf:item[^>]*id="([^"]+)"[^>]*href="${path}"`)) || [])[1];
    out = out.replace(new RegExp(`<opf:item\\b[^>]*href="${path}"[^>]*/>`, 'g'), '');
    if (id) out = out.replace(new RegExp(`<opf:itemref\\b[^>]*idref="${id}"[^>]*/>`, 'g'), '');
  }
  // 남는 본문 구역 — 경로와 id를 함께 새 이름으로 맞춘다.
  // id는 내부 참조라 안 바꿔도 돌지만, 파일명과 어긋난 채 두면 나중에 읽는 사람이 헷갈린다.
  const oldId = (out.match(new RegExp(`<opf:item[^>]*href="${bodyPath}"[^>]*id="([^"]+)"`))
    || out.match(new RegExp(`<opf:item[^>]*id="([^"]+)"[^>]*href="${bodyPath}"`)) || [])[1];
  out = out.split(`href="${bodyPath}"`).join(`href="${newPath}"`);
  if (oldId && newId && oldId !== newId) {
    out = out.split(`id="${oldId}"`).join(`id="${newId}"`)
      .split(`idref="${oldId}"`).join(`idref="${newId}"`);
  }
  return out;
}

/**
 * 지워진 구역을 가리키던 커서 위치를 첫 문단으로 되돌린다.
 * 남겨 두면 한글이 없는 문단을 찾아가려 할 수 있다.
 */
function fixSettings(xml) {
  return xml.replace(/<ha:CaretPosition[^>]*\/>/,
    '<ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/>');
}

/** `container.rdf`에서 덜어 낸 구역의 선언을 빼고 본문 구역 경로를 고친다. */
function fixRdf(xml, bodyPath, newPath) {
  let out = xml;
  for (const path of DROP) {
    // <rdf:Description rdf:about="">…hasPart …resource="path"…</rdf:Description>
    out = out.replace(new RegExp(
      `<rdf:Description[^>]*rdf:about=""[^>]*>(?:(?!</rdf:Description>)[\\s\\S])*?`
      + `rdf:resource="${path}"[\\s\\S]*?</rdf:Description>`, 'g'), '');
    // <rdf:Description rdf:about="path">…</rdf:Description>
    out = out.replace(new RegExp(
      `<rdf:Description[^>]*rdf:about="${path}"[\\s\\S]*?</rdf:Description>`, 'g'), '');
  }
  return out.split(`"${bodyPath}"`).join(`"${newPath}"`);
}

/**
 * 표지·제출문 구역을 덜어 낸 hwpx 바이트를 돌려준다.
 * 뗄 것이 없으면(구역이 하나뿐이면) 받은 바이트를 그대로 돌려준다.
 *
 * bodyPath는 본문 구역 경로(`form.section`). 기본값 `Contents/section2.xml`.
 */
export async function stripFront(bytes, bodyPath) {
  const body = bodyPath || 'Contents/section2.xml';
  const files = await unzip(bytes);
  if (!hasFront(files)) return bytes;
  if (!files.has(body)) throw new Error(`본문 구역 ${body}을 찾지 못해 표지를 떼지 못했다.`);

  const kept = new Map();
  const NEW = 'Contents/section0.xml';
  const NEW_ID = 'section0';
  for (const [name, data] of files) {
    if (DROP.includes(name)) continue;
    if (name === 'Contents/content.hpf') {
      kept.set(name, enc(fixHpf(dec(data), body, NEW, NEW_ID)));
    } else if (name === 'META-INF/container.rdf') {
      kept.set(name, enc(fixRdf(dec(data), body, NEW)));
    } else if (name === 'settings.xml') {
      kept.set(name, enc(fixSettings(dec(data))));
    } else if (name === body) {
      kept.set(NEW, data);              // 본문 구역을 맨 앞 번호로 앞당긴다
    } else {
      kept.set(name, data);
    }
  }
  return zip(kept);
}

/**
 * 이 마디에 표지를 붙일 것인가. 기본 규칙은 **제1장에만**이다.
 * 계획서를 절 단위로 뽑아 한글에서 이어 붙이는 방식이라, 표지가 절마다 나오면
 * 매번 지워야 한다. 지역여건 분석처럼 장에 속하지 않는 산출물은 붙이지 않는다.
 */
export function wantsFront(sectionId) {
  const id = String(sectionId || '');
  return /^0*1(?:[-_]|$)/.test(id);
}
