#!/usr/bin/env python3
"""절 카탈로그 산출물 검사.

  python3 tests/test_catalog.py

검사 대상은 tools/build_catalog.py가 만든 app/data/sections.json·template.hwpx와
손으로 고친 app/data/form.json이다. 시험 틀은 안 쓴다. 어긋나면 사유를 찍고
sys.exit(1)로 끝낸다.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "source" / "제6기_지역사회보장계획_수립안내_시군구.hwpx"
SECTIONS = ROOT / "app" / "data" / "sections.json"
TEMPLATE = ROOT / "app" / "data" / "template.hwpx"
FORM = ROOT / "app" / "data" / "form.json"

HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
BODY_SECTION = "Contents/section2.xml"
HPF = "Contents/content.hpf"
#: 원본과 바이트가 같아야 하는 조각. 여기가 틀어지면 한글이 서식을 잃는다
KEEP = ["Contents/header.xml", "Contents/section0.xml",
        "Contents/section1.xml", "settings.xml"]
BAD_NAME = re.compile(r'[/\\:*?"<>|\x00-\x1f]')

#: build_catalog.STYLE_MARKER와 같아야 한다. 빌더는 이 짝으로 마디 markers를 세고
#: 조판기는 form.json의 짝으로 스타일을 고른다. 둘이 어긋나면 글이 딴 서식으로 간다
BUILDER_MARKER = {40: "#", 1: "##", 2: "###", 10: "####", 3: "◆", 4: "○",
                  5: "-", 6: "·", 56: "▶", 16: "◎", 17: "※"}

fails: list[str] = []


def bad(msg: str) -> None:
    fails.append(msg)


def need(cond: bool, msg: str) -> bool:
    if not cond:
        bad(msg)
    return cond


# ---------------------------------------------------------------------------
def check_schema(cat: dict) -> None:
    top = {"source": str, "scope": str, "generated_at": str, "template": str,
           "body_section": str, "stats": dict, "nodes": list}
    for key, typ in top.items():
        if key not in cat:
            bad(f"sections.json에 '{key}' 키가 없다")
        elif not isinstance(cat[key], typ):
            bad(f"sections.json의 '{key}'가 {typ.__name__}이 아니다")
    if fails:
        return

    for key in ("chapters", "nodes", "forms", "howtos"):
        if not isinstance(cat["stats"].get(key), int):
            bad(f"stats.{key}가 정수가 아니다")

    fields = {"id": str, "depth": int, "no": str, "title": str,
              "parent": (str, type(None)), "children": list,
              "howto": (dict, type(None)), "forms": list, "limits": list,
              "fixed": bool, "markers": list}
    ids: set[str] = set()
    for i, n in enumerate(cat["nodes"]):
        where = f"nodes[{i}]"
        for key, typ in fields.items():
            if key not in n:
                bad(f"{where}에 '{key}' 키가 없다")
            elif not isinstance(n[key], typ):
                bad(f"{where}.{key}의 자료형이 틀렸다: {type(n[key]).__name__}")
        if "page" not in n:
            bad(f"{where}에 'page' 키가 없다")
        elif n["page"] is not None and not isinstance(n["page"], int):
            bad(f"{where}.page가 정수도 null도 아니다")
        nid = n.get("id")
        if isinstance(nid, str):
            if nid in ids:
                bad(f"{where}: id '{nid}'가 겹친다")
            ids.add(nid)
        if not isinstance(n.get("depth"), int) or not 0 <= n["depth"] <= 3:
            bad(f"{where}.depth가 0~3 밖이다: {n.get('depth')}")

    if cat["stats"]["nodes"] != len(cat["nodes"]):
        bad(f"stats.nodes({cat['stats']['nodes']})가 실제 마디 수"
            f"({len(cat['nodes'])})와 다르다")


#: 스키마가 값까지 못박은 머리 항목. 여기가 틀어지면 화면이 딴 구역·딴 양식을 연다
PINNED = {
    "source": "제6기(2027~2030) 지역사회보장계획 수립 안내 [시·군·구]",
    "scope": "시군구",
    "template": "template.hwpx",
    "body_section": BODY_SECTION,
}


def check_pinned(cat: dict) -> None:
    for key, want in PINNED.items():
        if cat.get(key) != want:
            bad(f"sections.json의 '{key}'가 '{want}'가 아니다: '{cat.get(key)}'")
    if not (TEMPLATE.parent / cat.get("template", "")).exists():
        bad(f"sections.json이 가리키는 template '{cat.get('template')}' 파일이 없다")


def check_tree(cat: dict) -> None:
    by_id = {n["id"]: n for n in cat["nodes"]}
    for n in cat["nodes"]:
        parent = n["parent"]
        if parent is None:
            if n["depth"] != 0:
                bad(f"{n['id']}: 부모가 없는데 depth가 {n['depth']}다")
        else:
            if parent not in by_id:
                bad(f"{n['id']}: 부모 '{parent}'가 목록에 없다")
                continue
            p = by_id[parent]
            if n["id"] not in p["children"]:
                bad(f"{n['id']}: 부모 '{parent}'의 children에 자기가 없다")
            if p["depth"] != n["depth"] - 1:
                bad(f"{n['id']}: 부모 depth {p['depth']}, 자기 depth {n['depth']}")
        for kid in n["children"]:
            if kid not in by_id:
                bad(f"{n['id']}: children의 '{kid}'가 목록에 없다")
            elif by_id[kid]["parent"] != n["id"]:
                bad(f"{n['id']}: children의 '{kid}'가 다른 부모를 가리킨다")


def check_counts(cat: dict) -> None:
    chapters = sum(1 for n in cat["nodes"] if n["depth"] == 0)
    forms = [f for n in cat["nodes"] for f in n["forms"]]
    blanks = [f for f in forms if f["kind"] == "blank"]
    howtos = sum(1 for n in cat["nodes"] if n["howto"])
    need(chapters == 5, f"장이 5개가 아니다: {chapters}")
    need(len(cat["nodes"]) >= 30, f"마디가 30개 미만이다: {len(cat['nodes'])}")
    need(len(blanks) >= 15, f"blank 표가 15개 미만이다: {len(blanks)}")
    need(howtos >= 15, f"howto가 15개 미만이다: {howtos}")
    if cat["stats"]["forms"] != len(forms):
        bad(f"stats.forms({cat['stats']['forms']})가 실제 표 수({len(forms)})와 다르다")
    if cat["stats"]["howtos"] != howtos:
        bad(f"stats.howtos({cat['stats']['howtos']})가 실제 지시문 수({howtos})와 다르다")
    if cat["stats"]["chapters"] != chapters:
        bad(f"stats.chapters({cat['stats']['chapters']})가 실제 장 수({chapters})와 다르다")

    # 아래는 '기능이 통째로 사라져도 골격은 멀쩡하다'를 막는 하한이다
    noteless = [n["id"] for n in cat["nodes"] if n["depth"] == 0 and not n["page"]]
    if noteless:
        bad(f"장에 목차 쪽번호가 없다: {', '.join(noteless)}")
    if sum(len(n["limits"]) for n in cat["nodes"]) < 10:
        bad("수량 제약이 10건 미만이다 — 지시문에서 제약을 못 뽑고 있다")
    if sum(1 for n in cat["nodes"] if n["markers"]) < 10:
        bad("markers를 가진 마디가 10개 미만이다 — 본문 마커를 못 세고 있다")
    # 안내서는 [… 전략 1]만 펼쳐 적고 2~4는 제목만 둔다 → 반드시 mirrors가 붙는다
    repeat = re.compile(r"^\[[^\]]*?전략\s*([2-9])[_\s]")
    for n in cat["nodes"]:
        if repeat.match(n["title"]) and not n["mirrors"]:
            bad(f"{n['id']}: 되풀이 마디인데 mirrors가 없다 — 화면이 빈손이 된다")


def check_ids_as_filenames(cat: dict) -> None:
    for n in cat["nodes"]:
        nid = n["id"]
        if not nid:
            bad("id가 빈 문자열인 마디가 있다")
        elif BAD_NAME.search(nid):
            bad(f"id '{nid}'에 파일명으로 못 쓰는 글자가 있다")
        elif nid in (".", "..") or nid != nid.strip() or nid.endswith("."):
            bad(f"id '{nid}'는 파일명으로 쓸 수 없다")
        elif len(nid.encode("utf-8")) > 120:
            bad(f"id '{nid}'가 파일명으로 쓰기엔 너무 길다")


def check_forms(cat: dict) -> None:
    kinds = {"blank", "example", "note", "howto", "layout"}
    for n in cat["nodes"]:
        for i, f in enumerate(n["forms"]):
            where = f"{n['id']} 표 {f['idx']}"
            if f["idx"] != i:
                bad(f"{n['id']}: 표 idx가 자리와 다르다({f['idx']} != {i})")
            if f["kind"] not in kinds:
                bad(f"{where}: 모르는 kind '{f['kind']}'")
            if not isinstance(f["grid"], list) or len(f["grid"]) != f["rows"]:
                bad(f"{where}: grid 행 수가 rows({f['rows']})와 다르다")
                continue
            for r, row in enumerate(f["grid"]):
                if len(row) != f["cols"]:
                    bad(f"{where}: grid {r}행 길이 {len(row)}가 cols({f['cols']})와 다르다")
                    break
            # 골격 검사는 kind와 상관없다. 스키마가 header·colWidths를 모든 표에
            # 못박고 있고, 화면이 작성례 표도 그대로 그려 준다
            if len(f["header"]) != f["cols"]:
                bad(f"{where}: header 길이 {len(f['header'])}가 cols({f['cols']})와 다르다")
            if len(f["colWidths"]) != f["cols"]:
                bad(f"{where}: colWidths 길이가 cols({f['cols']})와 다르다")
            else:
                if f["cols"] and sum(f["colWidths"]) != 100:
                    bad(f"{where}: colWidths 합이 100이 아니다({sum(f['colWidths'])})")
                if any(w < 0 for w in f["colWidths"]):
                    bad(f"{where}: colWidths에 음수가 있다({f['colWidths']})")
            # 스키마: required는 kind가 blank인 표만 참
            if (f["required"] is True) != (f["kind"] == "blank"):
                bad(f"{where}: kind '{f['kind']}'인데 required가 {f['required']}다")


def fill(grid: list[list[str]]) -> float:
    cells = [c for row in grid for c in row]
    return sum(1 for c in cells if c.strip()) / len(cells) if cells else 0.0


def check_kind_rules(cat: dict) -> None:
    """kind 판정이 스키마 규칙대로 나왔는가.

    골격만 보는 검사는 판정 규칙이 통째로 빠져도 통과한다(작성례가 전부 빈
    양식으로 둔갑해도 rows·cols·colWidths는 멀쩡하다). 그래서 스키마가 못박은
    규칙을 산출물 쪽에서 되짚어 본다.
    """
    layout_shapes: list[tuple[int, int]] = []
    for n in cat["nodes"]:
        for f in n["forms"]:
            where = f"{n['id']} 표 {f['idx']}"
            grid, kind = f["grid"], f["kind"]
            if kind == "blank":
                if not any(h.strip() for h in f["header"]):
                    bad(f"{where}: 머리행이 통째로 비었는데 blank다 — layout이어야 한다")
                if fill(grid[1:]) >= 0.55:
                    bad(f"{where}: 데이터 칸이 {fill(grid[1:]):.0%} 차 있는데 blank다"
                        " — 작성례가 빈 양식으로 새어 나왔다")
            elif kind == "example":
                if fill(grid) == 0:
                    bad(f"{where}: 작성례인데 격자가 통째로 비었다")
            elif kind == "layout":
                layout_shapes.append((f["rows"], f["cols"]))
            elif kind == "howto":
                if (f["rows"], f["cols"]) != (3, 3):
                    bad(f"{where}: 지시문 박스는 3×3인데 {f['rows']}×{f['cols']}다")
            elif kind == "note":
                first = grid[0][0] if grid and grid[0] else ""
                if (f["rows"], f["cols"]) != (1, 1) or not first.strip().startswith("※"):
                    bad(f"{where}: 참조 박스는 1×1 ※ 표여야 한다")
            # 규칙을 거꾸로도 본다 — 1×1 ※ 표인데 note가 아니면 판정이 샌 것
            if (kind != "note" and (f["rows"], f["cols"]) == (1, 1)
                    and grid and grid[0] and grid[0][0].strip().startswith("※")):
                bad(f"{where}: 1×1 ※ 표인데 kind가 '{kind}'다")
    # 스키마가 이름까지 적어 둔 두 건(전략체계도)이다. 늘거나 줄면 판정이 샌 것
    if sorted(layout_shapes) != sorted([(27, 29), (16, 15)]):
        bad(f"표로 그린 도식(layout)이 27×29·16×15 두 건이 아니다: {layout_shapes}")


def check_titles(cat: dict) -> None:
    """같은 제목이 두 번 나오면 뒤엣것에 #2를 붙인다(스키마 규칙)."""
    seen: dict[str, str] = {}
    for n in cat["nodes"]:
        title = n["title"]
        if title in seen:
            bad(f"{n['id']}: 제목 '{title}'가 '{seen[title]}'와 똑같다 — #n을 안 붙였다")
        seen[title] = n["id"]


def check_howto(cat: dict) -> None:
    for n in cat["nodes"]:
        h = n["howto"]
        if h is None:
            continue
        for key in ("purpose", "method", "raw", "chars"):
            if key not in h:
                bad(f"{n['id']} howto에 '{key}' 키가 없다")
        if not h.get("raw"):
            bad(f"{n['id']} howto의 raw가 비었다")
        elif h.get("chars") != len(h["raw"]):
            bad(f"{n['id']} howto의 chars가 raw 길이와 다르다")
        # 안내서의 지시문 박스 16개는 모두 작성취지·작성방법 라벨을 달고 있다.
        # 하나라도 못 갈라내면 라벨 인식이 샌 것이고, 그 글월이 통째로
        # purpose 꼬리에 붙어 집필 화면에 작성방법이 사라진다
        for key in ("purpose", "method"):
            if not h.get(key):
                bad(f"{n['id']} howto에서 {key}를 못 갈라냈다 — 라벨 인식이 샜다")


#: 수량 제약이 걸릴 수 있는 대상. build_catalog.SCOPE_TERMS와 같아야 한다
SCOPE_TERMS = {"추진전략", "사회보장 전략", "균형발전 전략", "중점추진사업", "세부사업",
               "대표과업", "세부과업", "성과지표", "주요 계획", "전략과제", "핵심과제", "전략"}


def check_limits(cat: dict) -> None:
    for n in cat["nodes"]:
        for l in n["limits"]:
            for key in ("text", "scope", "op", "n", "unit"):
                if key not in l:
                    bad(f"{n['id']} limits에 '{key}' 키가 없다")
            if l.get("op") not in ("max", "min"):
                bad(f"{n['id']} limits의 op가 max/min이 아니다: {l.get('op')}")
            if not isinstance(l.get("n"), int):
                bad(f"{n['id']} limits의 n이 정수가 아니다")
            # 대상이 목록 밖이면 되짚기가 앞 어절을 삼킨 것이다 → 검사에 못 쓴다
            if l.get("scope") not in SCOPE_TERMS:
                bad(f"{n['id']} limits의 scope가 목록 밖이다: '{l.get('scope')}'")
            head = (l.get("text") or "").split()
            if not head:
                bad(f"{n['id']} limits의 text가 비었다 — 화면에 근거를 못 보여준다")
            elif l.get("scope") and head[0][:2] != l["scope"][:2]:
                bad(f"{n['id']} limits의 text가 scope로 시작하지 않는다: '{l.get('text')}'")


def check_links(cat: dict) -> None:
    """지침 연결·되풀이 연결·도식형 분류가 쓸 수 있는 상태인가."""
    by_id = {n["id"]: n for n in cat["nodes"]}
    for n in cat["nodes"]:
        for key in ("howto_ref", "mirrors"):
            if key not in n:
                bad(f"{n['id']}에 '{key}' 키가 없다")
        ref = n.get("howto_ref")
        if n["howto"] and ref is not None:
            bad(f"{n['id']}: 지침을 직접 가졌는데 howto_ref도 있다")
        if ref is not None:
            if ref not in by_id:
                bad(f"{n['id']}: howto_ref '{ref}'가 목록에 없다")
            elif not by_id[ref]["howto"]:
                bad(f"{n['id']}: howto_ref '{ref}'에 지침이 없다")
            elif ref == n["id"]:
                bad(f"{n['id']}: howto_ref가 자기 자신이다")
        if not n["howto"] and ref is None:
            bad(f"{n['id']}: 지침도 참조도 없다 — 집필 화면이 빈손이 된다")

        mir = n.get("mirrors")
        if mir is not None:
            if mir not in by_id:
                bad(f"{n['id']}: mirrors '{mir}'가 목록에 없다")
            elif by_id[mir].get("mirrors"):
                bad(f"{n['id']}: mirrors가 또 다른 mirrors를 가리킨다")
            elif mir == n["id"]:
                bad(f"{n['id']}: mirrors가 자기 자신이다")

    # 도식형은 머리행이 비어 있어야 하고, 작성용 양식에서 빠져 있어야 한다
    for n in cat["nodes"]:
        for f in n["forms"]:
            if f["kind"] != "layout":
                continue
            if any(h.strip() for h in f["header"]):
                bad(f"{n['id']} 표 {f['idx']}: layout인데 머리행에 글이 있다")
            if f["required"]:
                bad(f"{n['id']} 표 {f['idx']}: layout인데 required가 참이다")


# ---------------------------------------------------------------------------
def check_template() -> None:
    if not TEMPLATE.exists():
        bad("app/data/template.hwpx가 없다")
        return
    if not SOURCE.exists():
        bad(f"원본이 없다: {SOURCE}")
        return
    with zipfile.ZipFile(SOURCE) as s, zipfile.ZipFile(TEMPLATE) as t:
        src_names, dst_names = s.namelist(), t.namelist()
        if src_names != dst_names:
            bad("template.hwpx의 zip 항목 목록이 원본과 다르다")
        for name in KEEP:
            if name not in dst_names:
                bad(f"template.hwpx에 {name}이 없다")
                continue
            a = hashlib.sha256(s.read(name)).hexdigest()
            b = hashlib.sha256(t.read(name)).hexdigest()
            if a != b:
                bad(f"{name}의 SHA-256이 원본과 다르다: {a[:12]} != {b[:12]}")
        # content.hpf는 문서 정보를 지우느라 일부러 바꾼다. 나머지는 그대로여야 한다.
        for name in dst_names:
            if name in (BODY_SECTION, HPF) or name in KEEP:
                continue
            if hashlib.sha256(s.read(name)).digest() != hashlib.sha256(t.read(name)).digest():
                bad(f"{name}이 원본과 다르다(본문 구역만 손대야 한다)")

        # 원본 문서에 딸려 온 개인·추적 정보가 템플릿에 남으면 산출물마다 따라간다
        hpf = t.read(HPF).decode("utf-8")
        for leak in ("Fasoo", "Administrator", "kihasa", "Trace_ID"):
            if leak in hpf:
                bad(f"template.hwpx의 content.hpf에 '{leak}'이 남아 있다")
        # 원본 제목 자리에는 본문 첫 문장이 통째로 들어 있었다 → 양식 이름이어야 한다
        m = re.search(r"<opf:title>(.*?)</opf:title>", hpf, re.S)
        if not m:
            bad("content.hpf에 opf:title이 없다")
        elif m.group(1).strip() != PINNED["source"]:
            bad(f"content.hpf의 제목이 양식 이름이 아니다: '{m.group(1).strip()[:40]}…'")
        for meta in re.finditer(r"<opf:meta\b[^>]*>(.*?)</opf:meta>", hpf, re.S):
            if meta.group(1).strip():
                bad(f"content.hpf 문서 정보가 안 지워졌다: {meta.group(0)[:60]}…")
        for tag in ("<opf:manifest>", "<opf:spine>", 'href="Contents/header.xml"',
                    f'href="{BODY_SECTION}"'):
            if tag not in hpf:
                bad(f"content.hpf에서 {tag}가 사라졌다 — 문서 정보만 지워야 한다")
        try:
            ET.fromstring(hpf)
        except ET.ParseError as e:
            bad(f"content.hpf가 깨진 XML이다: {e}")
        if t.infolist()[0].filename != "mimetype":
            bad("template.hwpx의 첫 항목이 mimetype이 아니다")
        elif t.infolist()[0].compress_type != zipfile.ZIP_STORED:
            bad("template.hwpx의 mimetype이 압축돼 있다")

        if BODY_SECTION not in dst_names:
            bad(f"template.hwpx에 {BODY_SECTION}이 없다")
            return
        raw = t.read(BODY_SECTION).decode("utf-8")

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        bad(f"template.hwpx의 본문 구역이 깨진 XML이다: {e}")
        return
    if "<hp:secPr" not in raw:
        bad("본문 구역에서 hp:secPr(용지 설정)이 사라졌다")
    text = "".join(x.text or "" for x in root.iter(HP + "t")).strip()
    if text:
        bad(f"본문 구역 문단이 안 비었다: {text[:40]!r}")
    tables = len(list(root.iter(HP + "tbl")))
    if tables:
        bad(f"본문 구역에 표가 {tables}개 남았다")
    body = [p for p in root if p.tag == HP + "p"]
    for i, p in enumerate(body):
        # 남아도 되는 문단은 용지·단 설정을 지고 있는 구역 정의 문단뿐이다
        if not (p.find(f".//{HP}secPr") is not None or p.find(f".//{HP}colPr") is not None):
            bad(f"본문 구역 {i}번 문단은 구역 정의가 아닌데 남아 있다")


def check_form() -> None:
    if not FORM.exists():
        bad("app/data/form.json이 없다")
        return
    form = json.loads(FORM.read_text(encoding="utf-8"))
    if form.get("section") != BODY_SECTION:
        bad(f"form.json의 section이 {BODY_SECTION}이 아니다: {form.get('section')}")
    levels = form.get("levels")
    if not isinstance(levels, list) or not levels:
        bad("form.json에 levels가 없다")
        return

    seen: dict[str, str] = {}
    for lv in levels:
        marker = lv.get("marker", "")
        name = lv.get("name", "?")
        if marker == "":
            continue
        if marker in seen:
            bad(f"form.json 마커 '{marker}'가 '{seen[marker]}'와 '{name}'에 겹친다")
        seen[marker] = name
    note = form.get("table_note")
    if note and note.get("marker") in seen:
        bad(f"form.json 표 주 마커 '{note['marker']}'가 "
            f"'{seen[note['marker']]}' 레벨과 겹친다")

    for lv in levels:
        for key in ("key", "marker", "name", "style", "para", "char", "seen"):
            if key not in lv:
                bad(f"form.json 레벨 '{lv.get('name')}'에 '{key}' 키가 없다")
        if lv.get("marker") and not lv.get("seen"):
            bad(f"form.json 레벨 '{lv.get('name')}'은 본문에서 안 쓰였는데 마커가 있다")
        # 계약 1절: auto_bullet·auto_number가 있으면 도구가 기호를 또 찍으면 안 된다
        if lv.get("write_marker") and (lv.get("auto_bullet") is not None
                                       or lv.get("auto_number") is not None):
            bad(f"form.json 레벨 '{lv.get('name')}': 한글이 글머리표를 붙이는데"
                " write_marker가 참이라 기호가 겹친다")

    # 빌더가 마디 markers를 매길 때 쓰는 짝(build_catalog.STYLE_MARKER)과 어긋나면
    # 카탈로그가 알려 준 마커로 글을 써도 조판이 딴 스타일로 나간다
    for lv in levels + ([note] if note else []):
        want = BUILDER_MARKER.get(lv.get("style"))
        if want is not None and lv.get("marker") != want:
            bad(f"form.json 스타일 {lv.get('style')}의 마커 '{lv.get('marker')}'가 "
                f"build_catalog.STYLE_MARKER의 '{want}'와 다르다")
    for sid, want in BUILDER_MARKER.items():
        if sid not in {lv.get("style") for lv in levels + ([note] if note else [])}:
            bad(f"build_catalog가 마커 '{want}'로 세는 스타일 {sid}가 form.json에 없다")

    tbl = form.get("table") or {}
    if tbl.get("guessed"):
        bad("form.json의 표 골격이 아직 기본값(guessed=true)이다")
    for key in ("border_fill", "header_fill", "body_fill", "width", "row_min_height"):
        if not isinstance(tbl.get(key), int) or tbl[key] <= 0:
            bad(f"form.json table.{key}가 실측값이 아니다: {tbl.get(key)}")
    cell = tbl.get("cell_para") or {}
    if not all(isinstance(cell.get(k), int) for k in ("style", "para", "char")):
        bad(f"form.json table.cell_para가 온전하지 않다: {cell}")
    elif cell["para"] <= 0 or cell["char"] <= 0:
        bad(f"form.json table.cell_para가 아직 기본값(0/0/0)이다: {cell}")
    if not form.get("notes"):
        bad("form.json에 고친 사유(notes)가 없다")

    # 앞부분 보존 구간이 실제 템플릿과 맞는가
    if TEMPLATE.exists():
        with zipfile.ZipFile(TEMPLATE) as z:
            raw = z.read(BODY_SECTION).decode("utf-8")
        want = len(raw.encode("utf-8")) - len("</hs:sec>")
        if form.get("preamble_bytes") != want:
            bad(f"form.json의 preamble_bytes({form.get('preamble_bytes')})가 "
                f"template.hwpx의 보존 구간({want})과 다르다")
        check_page(form, raw)


#: 1mm의 HWPUNIT
MM = 283.465


def check_page(form: dict, section_xml: str) -> None:
    """form.json의 용지값이 본문 구역 secPr에서 잰 값과 같은가.

    표지 구역(section0)의 값을 그대로 베끼면 위·아래 여백이 틀어진다. 실제로
    한 번 틀어졌던 자리라 원본에서 다시 재서 대조한다.
    """
    page = form.get("page") or {}
    body = re.search(r"<hp:secPr\b.*?</hp:secPr>", section_xml, re.S)
    if not body:
        bad("본문 구역에서 hp:secPr을 못 찾아 용지값을 대조하지 못했다")
        return
    pp = re.search(r"<hp:pagePr\b[^>]*>", body.group(0))
    mg = re.search(r"<hp:margin\b[^>]*/?>", body.group(0))
    if not (pp and mg):
        bad("본문 구역 secPr에 pagePr·margin이 없다")
        return

    def attr(tag: str, name: str) -> int | None:
        m = re.search(rf'\b{name}="(-?\d+)"', tag)
        return int(m.group(1)) if m else None

    for key, name in (("width", "width"), ("height", "height")):
        got, want = page.get(key), attr(pp.group(0), name)
        if got != want:
            bad(f"form.json page.{key}({got})가 본문 구역 값({want})과 다르다")
    margins = page.get("margin_mm") or {}
    for key in ("left", "right", "top", "bottom", "header", "footer"):
        unit = attr(mg.group(0), key)
        if unit is None:
            bad(f"본문 구역 margin에 {key}가 없다")
            continue
        want = round(unit / MM, 1)
        if margins.get(key) != want:
            bad(f"form.json page.margin_mm.{key}({margins.get(key)})가 "
                f"본문 구역 값({want}mm)과 다르다")


def check_rebuild(cat: dict) -> None:
    """sections.json이 정말 빌더가 뽑은 그대로인가.

    스키마가 '사람이 손으로 고치지 않는다'고 못박았다. 산출물만 읽는 검사는
    누가 json을 손으로 고쳐도 통과한다. 그래서 원본에서 다시 뽑아 대조한다.
    generated_at은 돌릴 때마다 바뀌므로 뺀다.
    """
    if not SOURCE.exists():
        bad(f"원본이 없다: {SOURCE}")
        return
    sys.path.insert(0, str(ROOT / "tools"))
    try:
        import build_catalog
    except Exception as e:                       # noqa: BLE001
        bad(f"tools/build_catalog.py를 못 읽었다: {e}")
        return
    with zipfile.ZipFile(SOURCE) as z:
        names = set(z.namelist())
        toc = (z.read(build_catalog.TOC_SECTION).decode("utf-8")
               if build_catalog.TOC_SECTION in names else None)
        fresh = build_catalog.build_catalog(
            z.read(build_catalog.BODY_SECTION).decode("utf-8"),
            z.read(build_catalog.HEADER_XML).decode("utf-8"), toc)
    a = dict(cat)
    b = dict(fresh)
    a.pop("generated_at", None)
    b.pop("generated_at", None)
    if a == b:
        return
    for key in sorted(set(a) | set(b)):
        if a.get(key) == b.get(key):
            continue
        if key != "nodes":
            bad(f"sections.json의 '{key}'가 빌더 산출과 다르다: "
                f"{a.get(key)!r} != {b.get(key)!r}")
            continue
        want = {n["id"]: n for n in b["nodes"]}
        got = {n["id"]: n for n in a["nodes"]}
        for nid in sorted(set(want) | set(got)):
            if nid not in got:
                bad(f"sections.json에 마디 '{nid}'가 빠졌다(빌더는 낸다)")
            elif nid not in want:
                bad(f"sections.json의 마디 '{nid}'는 빌더가 안 낸다")
            elif got[nid] != want[nid]:
                diff = [f for f in set(got[nid]) | set(want[nid])
                        if got[nid].get(f) != want[nid].get(f)]
                bad(f"마디 '{nid}'가 빌더 산출과 다르다: {', '.join(sorted(diff))}")


def check_style_names() -> None:
    """form.json의 style 번호와 이름이 header.xml과 맞는가."""
    if not (FORM.exists() and SOURCE.exists()):
        return
    form = json.loads(FORM.read_text(encoding="utf-8"))
    with zipfile.ZipFile(SOURCE) as z:
        header = z.read("Contents/header.xml").decode("utf-8")
    names: dict[int, str] = {}
    for m in re.finditer(r"<hh:style\b[^>]*>", header):
        tag = m.group(0)
        sid = re.search(r'\bid="(\d+)"', tag)
        nm = re.search(r'\bname="([^"]*)"', tag)
        if sid and nm:
            names[int(sid.group(1))] = nm.group(1)
    entries = list(form.get("levels") or [])
    if form.get("table_note"):
        entries.append(form["table_note"])
    for lv in entries:
        sid = lv.get("style")
        if sid not in names:
            bad(f"form.json의 스타일 {sid}가 header.xml에 없다")
        elif names[sid] != lv.get("name"):
            bad(f"form.json 스타일 {sid}의 이름 '{lv.get('name')}'가 "
                f"header.xml의 '{names[sid]}'와 다르다")


# ---------------------------------------------------------------------------
def main() -> int:
    if not SECTIONS.exists():
        print("[실패] app/data/sections.json이 없다. tools/build_catalog.py를 먼저 돌려라")
        return 1
    cat = json.loads(SECTIONS.read_text(encoding="utf-8"))

    check_schema(cat)
    if not fails:
        check_pinned(cat)
        check_tree(cat)
        check_counts(cat)
        check_ids_as_filenames(cat)
        check_forms(cat)
        check_kind_rules(cat)
        check_titles(cat)
        check_howto(cat)
        check_limits(cat)
        check_links(cat)
        check_rebuild(cat)
    check_template()
    check_form()
    check_style_names()

    if fails:
        print(f"[실패] {len(fails)}건")
        for f in fails:
            print("  -", f)
        return 1

    forms = [f for n in cat["nodes"] for f in n["forms"]]
    kinds = {k: sum(1 for f in forms if f["kind"] == k)
             for k in ("blank", "example", "note", "howto")}
    print("[통과] 절 카탈로그 검사 이상 없음")
    print(f"  장 {cat['stats']['chapters']} · 마디 {len(cat['nodes'])}"
          f" (절 {sum(1 for n in cat['nodes'] if n['depth'] == 1)}"
          f" · 항 {sum(1 for n in cat['nodes'] if n['depth'] == 2)}"
          f" · 목 {sum(1 for n in cat['nodes'] if n['depth'] == 3)})")
    print(f"  표 {len(forms)} — 빈 양식 {kinds['blank']} · 작성례 {kinds['example']}"
          f" · 참조 {kinds['note']} · 지시문 {kinds['howto']}")
    print(f"  수량 제약 {sum(len(n['limits']) for n in cat['nodes'])}건 ·"
          f" 수정불가 마디 {sum(1 for n in cat['nodes'] if n['fixed'])}개")
    return 0


if __name__ == "__main__":
    sys.exit(main())
