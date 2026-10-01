#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""題庫品質檢查

檢查 data/src/*.txt 與產生的 data/*.json：
  - 必填欄位（漢字/句型、中文釋義）是否為空
  - 假名欄位是否只含平假名／片假名／長音／中黑點
  - 是否有重複條目（單字依 漢字+假名；文法依 句型）
  - 各 JSON 的 count 是否與 items 數一致、與 manifest 是否吻合
  - id 是否唯一、格式正確
  - 隨機抽樣列出 N 條供人工核對（--sample N）

用法：
    python scripts/check_data.py
    python scripts/check_data.py --sample 30
"""
import argparse
import json
import random
import re
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
LEVELS = ["N5", "N4", "N3", "N2", "N1"]
TRAVEL_CATS = ["phrases", "usage", "kanji"]

KANA_RE = re.compile(r"^[぀-ゟ゠-ヿー々・、。！？○〜\s]*$")
ID_RE = re.compile(r"^n[1-5]-[vg]-\d{4}$")
TV_ID_RE = re.compile(r"^tv-[puk]-\d{4}$")

problems = []
warnings = []


def err(msg):
    problems.append(msg)


def warn(msg):
    warnings.append(msg)


def load_set(fp):
    """讀一組題庫。缺檔、解析不了、0 筆都算問題（2026-09-24：以前缺檔是 continue、0 筆照樣通過，
    題庫檔不見或被清空時這支會說「全部檢查通過」）。回傳 None 表示這一組不能再往下查。"""
    rel = fp.relative_to(DATA).as_posix()
    if not fp.exists():
        err(f"缺檔：data/{rel}（檢查器讀不到這一組，不是 0 個問題）")
        return None
    try:
        d = json.loads(fp.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        err(f"解析不了：data/{rel}（{type(e).__name__}: {e}）")
        return None
    if not d.get("items"):
        err(f"data/{rel}: 0 筆——空的題庫不算通過")
    return d


def check_vocab(level, items):
    seen = {}
    for it in items:
        key = f"{level}/{it['id']}"
        if not ID_RE.match(it["id"]):
            err(f"{key}: id 格式錯誤")
        if not it.get("kanji"):
            err(f"{key}: 缺漢字/詞條")
        if not it.get("meaning"):
            err(f"{key}: 缺中文釋義 ({it.get('kanji')})")
        if not it.get("pos"):
            err(f"{key}: 缺詞性 ({it.get('kanji')})")
        kana = it.get("kana", "")
        if kana and not KANA_RE.match(kana):
            err(f"{key}: 假名欄含非假名字元「{kana}」")
        ex, exk = it.get("example", ""), it.get("exampleKana", "")
        if ex and not exk:
            err(f"{key}: 有例句但缺例句假名 ({it.get('kanji')})")
        dedupe = (it.get("kanji", ""), it.get("kana", ""))
        if dedupe in seen:
            err(f"{key}: 與 {seen[dedupe]} 重複條目 {dedupe}")
        else:
            seen[dedupe] = it["id"]


def check_grammar(level, items):
    seen = {}
    for it in items:
        key = f"{level}/{it['id']}"
        if not ID_RE.match(it["id"]):
            err(f"{key}: id 格式錯誤")
        if not it.get("pattern"):
            err(f"{key}: 缺句型")
        if not it.get("meaning"):
            err(f"{key}: 缺中文意思 ({it.get('pattern')})")
        if not it.get("example"):
            err(f"{key}: 缺例句 ({it.get('pattern')})")
        if it.get("example") and not it.get("exampleKana"):
            err(f"{key}: 有例句但缺例句假名 ({it.get('pattern')})")
        p = it.get("pattern", "")
        if p in seen:
            err(f"{key}: 與 {seen[p]} 重複句型「{p}」")
        else:
            seen[p] = it["id"]


def check_travel(cat, items):
    seen = {}
    for it in items:
        key = f"travel/{it['id']}"
        if not TV_ID_RE.match(it["id"]):
            err(f"{key}: id 格式錯誤")
        if cat == "kanji":
            if not it.get("kanji"):
                err(f"{key}: 缺漢字")
            if not it.get("jpMeaning"):
                err(f"{key}: 缺日文意思 ({it.get('kanji')})")
            if not it.get("zhMisread"):
                err(f"{key}: 缺『台灣人常誤解』 ({it.get('kanji')})")
            rd = it.get("reading", "")
            if rd and not KANA_RE.match(rd):
                err(f"{key}: 讀音含非假名「{rd}」")
            dedupe = it.get("kanji", "")
        else:
            if not it.get("jp"):
                err(f"{key}: 缺日文")
            if not it.get("zh"):
                err(f"{key}: 缺中文 ({it.get('jp')})")
            kn = it.get("kana", "")
            if kn and not KANA_RE.match(kn):
                err(f"{key}: 假名含非假名字元「{kn}」")
            dedupe = (it.get("jp", ""), it.get("zh", ""))
        if dedupe in seen:
            err(f"{key}: 與 {seen[dedupe]} 重複 {dedupe}")
        else:
            seen[dedupe] = it["id"]


# ---- 真實檔對照組（2026-10-02，Dispatch）：「全部檢查通過」只說明沒抓到東西，不說明在真實的題庫上抓得到。
# 每一組題庫讀進來之後，拿它自己的第一筆真實資料複製一份、改成一個已知的錯（id、去重的 key 也改掉，免得被重複檢查順便抓到），
# 接在那一組後面，走同一個 checker：新多出來的問題必須恰好一條、點名那筆 id、而且是預期的那一種。跑完把問題清單還原。
PROBE_SUFFIX = "〔探針〕"
CYR = "д"   # 西里爾字母，不是假名


def _probe_item(kind, it):
    p = dict(it)
    if kind == "vocab":
        p["id"], p["kana"] = it["id"][:5] + "9999", (it.get("kana") or "あ") + CYR
        return p, "假名欄含非假名字元"
    if kind == "grammar":
        p["id"], p["pattern"], p["meaning"] = it["id"][:5] + "9999", it["pattern"] + PROBE_SUFFIX, ""
        return p, "缺中文意思"
    if kind == "kanji":
        p["id"], p["kanji"], p["reading"] = it["id"][:5] + "9999", it["kanji"] + PROBE_SUFFIX, (it.get("reading") or "あ") + CYR
        return p, "讀音含非假名"
    p["id"], p["jp"], p["kana"] = it["id"][:5] + "9999", it["jp"] + PROBE_SUFFIX, (it.get("kana") or "あ") + CYR
    return p, "假名含非假名字元"


def real_file_probe(label, kind, items, run):
    """回傳 None＝抓到；否則回傳哪裡不符。run(items) 是正式檢查用的同一個 checker。"""
    if not items:
        return None   # 0 筆那一組 load_set 已經記成問題，這裡沒有真實資料可複製
    probe, want = _probe_item(kind, items[0])
    if any(x["id"] == probe["id"] for x in items):
        return f"{label}：探針的 id {probe['id']} 跟真實資料撞了"
    n = len(problems)
    run(items)                 # 基準：真實資料本身若有問題，這裡也會再報一次，下面扣掉
    base = problems[n:]
    del problems[n:]
    run(items + [probe])
    new = problems[n:]
    del problems[n:]
    for b in base:
        if b in new:
            new.remove(b)
    if len(new) != 1 or probe["id"] not in new[0] or want not in new[0]:
        return f"{label}：接上已知的錯（{probe['id']}，{want}）後多出的問題是 {new}，應該恰好一條、點名那一筆"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0, help="隨機抽樣列出 N 條")
    args = ap.parse_args()

    try:
        manifest = json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"檢查器讀不到 data/manifest.json（{type(e).__name__}: {e}）——不是「0 個問題」", file=sys.stderr)
        return 1
    man_counts = {(s["type"], s["level"]): s["count"] for s in manifest["sets"]}
    tv_counts = {s["cat"]: s["count"] for s in manifest.get("travel", {}).get("sets", [])}

    all_items = []
    grand = 0
    man_active = {}   # (typ, level) → 實際可練的筆數（扣掉跨級別重複）
    tried = {"vocab": 0, "grammar": 0, "travel": 0}     # 分類報數：每一類試著查了幾組（讀不到的也算，已另記問題）
    checked = {"vocab": [0, 0], "grammar": [0, 0], "travel": [0, 0]}   # 每一類真的查完的 [組數, 筆數]
    probe_bad, probed, load_failed = [], 0, 0   # load_failed：讀不到、已記成問題的組數
    for level in LEVELS:
        for typ, folder, checker in (
            ("vocab", "vocab", check_vocab),
            ("grammar", "grammar", check_grammar),
        ):
            fp = DATA / folder / f"{level.lower()}.json"
            tried[typ] += 1
            d = load_set(fp)
            if d is None:
                load_failed += 1
                continue
            items = d.get("items", [])
            if d.get("count") != len(items):
                err(f"{fp.name}: count={d.get('count')} 但 items={len(items)}")
            if man_counts.get((typ, level)) != len(items):
                err(f"manifest {typ} {level}: {man_counts.get((typ, level))} != {len(items)}")
            active = sum(1 for it in items if not it.get("dup"))
            if d.get("activeCount") != active:
                err(f"{fp.name}: activeCount={d.get('activeCount')} 但實際未隱藏 {active}")
            # 有筆數但全被標成跨級別重複＝App 那一組一張都沒有（2026-09-24 J13：以前照總筆數判、照樣通過）
            if items and active == 0:
                err(f"data/{folder}/{level.lower()}.json: 有效 0 筆（{len(items)} 筆全被標成跨級別重複）——App 這一組會一張都沒有")
            man_active[(typ, level)] = active
            for it in items:
                if it.get("dup") and not it.get("dupOf"):
                    err(f"{fp.name}: {it['id']} 標記 dup 但缺 dupOf")
            checker(level, items)
            checked[typ][0] += 1
            checked[typ][1] += len(items)
            m = real_file_probe(f"data/{folder}/{level.lower()}.json", typ, items, lambda xs, c=checker, lv=level: c(lv, xs))
            probed += 1 if items else 0
            if m:
                probe_bad.append(m)
            grand += len(items)
            for it in items:
                all_items.append((typ, level, it))

    # ---- 生活旅行 ----
    travel_grand = 0
    for cat in TRAVEL_CATS:
        fp = DATA / "travel" / f"{cat}.json"
        tried["travel"] += 1
        d = load_set(fp)
        if d is None:
            load_failed += 1
            continue
        items = d.get("items", [])
        if d.get("count") != len(items):
            err(f"travel/{cat}.json: count={d.get('count')} 但 items={len(items)}")
        if tv_counts.get(cat) != len(items):
            err(f"manifest travel {cat}: {tv_counts.get(cat)} != {len(items)}")
        check_travel(cat, items)
        checked["travel"][0] += 1
        checked["travel"][1] += len(items)
        m = real_file_probe(f"data/travel/{cat}.json", "kanji" if cat == "kanji" else "phrase", items,
                            lambda xs, c=cat: check_travel(c, xs))
        probed += 1 if items else 0
        if m:
            probe_bad.append(m)
        travel_grand += len(items)
        for it in items:
            all_items.append(("travel", cat, it))

    # 分類報數：每一類試了幾組、查完幾組幾筆；試的組數加總要等於登記的母體（程式裡的級別×類型＋旅行三類），
    # 也要等於 manifest 列的組數（另一個來源）——對不上就是有一組被默默跳過或多出來
    population = len(LEVELS) * 2 + len(TRAVEL_CATS)
    man_sets = len(manifest.get("sets", [])) + len(manifest.get("travel", {}).get("sets", []))
    names = {"vocab": "單字", "grammar": "文法", "travel": "生活旅行"}
    print("分類：" + "、".join(f"{names[t]} 試 {tried[t]} 組、查完 {checked[t][0]} 組 {checked[t][1]} 筆" for t in tried)
          + f"，合計試 {sum(tried.values())} 組／母體 {population}（manifest 列 {man_sets} 組）")
    n_checked = sum(c[0] for c in checked.values())
    if sum(tried.values()) != population or man_sets != population or n_checked + load_failed != population:
        err(f"分類加總：試了 {sum(tried.values())} 組、查完 {n_checked} 組＋讀不到 {load_failed} 組、manifest 列 {man_sets} 組，"
            f"母體應該是 {population} 組（有一組被默默跳過或多出來；檢查器壞了，不是 0 個問題）")
    print(f"真實檔對照組：{probed} 組各接一筆已知的錯，"
          + ("全部被點名" if not probe_bad else f"{len(probe_bad)} 組沒抓到"))
    for m in probe_bad:
        err(f"真實檔對照組不符：{m}（檢查器壞了，「全部通過」不可信）")

    # 全域 id 唯一
    ids = [it["id"] for _, _, it in all_items]
    if len(ids) != len(set(ids)):
        dups = {i for i in ids if ids.count(i) > 1}
        err(f"全域重複 id: {sorted(dups)}")

    # 同一單字／文法跨級別重複收錄（依 漢字+假名 / 句型）
    # 已在 data/src/dedup.txt 標記 dup 的（較高級別那筆）視為已處理，不再警告
    seen_vocab, seen_grammar = {}, {}
    for typ, level, it in all_items:
        if it.get("dup"):
            continue
        if typ == "vocab":
            k = (it.get("kanji", ""), it.get("kana", ""))
            if k in seen_vocab and seen_vocab[k][0] != level:
                warn(f"跨級別重複單字 {k[0]}（{k[1]}）: {seen_vocab[k][1]} 與 {level}/{it['id']}（可加進 dedup.txt）")
            seen_vocab.setdefault(k, (level, it["id"]))
        elif typ == "grammar":
            k = it.get("pattern", "")
            if k in seen_grammar and seen_grammar[k][0] != level:
                warn(f"跨級別重複文法「{k}」: {seen_grammar[k][1]} 與 {level}/{it['id']}")
            seen_grammar.setdefault(k, (level, it["id"]))

    print(f"總條目：{grand} + 生活旅行 {travel_grand} = {grand + travel_grand}"
          f"（manifest JLPT totalItems={manifest.get('totalItems')}，"
          f"travel total={manifest.get('travel', {}).get('total')}）")
    for level in LEVELS:
        # 印有效筆數（App 真的會出的題）；括號裡是含跨級別重複的總筆數。讀不到的那一組印「?」，不印 0
        def fmt(typ):
            a = man_active.get((typ, level))
            return "   ?" if a is None else f"{a:4d}（共 {man_counts.get((typ, level), 0)}）"
        print(f"  {level}: 單字 有效 {fmt('vocab')}  文法 有效 {fmt('grammar')}")
    for cat in TRAVEL_CATS:
        print(f"  travel {cat:8s}: {tv_counts.get(cat, 0):4d}")

    if warnings:
        print(f"\n⚠ {len(warnings)} 個警告（不影響結果碼）：")
        for w in warnings:
            print("  - " + w)

    if problems:
        print(f"\n發現 {len(problems)} 個問題：", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
    else:
        print("\n✓ 全部檢查通過" + (f"（另有 {len(warnings)} 個警告）" if warnings else ""))

    if args.sample:
        print(f"\n--- 隨機抽樣 {args.sample} 條（請人工核對假名與釋義）---")
        for typ, level, it in random.sample(all_items, min(args.sample, len(all_items))):
            if typ == "vocab":
                print(f"[{level}] {it['kanji']}（{it['kana']}）[{it['pos']}] = {it['meaning']}")
                if it.get("example"):
                    print(f"        例：{it['example']}　{it.get('exampleKana','')}　{it.get('exampleMeaning','')}")
            elif typ == "grammar":
                print(f"[{level}] {it['pattern']} = {it['meaning']}  〔{it.get('structure','')}〕")
                print(f"        例：{it['example']}　{it.get('exampleKana','')}　{it.get('exampleMeaning','')}")
            elif level == "kanji":
                print(f"[旅行/漢字] {it['kanji']}（{it.get('reading','')}）日文＝{it['jpMeaning']}｜常誤解＝{it.get('zhMisread','')}")
                if it.get("example"):
                    print(f"        例：{it['example']}　{it.get('exampleKana','')}　{it.get('exampleMeaning','')}")
            else:
                print(f"[旅行/{level}] {it.get('scene','')}｜{it['jp']}（{it.get('kana','')}）= {it['zh']}")
                if it.get("note"):
                    print(f"        備註：{it['note']}")

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
