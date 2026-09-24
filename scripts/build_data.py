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
import hashlib
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
SEARCH_INDEX = ROOT / "data" / "search-index.json"

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


# ---- 假名 → 羅馬字（Hepburn 式，供搜尋比對用）----
_ROMAJI_2 = {
    "きゃ": "kya", "きゅ": "kyu", "きょ": "kyo", "しゃ": "sha", "しゅ": "shu", "しょ": "sho",
    "ちゃ": "cha", "ちゅ": "chu", "ちょ": "cho", "にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
    "ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo", "みゃ": "mya", "みゅ": "myu", "みょ": "myo",
    "りゃ": "rya", "りゅ": "ryu", "りょ": "ryo", "ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
    "じゃ": "ja", "じゅ": "ju", "じょ": "jo", "ぢゃ": "ja", "ぢゅ": "ju", "ぢょ": "jo",
    "びゃ": "bya", "びゅ": "byu", "びょ": "byo", "ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
    "ふぁ": "fa", "ふぃ": "fi", "ふぇ": "fe", "ふぉ": "fo", "ゔぁ": "va", "ゔぃ": "vi",
    "ゔぇ": "ve", "ゔぉ": "vo", "てぃ": "ti", "でぃ": "di", "とぅ": "tu", "どぅ": "du",
    "しぇ": "she", "ちぇ": "che", "じぇ": "je", "うぃ": "wi", "うぇ": "we", "うぉ": "wo",
}
_ROMAJI_1 = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "ゐ": "i", "ゑ": "e", "を": "o", "ん": "n",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ゔ": "vu",
    "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o",
    "ゃ": "ya", "ゅ": "yu", "ょ": "yo", "ゎ": "wa",
}


def _kata_to_hira(s: str) -> str:
    return "".join(
        chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c
        for c in s
    )


def to_romaji(kana: str) -> str:
    """把假名讀音轉成羅馬字（僅供搜尋比對，長音以重複母音表示）。"""
    if not kana:
        return ""
    s = _kata_to_hira(kana)
    out = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "っ":  # 促音：重複下一個子音
            nxt = s[i + 1:i + 3]
            r = _ROMAJI_2.get(nxt) or _ROMAJI_1.get(s[i + 1] if i + 1 < len(s) else "", "")
            if r and r[0].isalpha():
                out.append("tch" if r.startswith("ch") else r[0])
            i += 1
            continue
        if ch in ("ー", "ー"):  # 長音：重複前一個母音
            if out and out[-1] and out[-1][-1] in "aiueo":
                out.append(out[-1][-1])
            i += 1
            continue
        two = s[i:i + 2]
        if two in _ROMAJI_2:
            out.append(_ROMAJI_2[two])
            i += 2
            continue
        if ch in _ROMAJI_1:
            out.append(_ROMAJI_1[ch])
            i += 1
            continue
        i += 1  # 標點等直接略過
    return "".join(out)


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
            "romaji": to_romaji(field(cols, 1)),  # 自動產生，供搜尋比對
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
    travel_items = {cat_key: build_travel(cat_key, id_abbr) for cat_key, id_abbr, _l, _i in TRAVEL_CATS}

    # 寫任何檔之前：每一組都要有來源檔、而且至少一筆有效資料。缺一組就全部不寫、回非 0。
    # 以前空的那一組會被默默跳過（不寫檔也不報錯），舊的輸出檔留在原地、manifest 卻少了那一組——
    # App 讀得到、看起來是好的。現在失敗時 data/ 維持上一次成功建置的完整狀態（2026-09-24）。
    empty = []
    for level in LEVELS:
        for typ in ("vocab", "grammar"):
            if not by_set.get((typ, level)):
                src = SRC / f"{typ}.{level.lower()}.txt"
                empty.append(f"{src.name}（{'來源檔不存在' if not src.exists() else '沒有任何有效資料列'}）")
    for cat_key, _abbr, _label, _icon in TRAVEL_CATS:
        if not travel_items[cat_key]:
            src = SRC / f"travel.{cat_key}.txt"
            empty.append(f"{src.name}（{'來源檔不存在' if not src.exists() else '沒有任何有效資料列'}）")
    if empty:
        raise SystemExit("建置中止，一個檔都沒寫（data/ 維持上一次成功建置的狀態）：以下來源是空的或不存在——\n  "
                         + "\n  ".join(empty))

    hidden = apply_dedup(by_set)

    # 去重之後每一組還要至少一筆有效資料（2026-09-24 J13：上面那道是在去重「之前」算的，
    # dedup.txt 一條寫太寬的規則就能把一整組都標成重複，App 那一組會一張都沒有）。一樣在寫任何檔之前擋。
    all_dup = []
    for level in LEVELS:
        for typ in ("vocab", "grammar"):
            items = by_set[(typ, level)]
            if not any(not it.get("dup") for it in items):
                all_dup.append(f"{typ} {level}（{len(items)} 筆全被 dedup.txt 標成跨級別重複，有效 0 筆）")
    if all_dup:
        raise SystemExit("建置中止，一個檔都沒寫（data/ 維持上一次成功建置的狀態）：去重之後以下各組沒有任何有效資料——\n  "
                         + "\n  ".join(all_dup))

    for level in LEVELS:
        for typ, folder in (("vocab", VOCAB_OUT), ("grammar", GRAMMAR_OUT)):
            items = by_set[(typ, level)]   # 上面已確認每一組都有資料
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
    # 被隱藏的 id 清單（很小，27 筆左右）：前端統計要用它排除
    # 「舊版本曾練過、現在已隱藏」的進度紀錄，否則掌握度會超過分母。
    dup_ids = sorted(it["id"] for items in by_set.values() for it in items if it.get("dup"))
    print(f"  跨級別重複隱藏共 {hidden} 筆")

    # ---- 生活旅行 ----
    travel_sets = []
    travel_total = 0
    for cat_key, id_abbr, label, icon in TRAVEL_CATS:
        items = travel_items[cat_key]
        out = TRAVEL_OUT / f"{cat_key}.json"
        out.write_text(json.dumps(
            {"cat": cat_key, "label": label, "count": len(items), "items": items},
            ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
        travel_sets.append({
            "cat": cat_key, "label": label, "icon": icon,
            "file": f"travel/{cat_key}.json", "count": len(items),
        })
        travel_total += len(items)
        print(f"  travel  {cat_key:8s}: {len(items):4d} 條 -> {out.relative_to(ROOT)}")

    # ---- 精簡搜尋索引 ----
    # 搜尋只需要比對／顯示「詞本身」，例句三欄佔了題庫 57% 的體積。
    # 拆出一份不含例句的索引，搜尋頁改載這一份（877KB → ~200KB），
    # 例句等完整內容再由 findItem() 惰性補上（見 js/views/search.js）。
    EXAMPLE_FIELDS = ("example", "exampleKana", "exampleMeaning")
    search_vocab, search_grammar, search_travel = [], [], []
    for (typ, level), items in by_set.items():
        bucket = search_vocab if typ == "vocab" else search_grammar
        for it in items:
            if it.get("dup"):
                continue  # 跨級別重複不進搜尋結果
            slim = {k: v for k, v in it.items()
                    if k not in EXAMPLE_FIELDS and k not in ("dup", "dupOf") and v != ""}
            slim["level"] = level
            bucket.append(slim)
    for cat_key, _abbr, _label, _icon in TRAVEL_CATS:
        for it in travel_items[cat_key]:
            slim = {k: v for k, v in it.items() if k not in EXAMPLE_FIELDS and v != ""}
            search_travel.append(slim)
    search_vocab.sort(key=lambda x: x["id"])
    search_grammar.sort(key=lambda x: x["id"])
    SEARCH_INDEX.write_text(json.dumps(
        {"vocab": search_vocab, "grammar": search_grammar, "travel": search_travel},
        ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n")
    idx_kb = SEARCH_INDEX.stat().st_size / 1024
    print(f"  搜尋索引: {len(search_vocab) + len(search_grammar) + len(search_travel):4d} 條 "
          f"-> {SEARCH_INDEX.relative_to(ROOT)} ({idx_kb:.0f} KB)")

    # 題庫內容雜湊：只要任何題庫檔有變就會改變。
    # Service Worker 用它判斷要不要清掉舊的題庫快取重抓，
    # 不必再依賴人工 bump sw.js 的 VERSION。
    hasher = hashlib.sha1()
    for f in sorted([*VOCAB_OUT.glob("*.json"), *GRAMMAR_OUT.glob("*.json"),
                     *TRAVEL_OUT.glob("*.json"), SEARCH_INDEX]):
        hasher.update(f.read_bytes())
    data_version = hasher.hexdigest()[:12]

    manifest = {
        "app": "JLPT 練習",
        "generated": True,
        "dataVersion": data_version,
        "levels": LEVELS,
        "types": [{"key": "vocab", "label": "單字"}, {"key": "grammar", "label": "文法"}],
        "totalItems": total,
        "activeItems": active_total,
        "dupIds": dup_ids,
        "sets": sets,
        "travel": {"total": travel_total, "sets": travel_sets},
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    print(f"\n完成：JLPT {total} 條（可練 {active_total}）+ 生活旅行 {travel_total} 條 = {total + travel_total} 條，"
          f"寫入 {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
