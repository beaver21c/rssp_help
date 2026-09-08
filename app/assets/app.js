/* 지역사회보장계획 작성지원 플랫폼 — 화면 제어
   빌드 과정 없는 순수 ES 모듈. 외부 라이브러리·CDN을 쓰지 않는다.
   문서·첨부파일·API 키는 브라우저 밖으로 나가지 않는다(Gemini 호출 제외). */
"use strict";

import { loadCatalog, findSection, sectionList, promptFor, blankForms, checkLimits } from './catalog.js';
import { buildForm, parseInput, lintParsed } from './hwpx-form.js';
import { extractAttachment, SUPPORTED } from './attach.js';
import { loadIndex, groupCodes, analyze, narrate, KEY_CODES } from './indicator.js';
import { renderComparisonChart } from './chart.js';
import * as gem from './gemini.js';
import { readBodyText } from './docread.js';

/* ───────── 공용 ───────── */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';

function say(node, text, kind) {
  const box = typeof node === 'string' ? $(node) : node;
  if (!box) return;
  box.className = 'status' + (kind ? ' ' + kind : '');
  box.innerHTML = kind === 'busy' ? `<span class="spin"></span>${esc(text)}` : esc(text);
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/haansofthwpx' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* 파일명으로 쓸 수 없는 글자를 걷어낸다 */
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80);

/* ───────── 상태 ───────── */
const S = {
  catalog: null, form: null, template: null,
  wSection: null, wFiles: [], wDraft: '',
  regions: null, indexCat: null, rows: null, rPng: null,
  cDoc: null, cName: '',
};

/* ───────── 부팅 ───────── */
async function boot() {
  try {
    const [cat, form, tpl] = await Promise.all([
      loadCatalog(),
      fetch('data/form.json').then((r) => { if (!r.ok) throw new Error('form.json 을 읽지 못했다'); return r.json(); }),
      fetch('data/template.hwpx').then((r) => { if (!r.ok) throw new Error('template.hwpx 를 읽지 못했다'); return r.arrayBuffer(); }),
    ]);
    S.catalog = cat; S.form = form; S.template = new Uint8Array(tpl);
    if (cat.scope) $('#scope').textContent = `${cat.source || '제6기'} · ${cat.scope}`;
    buildTree();
    fillSectionSelects();
  } catch (e) {
    $('#w-tree').innerHTML = `<div class="empty">카탈로그를 불러오지 못했다 — ${esc(e.message)}</div>`;
    return;
  }
  try {
    const idx = await loadIndex();
    S.indexCat = idx.catalog; S.regions = idx.regions;
    fillRegionSelects();
  } catch (e) {
    say('#r-status', '지표 데이터를 불러오지 못했다 — ' + e.message, 'err');
  }
  syncKey();
}

/* ───────── 탭 ───────── */
$$('.tab').forEach((b) => {
  b.onclick = () => {
    $$('.tab').forEach((x) => x.classList.toggle('on', x === b));
    $$('.panel').forEach((p) => p.classList.toggle('on', p.id === 'p-' + b.dataset.tab));
  };
});

/* ───────── 절 트리 ───────── */
function buildTree() {
  const host = $('#w-tree'); host.innerHTML = '';
  const list = sectionList(S.catalog);
  $('#w-cnt').textContent = `${list.length}개 마디`;
  for (const it of list) {
    const node = findSection(S.catalog, it.id);
    const b = el('button', 'tnode');
    b.dataset.d = String(it.depth); b.dataset.id = it.id;
    const nForms = blankForms(node).length;
    b.innerHTML = `<span class="no">${esc(node.no || '')}</span>${esc(node.title)}` +
      (nForms ? `<span class="badge">표 ${nForms}</span>` : '') +
      (node.howto ? '<span class="badge">지침</span>' : '');
    b.onclick = () => selectSection(it.id);
    host.appendChild(b);
  }
}

function selectSection(id) {
  const node = findSection(S.catalog, id);
  if (!node) return;
  S.wSection = node;
  $$('#w-tree .tnode').forEach((b) => b.classList.toggle('on', b.dataset.id === id));

  const path = [];
  for (let cur = node; cur; cur = cur.parent ? findSection(S.catalog, cur.parent) : null) {
    path.unshift(`${cur.no || ''} ${cur.title}`.trim());
  }
  $('#w-path').textContent = path.join(' › ');

  const h = $('#w-howto');
  if (node.howto) {
    const p = node.howto.purpose, m = node.howto.method;
    h.innerHTML = (p || m)
      ? (p ? `<h4>작성취지</h4>${esc(p)}` : '') + (m ? `<h4>작성방법</h4>${esc(m)}` : '')
      : esc(node.howto.raw);
  } else {
    h.textContent = '이 마디에는 안내서의 「작성 취지 및 방법」 박스가 없다. 상위 마디의 지침을 참고해 쓴다.';
  }

  const fbox = $('#w-forms'); fbox.innerHTML = '';
  const forms = blankForms(node);
  forms.forEach((f, i) => {
    fbox.appendChild(el('div', 'formcap', `표 ${i + 1} — ${f.rows}행 ${f.cols}열${f.required ? ' · 필수' : ''}`));
    const w = el('div', 'formprev');
    const t = el('table');
    const th = el('tr');
    (f.header || []).forEach((c) => th.appendChild(el('th', null, esc(c || '&nbsp;'))));
    t.appendChild(th);
    (f.grid || []).slice(1, 4).forEach((row) => {
      const tr = el('tr');
      row.forEach((c) => tr.appendChild(el('td', null, esc(c || '&nbsp;'))));
      t.appendChild(tr);
    });
    w.appendChild(t); fbox.appendChild(w);
  });
  if (!forms.length) fbox.appendChild(el('p', 'note', '이 마디에 고정된 표 양식은 없다. 서술형으로 쓴다.'));

  $('#w-make').disabled = !$('#w-draft').value.trim();
  $('#r-sec').value = id;
  $('#c-sec').value = id;
}

/* ───────── 첨부파일 ───────── */
function wireDrop(dropSel, inputSel, onFiles) {
  const drop = $(dropSel), input = $(inputSel);
  drop.onclick = () => input.click();
  input.onchange = () => { onFiles(Array.from(input.files)); input.value = ''; };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => onFiles(Array.from(e.dataTransfer.files)));
}

wireDrop('#w-drop', '#w-file', async (files) => {
  for (const f of files) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!SUPPORTED.includes(ext)) { say('#w-status', `${f.name} — 지원하지 않는 형식(${ext})`, 'err'); continue; }
    say('#w-status', `${f.name} 읽는 중…`, 'busy');
    try {
      S.wFiles.push(await extractAttachment(f));
      say('#w-status', '');
    } catch (e) { say('#w-status', `${f.name} — ${e.message}`, 'err'); }
    renderFiles();
  }
});

function renderFiles() {
  const ul = $('#w-files'); ul.innerHTML = '';
  S.wFiles.forEach((a, i) => {
    const li = el('li');
    li.innerHTML = `<span class="nm">${esc(a.name)}</span>` +
      `<span class="md ${a.mode}">${a.mode === 'inline' ? 'Gemini 전송' : '브라우저 파싱'}</span>` +
      `<span class="sz">${kb(a.bytes)}</span>`;
    const rm = el('button', 'rm', '✕');
    rm.title = '빼기';
    rm.onclick = () => { S.wFiles.splice(i, 1); renderFiles(); };
    li.appendChild(rm); ul.appendChild(li);
  });
}

/* ───────── 지시문 조립 ───────── */
function assemblePrompt() {
  if (!S.wSection) return null;
  const parts = [promptFor(S.wSection)];
  const req = $('#w-prompt').value.trim();
  const src = $('#w-src').value.trim();
  if (req) parts.push('[담당자 요청]\n' + req);
  if (src) parts.push('[참고 원문]\n' + src);
  const texts = S.wFiles.filter((a) => a.mode === 'text');
  for (const a of texts) {
    let body = a.text || '';
    if (a.tables && a.tables.length) {
      body += '\n\n[표]\n' + a.tables.map((t) => t.map((r) => '| ' + r.join(' | ') + ' |').join('\n')).join('\n\n');
    }
    parts.push(`[첨부: ${a.name}]\n${body.slice(0, 60000)}`);
  }
  return parts.join('\n\n');
}

$('#w-showprompt').onclick = () => {
  if (!S.wSection) return say('#w-status', '먼저 절을 고른다', 'err');
  $('#p-text').value = assemblePrompt();
  $('#pModal').classList.add('on');
};

/* ───────── 초안 생성 ───────── */
$('#w-gen').onclick = async () => {
  if (!S.wSection) return say('#w-status', '먼저 절을 고른다', 'err');
  if (!gem.getKey()) return say('#w-status', 'Gemini API 키를 먼저 설정한다 — 오른쪽 위 [API 키 미설정]', 'err');
  const btn = $('#w-gen'); btn.disabled = true;
  say('#w-status', 'AI가 초안을 쓰는 중…', 'busy');
  try {
    const files = S.wFiles.filter((a) => a.mode === 'inline').map((a) => a.inline);
    const { model, text } = await gem.generate({
      system: assemblePrompt(),
      prompt: '위 지침과 자료를 근거로 이 절의 본문 원고를 마커 텍스트로 써라. 다른 설명 없이 원고만 낸다.',
      files, temperature: 0.3,
    });
    $('#w-draft').value = stripFence(text);
    $('#w-make').disabled = false;
    say('#w-status', `초안 작성 완료 · 모델 ${model}`, 'ok');
    runLint();
  } catch (e) {
    say('#w-status', '호출 실패 — ' + e.message + (e.fatal ? ' (API 키를 확인할 것)' : ''), 'err');
  }
  btn.disabled = false;
};

const stripFence = (t) => String(t).replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();

/* AI 없이 양식만 채운 뼈대 */
$('#w-skel').onclick = () => {
  if (!S.wSection) return say('#w-status', '먼저 절을 고른다', 'err');
  const n = S.wSection;
  const depth = n.depth || 0;
  const head = '#'.repeat(Math.min(4, depth + 1));
  const L = [`${head} ${n.no ? n.no + ' ' : ''}${n.title}`, ''];
  const forms = blankForms(n);
  if (!forms.length) L.push('○ ○○○○', '▪ ○○○○', '');
  forms.forEach((f, i) => {
    L.push(`○ ${f.header.filter(Boolean)[0] || '작성 항목'}`);
    if (f.colWidths && f.colWidths.length === f.cols) L.push(`{cols=${f.colWidths.join(',')}}`);
    L.push('| ' + f.header.map((h) => h || ' ').join(' | ') + ' |');
    L.push('|' + Array(f.cols).fill('---').join('|') + '|');
    const bodyRows = Math.max(1, Math.min(5, f.rows - 1));
    for (let r = 0; r < bodyRows; r++) L.push('| ' + Array(f.cols).fill('○○').join(' | ') + ' |');
    L.push('※ 자료：○○○.', '');
  });
  $('#w-draft').value = L.join('\n');
  $('#w-make').disabled = false;
  say('#w-status', `빈 양식 ${forms.length}개를 넣었다. 내용을 채운 뒤 검사한다.`, 'ok');
  runLint();
};

$('#w-draft').oninput = () => { $('#w-make').disabled = !$('#w-draft').value.trim(); };

/* ───────── 검사 ───────── */
function runLint() {
  const text = $('#w-draft').value;
  if (!text.trim()) return;
  const out = [];
  try {
    const parsed = parseInput(text, S.form);
    for (const w of lintParsed(parsed, S.form)) out.push({ lv: 'warn', msg: w });
  } catch (e) {
    out.push({ lv: 'err', msg: '원고를 읽지 못했다 — ' + e.message });
  }
  if (S.wSection) {
    const forms = blankForms(S.wSection);
    const got = countTables(text);
    if (forms.length && got.length < forms.length) {
      out.push({ lv: 'err', msg: `안내서가 요구하는 표 ${forms.length}개 중 ${got.length}개만 들어 있다` });
    }
    forms.forEach((f, i) => {
      const g = got[i];
      if (!g) return;
      if (g.cols !== f.cols) out.push({ lv: 'err', msg: `표 ${i + 1}의 열 수가 ${g.cols}개다 — 안내서 양식은 ${f.cols}개` });
      const want = (f.header || []).filter(Boolean).map((s) => s.replace(/\s+/g, ''));
      const have = (g.header || []).map((s) => s.replace(/\s+/g, ''));
      const miss = want.filter((w) => !have.some((h) => h.includes(w) || w.includes(h)));
      if (miss.length) out.push({ lv: 'warn', msg: `표 ${i + 1} 머리행에 없는 항목: ${miss.join(', ')}` });
    });
    const lim = checkLimits(S.wSection, text);
    for (const v of (lim.violations || lim)) out.push({ lv: 'err', msg: typeof v === 'string' ? v : v.message });
    for (const u of (lim.unknown || [])) out.push({ lv: 'warn', msg: '확인 불가 — ' + (typeof u === 'string' ? u : u.message) });
  }
  showIssues('#w-issues', '#w-isum', '#w-issuecard', out);
  return out;
}
$('#w-lint').onclick = () => {
  const out = runLint();
  if (out && !out.length) say('#w-mstatus', '검사 통과 — 지적 사항 없음', 'ok');
  else say('#w-mstatus', `지적 ${out ? out.length : 0}건`, out && out.some((o) => o.lv === 'err') ? 'err' : '');
};

/* 마커 원고에서 표를 뽑는다(파이프 표) */
function countTables(text) {
  const rows = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (s.startsWith('|') && s.endsWith('|')) {
      const cells = s.slice(1, -1).split('|').map((c) => c.trim());
      if (/^[\s:|-]+$/.test(s.slice(1, -1))) continue;      // 구분행
      if (!cur) { cur = { header: cells, cols: cells.length, n: 1 }; rows.push(cur); }
      else { cur.n++; cur.cols = Math.max(cur.cols, cells.length); }
    } else if (s) { cur = null; }
  }
  return rows;
}

function showIssues(listSel, sumSel, cardSel, items) {
  const ul = $(listSel); ul.innerHTML = '';
  if (cardSel) $(cardSel).style.display = 'block';
  if (!items.length) {
    ul.appendChild(el('li', null, '<span class="lv ok">통과</span> 지적 사항 없음'));
    if (sumSel) $(sumSel).textContent = '0건';
    return;
  }
  for (const it of items) {
    const li = el('li');
    li.innerHTML = `<span class="lv ${it.lv}">${it.lv === 'err' ? '오류' : '경고'}</span><span>${esc(it.msg)}</span>`;
    ul.appendChild(li);
  }
  if (sumSel) $(sumSel).textContent = `오류 ${items.filter((i) => i.lv === 'err').length} · 경고 ${items.filter((i) => i.lv === 'warn').length}`;
}

/* ───────── 절 hwpx 산출 ───────── */
$('#w-make').onclick = async () => {
  const text = $('#w-draft').value;
  if (!text.trim()) return;
  say('#w-mstatus', '문서 만드는 중…', 'busy');
  try {
    const res = await buildForm(S.template, S.form, text, { images: new Map() });
    const n = S.wSection;
    download(res.bytes, `${safeName((n ? (n.id + '_' + n.title) : '절'))}.hwpx`);
    const bad = (res.issues || []).length;
    say('#w-mstatus', `산출 완료 (${kb(res.bytes.length)})` + (bad ? ` · 경고 ${bad}건` : ''), bad ? '' : 'ok');
  } catch (e) {
    say('#w-mstatus', '산출 실패 — ' + e.message, 'err');
  }
};

$('#w-prev').onclick = () => {
  $('#p-text').value = $('#w-draft').value || '(원고 없음)';
  $('#pModal').classList.add('on');
};

/* ───────── 지역여건 분석 ───────── */
function fillRegionSelects() {
  const sgg = S.regions.filter((r) => r.level === '시군구');
  const sidos = [...new Set(sgg.map((r) => r.sido))];
  const s1 = $('#r-sido'); s1.innerHTML = '';
  sidos.forEach((s) => s1.add(new Option(s, s)));
  s1.onchange = () => {
    const s2 = $('#r-sgg'); s2.innerHTML = '';
    sgg.filter((r) => r.sido === s1.value).forEach((r) => s2.add(new Option(r.sigungu, r.code)));
    syncBasis();
  };
  $('#r-sgg').onchange = syncBasis;
  s1.onchange();

  /* 7대 유형이 없는 지역(대구 군위군)은 유형별 비교를 고를 수 없게 막는다 */
  function syncBasis() {
    const r = S.regions.find((x) => x.code === $('#r-sgg').value);
    const opt = $('#r-basis').querySelector('option[value="유형"]');
    const none = !r || r.type7 == null;
    opt.disabled = none;
    opt.textContent = none ? '유사지역(7대 유형) — 이 지역은 유형 미부여' : '유사지역(시·군·구 7대 유형)';
    if (none && $('#r-basis').value === '유형') $('#r-basis').value = '광역';
  }

  const pick = $('#r-pick'); pick.innerHTML = '';
  S.indexCat.items.forEach((i) => pick.add(new Option(`[${i.code}] ${i.name}`, i.code)));
  $('#r-set').onchange = () => { $('#r-pickbox').style.display = $('#r-set').value === 'pick' ? 'block' : 'none'; };
}

function fillSectionSelects() {
  const list = sectionList(S.catalog);
  for (const sel of ['#r-sec', '#c-sec']) {
    const s = $(sel);
    const keep = s.querySelector('option[value=""]');
    s.innerHTML = ''; if (keep) s.appendChild(keep);
    list.forEach((it) => {
      const n = findSection(S.catalog, it.id);
      s.add(new Option(`${'   '.repeat(it.depth)}${n.no || ''} ${n.title}`.trim(), it.id));
    });
  }
  const def = list.find((i) => /여건|핵심과제/.test(findSection(S.catalog, i.id).title));
  if (def) $('#r-sec').value = def.id;
}

$('#r-run').onclick = async () => {
  const btn = $('#r-run'); btn.disabled = true;
  say('#r-status', '지표 산출 중…', 'busy');
  try {
    const set = $('#r-set').value;
    const codes = set === 'key' ? KEY_CODES
      : set === 'all' ? S.indexCat.items.filter((i) => i.kind === '지표').map((i) => i.code)
        : Array.from($('#r-pick').selectedOptions).map((o) => o.value);
    if (!codes.length) throw new Error('지표를 하나 이상 고른다');
    const opts = { region: $('#r-sgg').value, basis: $('#r-basis').value, codes, year: null };
    const rows = await analyze(opts);
    S.rows = rows; S.rOpts = opts;
    renderTable(rows);
    say('#r-status', `${rows.length}/${codes.length}개 지표 산출`, 'ok');

    say('#r-status', '그래프 그리는 중…', 'busy');
    S.rPng = await renderComparisonChart(rows, { title: regionLabel(opts), basis: opts.basis, scale: 2 });
    const box = $('#r-chart'); box.innerHTML = '';
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([S.rPng], { type: 'image/png' }));
    box.appendChild(img);
    $('#r-ccnt').textContent = kb(S.rPng.length);

    $('#r-draft').value = narrate(rows, { ...opts, regionName: regionLabel(opts), regions: S.regions });
    $('#r-make').disabled = false; $('#r-png').disabled = false;
    say('#r-status', `완료 · 지표 ${rows.length}개 · 비교집단 ${rows[0] ? rows[0].n : 0}개 지역`, 'ok');
  } catch (e) {
    say('#r-status', '실패 — ' + e.message, 'err');
  }
  btn.disabled = false;
};

/* 그림을 넣을 자리를 고른다.
   표 주(※)는 표 바로 아래에만 두는 줄이라, 그림 바로 뒤에 ※가 오면 검사에 걸린다.
   그래서 첫 표 앞(표가 없으면 첫 ※ 앞)에 넣고, 그마저 없으면 맨 끝에 붙인다. */
function insertImage(text, name) {
  const lines = text.split('\n');
  let at = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith('|') || s.startsWith('{cols=') || s.startsWith('※')) {
      at = i;
      while (at > 0 && !lines[at - 1].trim()) at--;      // 앞의 빈 줄 위로
      break;
    }
  }
  lines.splice(at, 0, '', `![](${name})`, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function regionLabel(opts) {
  const r = S.regions.find((x) => x.code === opts.region);
  return r ? `${r.sido} ${r.sigungu}` : opts.region;
}

function renderTable(rows) {
  const host = $('#r-table'); host.innerHTML = '';
  const t = el('table', 'dt');
  t.innerHTML = '<thead><tr><th>지표</th><th class="n">연도</th><th class="n">우리 지역</th>' +
    '<th class="n">비교평균</th><th class="n">Q1</th><th class="n">Q3</th><th class="n">순위</th></tr></thead>';
  const tb = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    tr.innerHTML = `<td>${esc(r.name)} <span style="color:var(--ink-3)">(${esc(r.unit || '-')})</span></td>` +
      `<td class="n">${r.year}</td><td class="n mine">${num(r.mine)}</td><td class="n">${num(r.avg)}</td>` +
      `<td class="n">${num(r.q1)}</td><td class="n">${num(r.q3)}</td><td class="n">${r.rank}/${r.n}</td>`;
    tb.appendChild(tr);
  }
  t.appendChild(tb); host.appendChild(t);
  $('#r-tcnt').textContent = `${rows.length}행`;
}
const num = (v) => v == null || isNaN(v) ? '–'
  : Math.abs(v) >= 1000 ? v.toLocaleString('ko-KR', { maximumFractionDigits: 0 })
    : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);

$('#r-png').onclick = () => {
  if (!S.rPng) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([S.rPng], { type: 'image/png' }));
  a.download = `지역여건_${safeName(regionLabel(S.rOpts))}.png`;
  document.body.appendChild(a); a.click(); a.remove();
};

$('#r-make').onclick = async () => {
  if (!S.rows) return;
  say('#r-mstatus', '문서 만드는 중…', 'busy');
  try {
    const IMG = 'indicator.png';
    let text = $('#r-draft').value;
    if (!text.includes(`![](${IMG})`)) text = insertImage(text, IMG);
    const images = new Map([[IMG, S.rPng]]);
    const res = await buildForm(S.template, S.form, text, { images });
    const sec = findSection(S.catalog, $('#r-sec').value);
    download(res.bytes, `${safeName((sec ? sec.id + '_' : '') + '지역여건_' + regionLabel(S.rOpts))}.hwpx`);
    say('#r-mstatus', `산출 완료 (${kb(res.bytes.length)}) · 그래프 포함`, 'ok');
  } catch (e) {
    say('#r-mstatus', '산출 실패 — ' + e.message, 'err');
  }
};

$('#r-polish').onclick = async () => {
  if (!gem.getKey()) return say('#r-pstatus', 'API 키 필요', 'err');
  if (!$('#r-draft').value.trim()) return;
  say('#r-pstatus', '다듬는 중…', 'busy');
  try {
    const { text } = await gem.generate({
      system: '너는 한국 지방자치단체 지역사회보장계획의 문장 교정자다. 개조식·보고서 반말체를 지킨다. ' +
        '마커 기호(#, ##, ###, ####, ○, ▪, -, ·, ※)와 표(파이프 표기), 숫자, 표 주는 절대 바꾸지 않는다. ' +
        '문장만 다듬고 원고 외의 말은 하지 않는다.',
      prompt: $('#r-draft').value, temperature: 0.2,
    });
    $('#r-draft').value = stripFence(text);
    say('#r-pstatus', '완료', 'ok');
  } catch (e) { say('#r-pstatus', '실패 — ' + e.message, 'err'); }
};

/* ───────── 양식 점검 ───────── */
wireDrop('#c-drop', '#c-file', async (files) => {
  const f = files[0]; if (!f) return;
  if (!/\.hwpx$/i.test(f.name)) return say('#c-status', 'hwpx 파일만 올릴 수 있다. .hwp는 한글에서 hwpx로 저장할 것', 'err');
  S.cDoc = new Uint8Array(await f.arrayBuffer()); S.cName = f.name;
  $('#c-drop').textContent = `${f.name} (${kb(S.cDoc.length)})`;
  $('#c-run').disabled = false;
  say('#c-status', '올렸다. [점검 실행]을 누른다.', 'ok');
});

$('#c-run').onclick = async () => {
  if (!S.cDoc) return;
  say('#c-status', '되돌리는 중…', 'busy');
  try {
    const rb = await readBodyText(S.cDoc, S.form);
    $('#c-draft').value = rb.text;
    const out = [];
    if (rb.mode === 'guess') {
      out.push({ lv: 'warn', msg: '이 문서는 안내서 서식으로 만든 것이 아니라 스타일 번호가 맞지 않는다 — 글자 모양으로 레벨을 추정했으니 마커를 확인할 것' });
    }
    if (rb.skipped.length) {
      out.push({ lv: 'warn', msg: `본문 구역 ${rb.section}만 검사했다. 건너뛴 구역: ${rb.skipped.join(', ')}(표지·제출문 등)` });
    }
    try {
      const parsed = parseInput(rb.text, S.form);
      for (const w of lintParsed(parsed, S.form)) out.push({ lv: 'warn', msg: w });
    } catch (e) { out.push({ lv: 'err', msg: '원고 해석 실패 — ' + e.message }); }

    const secId = $('#c-sec').value;
    if (secId) {
      const node = findSection(S.catalog, secId);
      const want = blankForms(node), got = countTables(rb.text);
      if (want.length && got.length < want.length) {
        out.push({ lv: 'err', msg: `안내서가 요구하는 표 ${want.length}개 중 ${got.length}개만 있다` });
      }
      want.forEach((f, i) => {
        if (got[i] && got[i].cols !== f.cols) {
          out.push({ lv: 'err', msg: `표 ${i + 1}의 열 수 ${got[i].cols}개 — 안내서 양식은 ${f.cols}개` });
        }
      });
      const lim = checkLimits(node, rb.text);
      for (const v of (lim.violations || lim)) out.push({ lv: 'err', msg: typeof v === 'string' ? v : v.message });
    }
    showIssues('#c-issues', '#c-isum', null, out);
    $('#c-make').disabled = false; $('#c-fix').disabled = !gem.getKey();
    say('#c-status', `되돌리기 완료 · 문단 ${rb.total}개(양식 대조 ${rb.matched}개) · 지적 ${out.length}건`,
      out.some((o) => o.lv === 'err') ? 'err' : 'ok');
  } catch (e) {
    say('#c-status', '실패 — ' + e.message, 'err');
  }
};

$('#c-fix').onclick = async () => {
  if (!gem.getKey()) return say('#c-mstatus', 'API 키 필요', 'err');
  say('#c-mstatus', '교정 중…', 'busy');
  try {
    const { text } = await gem.generate({
      system: '너는 지역사회보장계획 원고의 교정자다. 개조식·보고서 반말체로 고친다. ' +
        '마커 기호와 표(파이프 표기)·숫자·고유명사는 바꾸지 않는다. 계층이 건너뛴 곳은 바로잡는다. ' +
        '원고만 낸다.',
      prompt: $('#c-draft').value, temperature: 0.2,
    });
    $('#c-draft').value = stripFence(text);
    say('#c-mstatus', '교정 완료 — 내용을 확인한 뒤 다시 만든다', 'ok');
  } catch (e) { say('#c-mstatus', '실패 — ' + e.message, 'err'); }
};

$('#c-make').onclick = async () => {
  say('#c-mstatus', '양식 적용 중…', 'busy');
  try {
    const res = await buildForm(S.template, S.form, $('#c-draft').value, { images: new Map() });
    download(res.bytes, safeName(S.cName.replace(/\.hwpx$/i, '') + '_양식적용') + '.hwpx');
    say('#c-mstatus', `산출 완료 (${kb(res.bytes.length)})`, 'ok');
  } catch (e) { say('#c-mstatus', '산출 실패 — ' + e.message, 'err'); }
};

/* ───────── API 키 ───────── */
function syncKey() {
  const has = !!gem.getKey(), scope = gem.keyScope();
  const chip = $('#keyBtn');
  chip.classList.toggle('set', has);
  $('#keyLbl').textContent = has
    ? (scope === 'local' ? 'API 키 저장됨' : 'API 키 설정됨(이 탭)')
    : 'API 키 미설정';
  $('#w-gen').disabled = !has;
  $('#c-fix').disabled = !has || !S.cDoc;
}

$('#keyBtn').onclick = () => {
  $('#k-in').value = gem.getKey();
  const local = gem.keyScope() === 'local';
  $$('input[name=k-store]').forEach((r) => { r.checked = (r.value === 'local') === local; });
  $('#k-test').textContent = ''; $('#k-test').className = 'status';
  $('#keyModal').classList.add('on');
};
const storeMode = () => ($$('input[name=k-store]').find((r) => r.checked) || {}).value === 'local';
$('#k-save').onclick = () => { gem.setKey($('#k-in').value.trim(), storeMode()); syncKey(); $('#keyModal').classList.remove('on'); };
$('#k-del').onclick = () => { gem.setKey('', false); $('#k-in').value = ''; syncKey(); $('#keyModal').classList.remove('on'); };
$('#k-close').onclick = () => $('#keyModal').classList.remove('on');
$('#k-check').onclick = async () => {
  const typed = $('#k-in').value.trim();
  if (typed && typed !== gem.getKey()) { gem.setKey(typed, storeMode()); syncKey(); }
  say('#k-test', '확인 중…', 'busy');
  try {
    const models = await gem.listModels(gem.getKey());
    say('#k-test', `정상 · 사용 가능한 모델 ${models.length}개 · 우선 ${models[0]}`, 'ok');
  } catch (e) { say('#k-test', '확인 실패 — ' + e.message, 'err'); }
};

/* ───────── 모달 닫기 ───────── */
$('#p-close').onclick = () => $('#pModal').classList.remove('on');
$('#helpBtn').onclick = () => $('#hModal').classList.add('on');
$('#h-close').onclick = () => $('#hModal').classList.remove('on');
$$('.modal').forEach((m) => { m.onclick = (e) => { if (e.target === m) m.classList.remove('on'); }; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal').forEach((m) => m.classList.remove('on'));
});

boot();
