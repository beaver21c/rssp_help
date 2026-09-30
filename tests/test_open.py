#!/usr/bin/env python3
"""산출물이 정말 열리는가 — python3 tests/test_open.py

왜 이 시험이 있나
    지금까지 검사는 전부 **우리가 만든 판독기**로 했다. zip 도 우리 unzip, 참조도 우리
    규칙이었다. 읽는 규칙이 우리 것이면 우리가 만든 잘못은 드러나지 않는다.
    실제로 그 틈으로 결함이 하나 빠져나갔다 — 표지를 떼면서 `header.xml`의
    `secCnt`(구역 수 선언)를 3으로 둔 채 구역을 하나만 남겨, 한글이 없는 구역을
    찾다가 문서를 열지 못했다. 우리 검사는 전부 통과했다.

    그래서 **바깥 판독기**(python-hwpx)를 기준으로 삼는다. 한글 그 자체는 아니지만
    우리가 짜지 않은 규칙으로 읽는다는 점이 중요하다.

보는 것
    1. 한글이 쓴 원본과 배포용 템플릿이 통과하는가(기준이 성립하는지 먼저 본다)
    2. 표지를 붙인 산출물·뗀 산출물·그림이 박힌 산출물이 통과하는가
    3. 구역 수 선언이 실제 구역 수와 맞는가
    4. tests/out 에 쌓인 산출물이 모두 통과하는가(E2E 를 돌린 뒤라면)
"""
import glob
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, 'app')
OUT = os.path.join(ROOT, 'tests', 'out')
ORIG = os.path.join(ROOT, 'source', '제6기_지역사회보장계획_수립안내_시군구.hwpx')

fails = 0
checks = 0


def ok(cond, msg, extra=''):
    global fails, checks
    checks += 1
    if cond:
        print(f'  통과 — {msg}')
        return True
    fails += 1
    print(f'  실패 — {msg}')
    if extra:
        print(f'      {str(extra)[:400]}')
    return False


def head(s):
    print(f'\n── {s} ' + '─' * max(0, 56 - len(s)))


try:
    import hwpx
except ImportError:
    print('python-hwpx 가 없어 이 시험은 돌지 않는다 — pip install python-hwpx')
    print('(바깥 판독기가 없으면 우리 검사만으로는 「열리는가」를 알 수 없다)')
    sys.exit(0)


def verdict(path):
    """(통과 여부, 오류 글 목록)"""
    try:
        r = hwpx.validate_package(path)
        return r.ok, [getattr(e, 'message', None) or str(e) for e in r.errors]
    except Exception as e:                                    # noqa: BLE001
        return False, [f'{type(e).__name__}: {e}']


SEC = re.compile(r'Contents/section\d+\.xml$')
CNT = re.compile(r'secCnt="(\d+)"')


def counts(path):
    """(선언된 구역 수, 실제 구역 수)"""
    z = zipfile.ZipFile(path)
    declared = CNT.search(z.read('Contents/header.xml').decode('utf-8'))
    actual = len([n for n in z.namelist() if SEC.match(n)])
    return (int(declared.group(1)) if declared else None), actual


# ───────── 1. 기준이 성립하는가 ─────────
head('기준 — 한글이 쓴 원본이 통과하는가')
if not os.path.exists(ORIG):
    print('  안내서 원본이 없다. 기준을 세울 수 없어 멈춘다.')
    sys.exit(1)

for tag, p in (('한글이 쓴 원본', ORIG), ('배포용 템플릿', os.path.join(APP, 'data/template.hwpx'))):
    good, errs = verdict(p)
    ok(good, f'{tag}이 바깥 판독기를 통과한다', ' / '.join(errs[:3]))
    d, a = counts(p)
    ok(d == a, f'{tag}의 구역 수 선언({d})과 실제({a})가 맞는다')

# ───────── 2. 갓 만든 산출물 ─────────
head('갓 만든 산출물')
built = os.path.join(OUT, '_open_check')
os.makedirs(built, exist_ok=True)
script = r'''
import fs from 'node:fs';
import { buildForm } from '../../../app/assets/hwpx-form.js';
import { stripFront } from '../../../app/assets/cover.js';
const form = JSON.parse(fs.readFileSync('app/data/form.json', 'utf8'));
const tpl = new Uint8Array(fs.readFileSync('app/data/template.hwpx'));
const TEXT = ['# 제2장 지역여건 분석', '', '## 1. 인구 구조', '',
  '○ 총인구 1,185천 명 (2024년 기준)', '- 최근 5년 연평균 0.4% 감소', '',
  '| 구분 | 2023년 | 2024년 |', '|---|---|---|', '| 총인구(명) | 1,190,000 | 1,185,000 |',
  '※ 자료：행정안전부, 「주민등록인구현황」, 2024.'].join('\n');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR42mP8z8BQz0AEYBxVSF+F'
  + 'ABJ2AwHpDIhaAAAAAElFTkSuQmCC', 'base64');
const D = 'tests/out/_open_check/';
const plain = await buildForm(tpl, form, TEXT, { images: new Map() });
fs.writeFileSync(D + 'cover.hwpx', plain.bytes);
fs.writeFileSync(D + 'stripped.hwpx', await stripFront(plain.bytes, form.section));
const withImg = await buildForm(tpl, form, TEXT + '\n\n![](c.png)\n',
  { images: new Map([['c.png', new Uint8Array(png)]]) });
fs.writeFileSync(D + 'image.hwpx', withImg.bytes);
fs.writeFileSync(D + 'image_stripped.hwpx', await stripFront(withImg.bytes, form.section));
'''
src = os.path.join(built, '_make.mjs')
with open(src, 'w', encoding='utf-8') as f:
    f.write(script)
r = subprocess.run(['node', src], cwd=ROOT, capture_output=True, text=True)
if r.returncode != 0:
    ok(False, '시험용 산출물을 만들었다', r.stderr[-500:])
else:
    cases = [
        ('표지 붙인 절', 'cover.hwpx', 3),
        ('표지 뗀 절', 'stripped.hwpx', 1),
        ('그림 박힌 절', 'image.hwpx', 3),
        ('그림 박고 표지 뗀 절', 'image_stripped.hwpx', 1),
    ]
    for tag, name, want in cases:
        p = os.path.join(built, name)
        good, errs = verdict(p)
        ok(good, f'{tag}이 바깥 판독기를 통과한다', ' / '.join(errs[:3]))
        d, a = counts(p)
        ok(d == a == want,
           f'{tag}의 구역 수 선언({d})·실제({a})가 {want}로 맞는다')

# ───────── 3. 쌓인 산출물 전부 ─────────
head('tests/out 에 쌓인 산출물')
files = sorted(f for f in glob.glob(os.path.join(OUT, '*.hwpx')))
if not files:
    print('  쌓인 산출물이 없다(E2E 를 먼저 돌리면 여기서도 본다) — 건너뛴다')
else:
    bad = []
    for f in files:
        good, errs = verdict(f)
        if not good:
            bad.append(f'{os.path.basename(f)}: {errs[0] if errs else "?"}')
    ok(not bad, f'산출물 {len(files)}개가 모두 통과한다',
       '\n      '.join(bad[:6]) + (f'\n      … 그 밖 {len(bad) - 6}개' if len(bad) > 6 else ''))

print(f'\n검사 {checks}건 · 실패 {fails}건')
sys.exit(1 if fails else 0)
