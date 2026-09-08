#!/usr/bin/env python3
"""제6기 수립 안내(hwpx)에서 절 카탈로그와 배포용 템플릿을 뽑아낸다.

  python3 tools/build_catalog.py            # sections.json + template.hwpx 둘 다
  python3 tools/build_catalog.py --sections # sections.json만
  python3 tools/build_catalog.py --template # template.hwpx만

표준 라이브러리만 쓴다(zipfile, xml.etree, re, json). 산출물 스키마는
docs/SECTIONS_SCHEMA.md 그대로다.

## 안내서 본문 구조 실측

  구역이 3개다. section0=표지, section1=제출문·목차, section2=본문(4.15MB).
  본문 구역의 최상위 문단은 301개뿐이고 알맹이는 대부분 표 안에 들어 있다.

  깊이 0(장)  「제1절」~「제5절」 띠 그림. 컨테이너 안 drawText의 스타일 40(##123)
  깊이 1(절)  스타일 1(가.)   — 가. 나. 다. … / [첨부 n] / [별첨 n]
  깊이 2(항)  스타일 2(매뉴얼_1)) — 1) 2) 3) …
  깊이 3(목)  스타일 10((1))    — (1) (2) (3) …

  스타일이 맞아도 번호 표기가 없는 문단(빈 줄, 지시문 박스를 담은 문단)은
  제목이 아니다. 그래서 스타일과 번호 정규식을 함께 본다.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "source" / "제6기_지역사회보장계획_수립안내_시군구.hwpx"
OUT_SECTIONS = ROOT / "app" / "data" / "sections.json"
OUT_TEMPLATE = ROOT / "app" / "data" / "template.hwpx"

BODY_SECTION = "Contents/section2.xml"
HEADER_XML = "Contents/header.xml"
TOC_SECTION = "Contents/section1.xml"
SOURCE_TITLE = "제6기(2027~2030) 지역사회보장계획 수립 안내 [시·군·구]"

#: 지시문 박스를 알아보는 표식
HOWTO_MARK = "◆ 작성 취지 및 방법 ◆"
#: 작성례 구간을 여는 문단. 이 문단부터 다음 지시문 박스까지의 표는 작성례다
EXAMPLE_MARK = "작성양식 및 예시"

#: 파일명에 못 쓰는 글자
BAD_NAME = re.compile(r'[/\\:*?"<>|]')

#: 마디 본문에서 실제로 쓰인 스타일 → 작성용 마커. form.json의 levels와 짝이 맞아야 한다
STYLE_MARKER = {
    40: "#",     # ##123        장 제목
    1: "##",     # 가.          절 제목
    2: "###",    # 매뉴얼_1)    항 제목
    10: "####",  # (1)          목 제목
    3: "◆",     # 작성방법(네모) 지시문·구간 머리
    4: "○",     # 요약_원      개조식 1단
    5: "-",      # 요약_하이픈  개조식 2단
    6: "·",      # 요약_점      개조식 3단
    56: "▶",    # 가)          소제목
    16: "◎",    # 단위         표 단위 표기
    17: "※",    # 주, 자료     표 주
}

#: 스타일 번호가 가리키는 이름. header.xml과 어긋나면 안내서가 바뀐 것이니 멈춘다
STYLE_NAME = {
    40: "##123", 1: "가.", 2: "매뉴얼_1)", 10: "(1)", 3: "작성방법(네모)",
    4: "요약_원", 5: "요약_하이픈", 6: "요약_점", 56: "가)", 16: "단위",
    17: "주, 자료", 0: "바탕글",
}

#: 제목 스타일 → 깊이
HEADING_STYLE_DEPTH = {1: 1, 2: 2, 10: 3}

RE_H1 = re.compile(r"^제(\d+)절$")
RE_H2_HANGUL = re.compile(r"^\s*([가-힣])\.\s*(\S.*)$")
RE_H2_ANNEX = re.compile(r"^\s*\[(첨부|별첨)\s*(\d+)\]\s*(\S.*)$")
RE_H3 = re.compile(r"^\s*(\d+)\)\s*(\S.*)$")
RE_H4 = re.compile(r"^\s*\((\d+)\)\s*(\S.*)$")

#: 수량 제약. 숫자·단위·연산자만 정규식으로 잡고, 대상은 아래 목록에서 고른다
RE_LIMIT = re.compile(r"(?P<n>\d+)\s*(?P<unit>개|건|명)\s*(?P<op>이내|이상|이하)")

#: 계획서에서 실제로 개수를 세는 단위. 목록에 없는 말은 제약 대상으로 잡지 않는다.
#: 숫자 앞 40자를 되짚어 이 가운데 가장 가까운 것을 고른다. 되짚기만으로 대상을
#: 추리면 '있는 5개', '반올림함 2개'처럼 앞 어절이 딸려 와 검사에 못 쓴다.
SCOPE_TERMS = (
    "추진전략", "사회보장 전략", "균형발전 전략", "중점추진사업", "세부사업",
    "대표과업", "세부과업", "성과지표", "주요 계획", "전략과제", "핵심과제", "전략",
)

RE_FIXED = re.compile(r"수정\s*불가")

#: 목차의 장 줄. 「01제6기 … 정책 방향 및 체계  _ 76」
RE_TOC = re.compile(r"^(\d{2})(\S.*?)\s*_\s*(\d+)$")


def read_parts(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        want = [BODY_SECTION, HEADER_XML]
        if TOC_SECTION in names:
            want.append(TOC_SECTION)
        return {n: z.read(n) for n in want}


def toc_pages(toc_xml: str) -> dict[int, int]:
    """목차에서 장별 쪽번호를 얻는다. 마디 쪽번호는 목차에 없어 null로 남는다."""
    root = ET.fromstring(toc_xml)
    out: dict[int, int] = {}
    for p in root.iter(HP + "p"):
        text = "".join(t.text or "" for t in p.iter(HP + "t")).strip()
        m = RE_TOC.match(text)
        if m:
            out[int(m.group(1))] = int(m.group(3))
    return out


# ---------------------------------------------------------------------------
# hwpx 읽기
# ---------------------------------------------------------------------------
def style_names(header_xml: str) -> dict[int, str]:
    """header.xml의 <hh:style id name>에서 스타일 이름표를 얻는다."""
    out: dict[int, str] = {}
    for m in re.finditer(r"<hh:style\b[^>]*>", header_xml):
        tag = m.group(0)
        sid = re.search(r'\bid="(\d+)"', tag)
        name = re.search(r'\bname="([^"]*)"', tag)
        if sid and name:
            out[int(sid.group(1))] = name.group(1)
    return out


def para_text(p: ET.Element) -> str:
    return "".join(t.text or "" for t in p.iter(HP + "t"))


def cell_text(tc: ET.Element) -> str:
    """셀 안 문단을 줄바꿈으로 이어 붙인다."""
    lines = []
    for sub in tc.iter(HP + "p"):
        lines.append("".join(t.text or "" for t in sub.iter(HP + "t")))
    return "\n".join(lines).strip()


def outer_tables(p: ET.Element) -> list[ET.Element]:
    """문단에 직접 달린 표만. 지시문 박스 안에 든 표는 세지 않는다."""
    found: list[ET.Element] = []

    def walk(el: ET.Element, nested: bool) -> None:
        for child in el:
            if child.tag == HP + "tbl":
                if not nested:
                    found.append(child)
                walk(child, True)
            else:
                walk(child, nested)

    walk(p, False)
    return found


def banner_title(p: ET.Element) -> tuple[str, str] | None:
    """「제N절」 띠 그림에서 (번호 표기, 제목)을 꺼낸다.

    띠는 컨테이너 도형이고 그 안 drawText 문단 두 개가 각각 번호와 제목이다.
    제목 쪽만 스타일 40(##123)을 쓴다.
    """
    no = title = ""
    for sub in p.iter(HP + "p"):
        if sub is p:
            continue
        text = "".join(t.text or "" for t in sub.iter(HP + "t")).strip()
        if not text:
            continue
        if RE_H1.match(text):
            no = text
        elif sub.get("styleIDRef") == "40" and not title:
            title = text
    if no and title:
        return no, title
    return None


# ---------------------------------------------------------------------------
# 표 읽기
# ---------------------------------------------------------------------------
def table_grid(tbl: ET.Element) -> tuple[list[list[str]], list[int], int, int]:
    """표를 행×열 문자열 격자로 편다.

    병합된 칸은 왼쪽 위 칸에만 글자를 두고 나머지는 빈 문자열로 남긴다.
    열 너비는 colSpan이 1인 칸에서 모아 백분율로 고친다(합 100).
    """
    rows = int(tbl.get("rowCnt", "0"))
    cols = int(tbl.get("colCnt", "0"))
    grid = [["" for _ in range(cols)] for _ in range(rows)]
    widths: dict[int, int] = {}
    for tr in tbl:
        if tr.tag != HP + "tr":
            continue
        for tc in tr:
            if tc.tag != HP + "tc":
                continue
            addr = tc.find(HP + "cellAddr")
            span = tc.find(HP + "cellSpan")
            size = tc.find(HP + "cellSz")
            if addr is None:
                continue
            r = int(addr.get("rowAddr", "0"))
            c = int(addr.get("colAddr", "0"))
            if 0 <= r < rows and 0 <= c < cols:
                grid[r][c] = cell_text(tc)
            cspan = int(span.get("colSpan", "1")) if span is not None else 1
            if size is not None and cspan == 1:
                widths.setdefault(c, int(size.get("width", "0")))
    return grid, col_percent(widths, cols), rows, cols


def col_percent(widths: dict[int, int], cols: int) -> list[int]:
    """열 너비를 백분율 정수로. 합이 반드시 100이 되게 마지막 열에서 맞춘다."""
    if cols <= 0:
        return []
    known = [w for w in widths.values() if w > 0]
    fallback = sum(known) // len(known) if known else 1
    raw = [widths.get(c) or fallback for c in range(cols)]
    total = sum(raw) or 1
    pct = [max(1, round(w * 100 / total)) for w in raw]
    pct[-1] += 100 - sum(pct)
    if pct[-1] < 1:  # 열이 너무 많아 마지막이 눌리면 가장 넓은 열에서 덜어 온다
        deficit = 1 - pct[-1]
        pct[-1] = 1
        biggest = max(range(cols), key=lambda i: pct[i])
        pct[biggest] -= deficit
    return pct


def fill_ratio(grid: list[list[str]]) -> float:
    cells = [c for row in grid for c in row]
    if not cells:
        return 0.0
    return sum(1 for c in cells if c.strip()) / len(cells)


# ---------------------------------------------------------------------------
# 지시문 박스
# ---------------------------------------------------------------------------
def howto_from(grid: list[list[str]]) -> dict:
    """지시문 박스에서 작성취지·작성방법을 갈라낸다."""
    raw = "\n".join(c for row in grid for c in row if c.strip())
    purpose = method = None
    pi = raw.find("작성취지")
    mi = raw.find("작성방법")
    if pi >= 0 and mi > pi:
        purpose = raw[pi + len("작성취지"):mi].strip() or None
        method = raw[mi + len("작성방법"):].strip() or None
    elif pi >= 0:
        purpose = raw[pi + len("작성취지"):].strip() or None
    return {"purpose": purpose, "method": method, "raw": raw, "chars": len(raw)}


def pick_scope(before: str) -> str | None:
    """숫자 앞 글월에서 제약이 걸린 대상을 고른다. 못 고르면 None."""
    best: tuple[int, int, str] | None = None
    for term in SCOPE_TERMS:
        i = before.rfind(term)
        if i < 0:
            continue
        # 숫자에 가장 가까운 것, 같은 자리면 긴 것('전략'보다 '추진전략')
        cand = (i + len(term), len(term), term)
        if best is None or cand > best:
            best = cand
    return best[2] if best else None


def find_limits(text: str) -> list[dict]:
    """지시문에서 '추진전략 5개 이내' 꼴의 수량 제약을 뽑는다.

    대상은 SCOPE_TERMS에 있는 말만 인정한다. 되짚기로 아무 한글이나 잡으면
    '있는 5개', '반올림함 2개' 같은 토막이 나와 검사에 쓸 수 없다.
    """
    flat = re.sub(r"\s+", " ", text)
    out: list[dict] = []
    seen: set[tuple] = set()
    for m in RE_LIMIT.finditer(flat):
        start = max(0, m.start() - 40)
        scope = pick_scope(flat[start:m.start()])
        if not scope:
            continue
        op = "min" if m.group("op") == "이상" else "max"
        n = int(m.group("n"))
        key = (scope, op, n, m.group("unit"))
        if key in seen:
            continue
        seen.add(key)
        at = flat.rindex(scope, start, m.start())
        out.append({
            "text": flat[at:m.end()].strip(),
            "scope": scope,
            "op": op,
            "n": n,
            "unit": m.group("unit"),
        })
    return out


# ---------------------------------------------------------------------------
# 카탈로그 조립
# ---------------------------------------------------------------------------
def check_styles(styles: dict[int, str]) -> None:
    """스타일 번호와 이름이 안내서와 맞는지 본다.

    번호만 믿고 돌리면 안내서가 바뀌었을 때 엉뚱한 스타일을 제목으로 잡고도
    조용히 결과를 낸다. 이름이 어긋나면 여기서 멈추는 편이 낫다.
    """
    for sid, name in STYLE_NAME.items():
        got = styles.get(sid)
        if got is None:
            raise SystemExit(f"[중단] header.xml에 스타일 {sid}가 없다")
        if got != name:
            raise SystemExit(
                f"[중단] 스타일 {sid}의 이름이 '{name}'이 아니라 '{got}'다. "
                "안내서가 바뀌었으면 STYLE_MARKER·STYLE_NAME을 다시 맞춰라")


class Builder:
    def __init__(self) -> None:
        self.nodes: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.stack: list[dict] = []          # 깊이별 현재 마디
        self.titles: dict[str, int] = {}     # 제목 중복 세기
        self.example_open = False            # '작성양식 및 예시' 구간 안인가
        self.prev_shape: tuple[int, int] | None = None   # 바로 앞 표의 골격

    # -- 마디 -------------------------------------------------------------
    def open_node(self, depth: int, no: str, title: str,
                  id_override: str | None = None) -> dict:
        parent = self.stack[depth - 1] if depth > 0 and len(self.stack) >= depth else None
        key = BAD_NAME.sub("_", no).strip() or "x"
        base = id_override or (f"{parent['id']}-{key}" if parent else key)
        nid = base
        n = 2
        while nid in self.by_id:
            nid = f"{base}_{n}"
            n += 1
        seen = self.titles.get(title, 0) + 1
        self.titles[title] = seen
        node = {
            "id": nid,
            "depth": depth,
            "no": no,
            "title": title if seen == 1 else f"{title} #{seen}",
            "page": None,
            "parent": parent["id"] if parent else None,
            "children": [],
            "howto": None,
            "forms": [],
            "limits": [],
            "fixed": False,
            "markers": [],
            "_text": [],
            "_marker_set": [],
        }
        if parent:
            parent["children"].append(nid)
        self.nodes.append(node)
        self.by_id[nid] = node
        del self.stack[depth:]
        while len(self.stack) < depth:
            self.stack.append(node)      # 중간 깊이가 비면 자기 자신으로 채운다
        self.stack.append(node)
        return node

    @property
    def current(self) -> dict | None:
        return self.stack[-1] if self.stack else None

    # -- 표 ---------------------------------------------------------------
    def add_table(self, node: dict, tbl: ET.Element) -> None:
        grid, widths, rows, cols = table_grid(tbl)
        flat = "\n".join(c for row in grid for c in row)
        shape = (rows, cols)
        ratio = fill_ratio(grid)

        if HOWTO_MARK in flat:
            kind = "howto"
            self.example_open = False
        elif rows == 1 and cols == 1 and flat.strip().startswith("※"):
            kind = "note"
        elif self.example_open:
            kind = "example"
        elif ratio >= 0.6 and self.prev_shape == shape:
            kind = "example"
        else:
            kind = "blank"

        if kind not in ("howto", "note"):
            self.prev_shape = shape

        header = list(grid[0]) if grid else []
        header += [""] * (cols - len(header))
        header = header[:cols]

        if kind == "blank":
            # 머리행이 통째로 빈 표는 전략체계도처럼 '표로 그린 도식'이다.
            # 파이프 표로 받아쓸 수 없으니 작성용 양식에서 뺀다(27×29, 16×15 두 건).
            if not any(h.strip() for h in header):
                kind = "layout"
            # 데이터 칸이 이미 절반 넘게 차 있으면 빈 양식이 아니라 작성례다
            elif fill_ratio(grid[1:]) >= 0.55:
                kind = "example"

        form = {
            "idx": len(node["forms"]),
            "kind": kind,
            "rows": rows,
            "cols": cols,
            "header": header,
            "grid": grid,
            "colWidths": widths,
            "required": kind == "blank",
        }
        node["forms"].append(form)

        if kind == "howto":
            howto = howto_from(grid)
            if node["howto"] is None:
                node["howto"] = howto
            node["_text"].append(howto["raw"])

    # -- 한 문단 ----------------------------------------------------------
    def feed(self, p: ET.Element) -> None:
        style = int(p.get("styleIDRef", "0"))
        text = para_text(p).strip()

        # 장 띠 그림
        banner = banner_title(p) if style == 0 else None
        if banner:
            no, title = banner
            idx = len(self.chapters()) + 1
            self.open_node(0, no, title, id_override=f"{idx:02d}")
            self.example_open = False
            self.prev_shape = None
            return

        depth = HEADING_STYLE_DEPTH.get(style)
        if depth is not None and text:
            head = self.parse_heading(depth, text)
            if head:
                no, title = head
                self.open_node(depth, no, title)
                self.example_open = False
                self.prev_shape = None
                return

        node = self.current
        if node is None:
            return
        if text:
            node["_text"].append(text)
            if EXAMPLE_MARK in text:
                self.example_open = True
        # 제목 스타일은 뼈대지 본문 마커가 아니다. 제목으로 안 잡힌 문단(지시문
        # 박스를 담은 '가.' 문단 같은 것)까지 마커로 세면 지침이 어지러워진다
        marker = None if style in HEADING_STYLE_DEPTH or style == 40 else STYLE_MARKER.get(style)
        if marker and text and marker not in node["_marker_set"]:
            node["_marker_set"].append(marker)
        for tbl in outer_tables(p):
            self.add_table(node, tbl)

    @staticmethod
    def parse_heading(depth: int, text: str) -> tuple[str, str] | None:
        if depth == 1:
            m = RE_H2_HANGUL.match(text)
            if m:
                return m.group(1), m.group(2).strip()
            m = RE_H2_ANNEX.match(text)
            if m:
                return f"{m.group(1)}{m.group(2)}", m.group(3).strip()
            return None
        if depth == 2:
            m = RE_H3.match(text)
            return (m.group(1), m.group(2).strip()) if m else None
        m = RE_H4.match(text)
        return (f"({m.group(1)})", m.group(2).strip()) if m else None

    def chapters(self) -> list[dict]:
        return [n for n in self.nodes if n["depth"] == 0]

    # -- 마무리 -----------------------------------------------------------
    def finish(self) -> list[dict]:
        for node in self.nodes:
            body = "\n".join(node["_text"])
            node["limits"] = find_limits(body)
            node["fixed"] = bool(RE_FIXED.search(body))
            node["markers"] = node["_marker_set"]
            del node["_text"]
            del node["_marker_set"]
        self.link_howto()
        self.link_mirrors()
        return self.nodes

    def link_howto(self) -> None:
        """지침이 없는 마디에 기댈 지침 자리를 적어 둔다.

        65개 마디 가운데 「작성 취지 및 방법」 박스를 직접 가진 것은 16개뿐이다.
        안내서가 박스를 절·항 한 곳에만 두기 때문인데, 그 자리가 위일 때도 있고
        아래일 때도 있다(01-가는 없고 01-가-1이 갖고 있다). 그래서 세 갈래로 찾는다.
          ① 조상 → ② 자손(문서 순서로 첫 번째) → ③ 같은 장 안에서 가장 가까운 마디
        글월을 복사해 두지는 않고 `howto_ref`에 그 마디 id만 남긴다.
        """
        order = {n["id"]: i for i, n in enumerate(self.nodes)}

        def chapter_of(node: dict) -> str:
            cur = node
            while cur["parent"]:
                cur = self.by_id[cur["parent"]]
            return cur["id"]

        def descendants(node: dict):
            for cid in node["children"]:
                kid = self.by_id[cid]
                yield kid
                yield from descendants(kid)

        for node in self.nodes:
            if node["howto"]:
                node["howto_ref"] = None
                continue
            ref = None
            cur = node["parent"]
            while cur and not ref:                                  # ① 조상
                if self.by_id[cur]["howto"]:
                    ref = cur
                cur = self.by_id[cur]["parent"]
            if not ref:                                             # ② 자손
                for kid in descendants(node):
                    if kid["howto"]:
                        ref = kid["id"]
                        break
            if not ref:                                             # ③ 같은 장 안
                mine, here = order[node["id"]], chapter_of(node)
                near = [n for n in self.nodes
                        if n["howto"] and chapter_of(n) == here]
                if near:
                    ref = min(near, key=lambda n: abs(order[n["id"]] - mine))["id"]
            node["howto_ref"] = ref

    def link_mirrors(self) -> None:
        """[사회보장 전략 2~4]처럼 1번 구조를 그대로 되풀이하는 마디를 이어 둔다.

        안내서는 전략 1만 펼쳐 적고 2~4는 제목만 둔다. 담당자가 전략 3을 골랐을 때
        전략 1의 표 양식과 지침을 그대로 쓸 수 있게 `mirrors`에 1번 마디 id를 적는다.
        """
        pat = re.compile(r"^\[(?P<kind>[^\]]*?전략)\s*(?P<n>\d+)[_\s]")
        first: dict[tuple[str | None, str], str] = {}
        for node in self.nodes:
            m = pat.match(node["title"])
            node["mirrors"] = None
            if not m:
                continue
            key = (node["parent"], m.group("kind").strip())
            if m.group("n") == "1" or key not in first:
                first.setdefault(key, node["id"])
                continue
            if first[key] != node["id"] and not node["children"] and not node["forms"]:
                node["mirrors"] = first[key]
                # 되풀이하는 마디는 1번 마디의 지침을 그대로 쓴다
                src = self.by_id[first[key]]
                node["howto_ref"] = first[key] if src["howto"] else src.get("howto_ref")


def build_catalog(section_xml: str, header_xml: str, toc_xml: str | None = None) -> dict:
    root = ET.fromstring(section_xml)
    check_styles(style_names(header_xml))
    builder = Builder()
    for p in root:
        if p.tag == HP + "p":
            builder.feed(p)
    nodes = builder.finish()

    pages = toc_pages(toc_xml) if toc_xml else {}
    for i, node in enumerate([n for n in nodes if n["depth"] == 0], start=1):
        node["page"] = pages.get(i)

    forms = sum(len(n["forms"]) for n in nodes)
    howtos = sum(1 for n in nodes if n["howto"])
    return {
        "source": SOURCE_TITLE,
        "scope": "시군구",
        "generated_at": _dt.datetime.now().replace(microsecond=0).isoformat(),
        "template": "template.hwpx",
        "body_section": BODY_SECTION,
        "stats": {
            "chapters": sum(1 for n in nodes if n["depth"] == 0),
            "nodes": len(nodes),
            "forms": forms,
            "howtos": howtos,
        },
        "nodes": nodes,
    }


# ---------------------------------------------------------------------------
# 배포용 템플릿
# ---------------------------------------------------------------------------
def blank_section(section_xml: str) -> str:
    """본문 구역에서 문단을 걷어내고 구역 정의만 남긴다.

    첫 문단이 용지·단 설정(hp:secPr, hp:colPr)을 지고 있고 그 뒤 run부터
    장 띠 그림이 시작된다. secPr을 담은 run이 끝나는 자리에서 잘라
    문단을 닫으면 용지 설정은 살고 본문은 빈다.
    """
    end = section_xml.find("</hp:secPr>")
    if end < 0:
        raise SystemExit("[중단] 본문 구역에서 hp:secPr을 찾지 못했다")
    run_end = section_xml.find("</hp:run>", end)
    if run_end < 0:
        raise SystemExit("[중단] hp:secPr을 담은 run의 끝을 찾지 못했다")
    run_end += len("</hp:run>")
    return section_xml[:run_end] + "</hp:p></hs:sec>"


#: 원본 문서에 딸려 온 개인·추적 정보. 템플릿으로 만든 모든 산출물에 그대로
#: 따라붙고 저장소도 공개이므로 지운다. 서식과는 무관한 값이다.
SCRUB_META = ("creator", "lastsaveby", "description", "subject", "keyword",
              "date", "CreatedDate", "ModifiedDate")


def scrub_hpf(xml: str) -> tuple[str, list[str]]:
    """content.hpf의 문서 정보를 지운다. 표지·서식·매니페스트는 건드리지 않는다."""
    dropped: list[str] = []
    for name in SCRUB_META:
        pat = re.compile(
            rf'<opf:meta name="{re.escape(name)}"[^>]*?(?:/>|>.*?</opf:meta>)', re.S)
        if pat.search(xml):
            dropped.append(name)
        xml = pat.sub(f'<opf:meta name="{name}" content="text"/>', xml)
    # 제목은 원본 문서의 첫 문장이 그대로 들어 있다 → 양식 이름으로 바꾼다
    title = re.compile(r"<opf:title>.*?</opf:title>", re.S)
    if title.search(xml):
        dropped.append("title")
    xml = title.sub(f"<opf:title>{SOURCE_TITLE}</opf:title>", xml)
    if "Fasoo" in xml:
        raise SystemExit("[중단] content.hpf에 문서추적 정보가 남았다")
    return xml, dropped


def build_template(src: Path, dst: Path) -> int:
    """원본을 그대로 베끼되 본문 구역만 빈 것으로 갈아 끼운다."""
    with zipfile.ZipFile(src) as z:
        items = [(i, z.read(i.filename)) for i in z.infolist()]
    blank = None
    dst.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dst, "w") as out:
        for info, data in items:
            if info.filename == BODY_SECTION:
                blank = blank_section(data.decode("utf-8"))
                ET.fromstring(blank)          # 깨진 XML을 내보내지 않는다
                data = blank.encode("utf-8")
            elif info.filename == "Contents/content.hpf":
                cleaned, dropped = scrub_hpf(data.decode("utf-8"))
                ET.fromstring(cleaned)
                data = cleaned.encode("utf-8")
                if dropped:
                    print(f"  문서 정보 {len(dropped)}개 지움: {', '.join(dropped)}")
            new = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            new.compress_type = info.compress_type
            new.external_attr = info.external_attr
            new.create_system = info.create_system
            out.writestr(new, data)
    if blank is None:
        raise SystemExit(f"[중단] 원본에 {BODY_SECTION}이 없다")
    return len(blank.encode("utf-8"))


# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="절 카탈로그·배포 템플릿 만들기")
    ap.add_argument("--source", type=Path, default=SOURCE)
    ap.add_argument("--sections", action="store_true", help="sections.json만 만든다")
    ap.add_argument("--template", action="store_true", help="template.hwpx만 만든다")
    args = ap.parse_args(argv)

    both = not (args.sections or args.template)
    if not args.source.exists():
        print(f"[중단] 원본이 없다: {args.source}", file=sys.stderr)
        return 1

    if both or args.sections:
        parts = read_parts(args.source)
        toc = parts.get(TOC_SECTION)
        catalog = build_catalog(parts[BODY_SECTION].decode("utf-8"),
                                parts[HEADER_XML].decode("utf-8"),
                                toc.decode("utf-8") if toc else None)
        OUT_SECTIONS.parent.mkdir(parents=True, exist_ok=True)
        OUT_SECTIONS.write_text(
            json.dumps(catalog, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        s = catalog["stats"]
        print(f"[됨] {OUT_SECTIONS.relative_to(ROOT)} — 장 {s['chapters']}, "
              f"마디 {s['nodes']}, 표 {s['forms']}, 지시문 {s['howtos']}")

    if both or args.template:
        size = build_template(args.source, OUT_TEMPLATE)
        print(f"[됨] {OUT_TEMPLATE.relative_to(ROOT)} — 본문 구역 {size}바이트로 비움")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
