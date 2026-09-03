#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
題庫建置腳本
------------
從 data/src/*.txt（人類易編輯的 pipe 分隔格式）產生：
    data/vocab/*.json、data/grammar/*.json、data/travel/*.json、data/manifest.json

用法：
    python scripts/build_data.py

--- JLPT ---
單字來源檔  data/src/vocab.<level>.txt，每行：
    漢字 | 假名 | 中文釋義 | 詞性 | 例句(可空) | 例句假名(可空) | 例句中譯(可空)
文法來源檔  data/src/grammar.<level>.txt，每行：
    句型 | 讀音(可空) | 中文意思 | 接續結構 | 例句 | 例句假名 | 例句中譯

--- 生活旅行（與 JLPT 平行的分類）---
data/src/travel.phrases.txt（情境會話），每行：
    場景 | 日文 | 假名 | 中文 | 備註(可空)
data/src/travel.usage.txt（日本人這樣說：課本 vs 現實、店員固定句），每行：
    場景 | 日文 | 假名 | 中文 | 你可以這樣說／說明(可空)
data/src/travel.kanji.txt（中日漢字大不同），每行：
    漢字 | 日文讀音 | 日文意思 | 台灣人常誤解 | 例句 | 例句假名 | 例句中譯

規則：
    - 以 # 開頭或空白行會被忽略
    - 欄位以「|」或「｜」分隔，前後空白會被去除
    - id 依行序自動產生（vocab: n5-v-0001；grammar: n5-g-0001；travel: tv-p-0001 / tv-u-0001 / tv-k-0001）
    - 重新執行會覆蓋輸出，id 依當前檔案順序重新編號 → 新增請往檔案末端加
"""
import json
import re
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "src"
VOCAB_OUT = ROOT / "data" / "vocab"
GRAMMAR_OUT = ROOT / "data" / "grammar"
TRAVEL_OUT = ROOT / "data" / "travel"
MANIFEST = ROOT / "data" / "manifest.json"

LEVELS = ["N5", "N4", "N3", "N2", "N1"]
SPLIT_RE = re.compile(r"\s*[|｜]\s*")

# 生活旅行分類： (檔名鍵, id 縮寫, 顯示名稱, icon)
TRAVEL_CATS = [
    ("phrases", "p", "情境會話", "💬"),
    ("usage", "u", "日本人這樣說", "🗣️"),
    ("kanji", "k", "中日漢字大不同", "🀄"),
]


def parse_lines(path: Path):
    if not path.exists():
        return []
    rows = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        rows.append([c.strip() for c in SPLIT_RE.split(line)])
    return rows


def field(cols, i):
    return cols[i] if i < len(cols) and cols[i] != "" else ""


def looks_bad(cols):
    """基本清洗：欄位含西里爾字母（產檔雜訊）視為壞行。"""
    return any(re.search(r"[Ѐ-ӿ]", c) for c in cols)


def build_vocab(level: str):
    rows = parse_lines(SRC / f"vocab.{level.lower()}.txt")
    items = []
    n = 0
    for cols in rows:
        if len(cols) < 3 or looks_bad(cols) or not field(cols, 0) or not field(cols, 2):
            print(f"  ! 略過格式不足的行 (vocab {level}): {cols}", file=sys.stderr)
            continue
        n += 1
        items.append({
            "id": f"{level.lower()}-v-{n:04d}",
            "kanji": field(cols, 0),
            "kana": field(cols, 1),
            "meaning": field(cols, 2),
            "pos": field(cols, 3),
            "example": field(cols, 4),
            "exampleKana": field(cols, 5),
            "exampleMeaning": field(cols, 6),
        })
    return items


def build_grammar(level: str):
    rows = parse_lines(SRC / f"grammar.{level.lower()}.txt")
    items = []
    n = 0
    for cols in rows:
        if len(cols) < 3 or looks_bad(cols) or not field(cols, 0) or not field(cols, 2):
            print(f"  ! 略過格式不足的行 (grammar {level}): {cols}", file=sys.stderr)
            continue
        n += 1
        items.append({
            "id": f"{level.lower()}-g-{n:04d}",
            "pattern": field(cols, 0),
            "reading": field(cols, 1),
            "meaning": field(cols, 2),
            "structure": field(cols, 3),
            "example": field(cols, 4),
            "exampleKana": field(cols, 5),
            "exampleMeaning": field(cols, 6),
        })
    return items


def build_travel(cat_key: str, id_abbr: str):
    rows = parse_lines(SRC / f"travel.{cat_key}.txt")
    items = []
    n = 0
    for cols in rows:
        if len(cols) < 3 or looks_bad(cols):
            print(f"  ! 略過格式不足的行 (travel {cat_key}): {cols}", file=sys.stderr)
            continue
        if cat_key in ("phrases", "usage"):
            scene, jp, kana, zh = field(cols, 0), field(cols, 1), field(cols, 2), field(cols, 3)
            if not jp or not zh:
                print(f"  ! 略過缺日文/中文的行 (travel {cat_key}): {cols}", file=sys.stderr)
                continue
            n += 1
            items.append({
                "id": f"tv-{id_abbr}-{n:04d}",
                "cat": cat_key,
                "scene": scene,
                "jp": jp, "kana": kana, "zh": zh,
                "note": field(cols, 4),
            })
        else:  # kanji
            kanji, reading, jp_mean, misread = (
                field(cols, 0), field(cols, 1), field(cols, 2), field(cols, 3))
            if not kanji or not jp_mean:
                print(f"  ! 略過缺漢字/日文意思的行 (travel kanji): {cols}", file=sys.stderr)
                continue
            n += 1
            items.append({
                "id": f"tv-{id_abbr}-{n:04d}",
                "cat": cat_key,
                "kanji": kanji,
                "reading": reading,
                "jpMeaning": jp_mean,
                "zhMisread": misread,
                "example": field(cols, 4),
                "exampleKana": field(cols, 5),
                "exampleMeaning": field(cols, 6),
            })
    return items


def _content_key(it, typ):
    """跨級別去重用的內容鍵（不含級別）。"""
    if typ == "vocab":
        return ("v", it.get("kanji", ""), it.get("kana", ""))
    return ("g", it.get("pattern", ""), "")


def apply_dedup(by_set):
    """讀 data/src/dedup.txt，把「較高級別」的重複條目標成 dup=true / dupOf=<保留 id>。

    by_set: {(typ, level): [items]}  會就地修改
    每條規則都必須：(1) 在指定級別恰好命中一筆；(2) 在某個較低級別找得到同內容的「保留」筆。
    否則丟出例外，避免規則失效卻靜默隱藏。
    """
    rules = parse_lines(SRC / "dedup.txt")
    hidden = 0
    for cols in rules:
        lv = field(cols, 0).upper()
        kind = field(cols, 1)          # v / g
        key1 = field(cols, 2)          # 漢字 / 句型
        key2 = field(cols, 3)          # 假名（文法留空）
        typ = "vocab" if kind == "v" else "grammar"
        if lv not in LEVELS:
            raise SystemExit(f"dedup.txt: 未知級別 {lv} — {cols}")
        want = ("v" if typ == "vocab" else "g", key1, key2)

        matches = [it for it in by_set.get((typ, lv), [])
                   if _content_key(it, typ) == want]
        if len(matches) != 1:
            raise SystemExit(
                f"dedup.txt 規則命中 {len(matches)} 筆（應為 1）：{lv} {kind} {key1} {key2}")

        # 找較低級別的「保留」筆
        kept = None
        for lower in LEVELS[:LEVELS.index(lv)]:
            for it in by_set.get((typ, lower), []):
                if _content_key(it, typ) == want:
                    kept = it
                    break
            if kept:
                break
        if not kept:
            raise SystemExit(
                f"dedup.txt: {lv} {key1} 找不到較低級別的保留筆，規則無效")

        matches[0]["dup"] = True
        matches[0]["dupOf"] = kept["id"]
        hidden += 1
    return hidden


def main():
    VOCAB_OUT.mkdir(parents=True, exist_ok=True)
    GRAMMAR_OUT.mkdir(parents=True, exist_ok=True)
    TRAVEL_OUT.mkdir(parents=True, exist_ok=True)
    sets = []
    total = 0
    active_total = 0

    # 先全部建好，再套跨級別去重標記
    by_set = {}
    for level in LEVELS:
        v, g = build_vocab(level), build_grammar(level)
        if v:
            by_set[("vocab", level)] = v
        if g:
            by_set[("grammar", level)] = g

    hidden = apply_dedup(by_set)

    for level in LEVELS:
        for typ, folder in (("vocab", VOCAB_OUT), ("grammar", GRAMMAR_OUT)):
            items = by_set.get((typ, level))
            if not items:
                continue
            active = sum(1 for it in items if not it.get("dup"))
            out = folder / f"{level.lower()}.json"
            out.write_text(json.dumps(
                {"level": level, "type": typ, "count": len(items),
                 "activeCount": active, "items": items},
                ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
            sets.append({"type": typ, "level": level,
                         "file": f"{typ}/{level.lower()}.json",
                         "count": len(items), "activeCount": active})
            total += len(items)
            active_total += active
            tag = f"（其中 {len(items) - active} 筆跨級別重複已隱藏）" if active != len(items) else ""
            print(f"  {typ:7s} {level}: {len(items):4d} 條 -> {out.relative_to(ROOT)} {tag}")

    sets.sort(key=lambda s: (s["type"], LEVELS.index(s["level"])))
    print(f"  跨級別重複隱藏共 {hidden} 筆")

    # ---- 生活旅行 ----
    travel_sets = []
    travel_total = 0
    for cat_key, id_abbr, label, icon in TRAVEL_CATS:
        items = build_travel(cat_key, id_abbr)
        if not items:
            continue
        out = TRAVEL_OUT / f"{cat_key}.json"
        out.write_text(json.dumps(
            {"cat": cat_key, "label": label, "count": len(items), "items": items},
            ensure_ascii=False, indent=1), encoding="utf-8")
        travel_sets.append({
            "cat": cat_key, "label": label, "icon": icon,
            "file": f"travel/{cat_key}.json", "count": len(items),
        })
        travel_total += len(items)
        print(f"  travel  {cat_key:8s}: {len(items):4d} 條 -> {out.relative_to(ROOT)}")

    manifest = {
        "app": "JLPT 練習",
        "generated": True,
        "levels": LEVELS,
        "types": [{"key": "vocab", "label": "單字"}, {"key": "grammar", "label": "文法"}],
        "totalItems": total,
        "activeItems": active_total,
        "sets": sets,
        "travel": {"total": travel_total, "sets": travel_sets},
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    print(f"\n完成：JLPT {total} 條（可練 {active_total}）+ 生活旅行 {travel_total} 條 = {total + travel_total} 條，"
          f"寫入 {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
