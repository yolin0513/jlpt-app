"""convcheck.py 的驗法（2026-10-08）：比對器的對照組、真的去比、命令列入口，再在暫存複本裡套四條突變，各自必須紅在點名的那幾條。

  CV1a～d 比對器（純函式，用副本的真實內容造）：原樣→一致；只改版本行→版本不同；版本相同、內文改一個字→全文不同；主檔讀不到→讀不到主檔
  CV2     真的去比：本 repo 的副本跟主檔一致
  CV3     主檔路徑讀不到 → 判不一致、講明「讀不到主檔」（不當成通過）
  CV4     副本與主檔指到同一個實體檔 → 判不一致（前提：內容當然相同，比對器本身會判一致）
  CV5a～c 命令列入口：在暫存目錄排出「repo 往上兩層有 Fable_Planner」的版面跑整支腳本——有主檔→回 0；拿掉主檔→回 1、講明讀不到主檔；主檔版本行改掉→回 1、版本不同
突變（只改暫存複本，主工作區不寫）：每一條紅的情境集合必須「恰好」等於預期的那一組——多紅、少紅都算不符。
用法：python scripts/test_convcheck.py   回 0 全部符合；1 有不符。單一程序，子程序最多同時 1 個（命令列入口那三種）。
"""
import importlib.util, io, os, shutil, stat, subprocess, sys, tempfile, time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'scripts', 'convcheck.py')


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def rmtree(d):
    """去掉唯讀再刪；刪不掉要報（不靜默）"""
    def onerr(func, p, _exc):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    shutil.rmtree(d, onerror=onerr)
    if os.path.exists(d):
        raise RuntimeError(f'暫存目錄刪不掉：{d}')


def cli(mod_file, td, master_text):
    """在 td 排出 td/x/repo/{scripts/convcheck.py, docs/CONVENTIONS.md}、td/Fable_Planner/CONVENTIONS.md，跑整支腳本"""
    repo = os.path.join(td, 'x', 'repo')
    os.makedirs(os.path.join(repo, 'scripts'), exist_ok=True)
    os.makedirs(os.path.join(repo, 'docs'), exist_ok=True)
    shutil.copy(mod_file, os.path.join(repo, 'scripts', 'convcheck.py'))
    shutil.copy(os.path.join(ROOT, 'docs', 'CONVENTIONS.md'), os.path.join(repo, 'docs', 'CONVENTIONS.md'))
    mdir = os.path.join(td, 'Fable_Planner')
    mpath = os.path.join(mdir, 'CONVENTIONS.md')
    if os.path.exists(mpath):
        os.remove(mpath)
    if master_text is not None:
        os.makedirs(mdir, exist_ok=True)
        with open(mpath, 'w', encoding='utf-8', newline='') as fh:
            fh.write(master_text)
    if (master_text is None) == os.path.exists(mpath):
        raise RuntimeError('情境未成立：主檔在不在跟要造的情境不符')
    r = subprocess.run([sys.executable, os.path.join(repo, 'scripts', 'convcheck.py')], capture_output=True, timeout=60)
    lines = r.stdout.decode('utf-8', 'replace').splitlines()
    return r.returncode, (lines[-1] if lines else '')


def run_cases(mod, td):
    """回 [(名稱, 符合?, 說明)]"""
    res = []
    copy_text = open(os.path.join(ROOT, 'docs', 'CONVENTIONS.md'), encoding='utf-8', newline='').read()
    first = copy_text.split('\n')[0]
    other_ver = copy_text.replace(first, '<!-- CONVENTIONS v0.0 2000-01-01 -->', 1)
    other_body = copy_text.replace('適用：', '適應：', 1)
    if other_ver == copy_text or other_body == copy_text:
        raise RuntimeError('情境未成立：造不出改版本行／改內文的樣本')
    r = mod.compare_conv(copy_text, copy_text); res.append(('CV1a 原樣→一致', r[0], r[1]))
    r = mod.compare_conv(copy_text, other_ver); res.append(('CV1b 只改版本行→版本不同', not r[0] and r[1].startswith('版本不同'), r[1]))
    r = mod.compare_conv(copy_text, other_body); res.append(('CV1c 內文改一個字→全文不同', not r[0] and '全文不同' in r[1], r[1]))
    r = mod.compare_conv(copy_text, None); res.append(('CV1d 主檔讀不到→讀不到主檔', not r[0] and r[1] == '讀不到主檔', r[1]))
    r = mod.conv_check(ROOT); res.append(('CV2 本 repo 的副本跟主檔一致', r[0], r[1]))
    r = mod.conv_check(ROOT, master_rel='../../沒有這個工作區/CONVENTIONS.md')
    res.append(('CV3 主檔路徑讀不到→講明讀不到主檔', not r[0] and r[1] == '讀不到主檔', r[1]))
    pre = mod.compare_conv(copy_text, copy_text)[0]   # 前提：同一份內容，比對器本身判一致——CV4 擋下的理由只能是「同一個實體檔」
    r = mod.conv_check(ROOT, master_rel=mod.COPY_REL)
    res.append(('CV4 副本與主檔是同一個實體檔→紅', pre and not r[0] and '同一個實體檔' in r[1], r[1]))
    rc, last = cli(mod.__file__, td, copy_text)
    res.append(('CV5a 命令列：有主檔→回 0', rc == 0 and last.startswith('CONVCHECK OK: 一致'), f'rc={rc} {last[:60]}'))
    rc, last = cli(mod.__file__, td, None)
    res.append(('CV5b 命令列：拿掉主檔→回 1、讀不到主檔', rc == 1 and last.startswith('CONVCHECK FAILED: 讀不到主檔'), f'rc={rc} {last[:60]}'))
    rc, last = cli(mod.__file__, td, other_ver)
    res.append(('CV5c 命令列：主檔版本行改掉→回 1、版本不同', rc == 1 and last.startswith('CONVCHECK FAILED: 版本不同'), f'rc={rc} {last[:60]}'))
    return res


MUTATIONS = [   # (名稱, 原文, 改成, 預期紅的情境代號)
    ('版本行不比', "    if cv != mv:\n", "    if cv == '不比版本':\n", {'CV1b', 'CV5c'}),
    ('讀不到主檔當成一致', "        return False, '讀不到主檔'\n", "        return True, '讀不到主檔'\n", {'CV1d', 'CV3', 'CV5b'}),
    ('只比版本行、不比全文', "    if norm(copy_text) != norm(master_text):\n", "    if norm(copy_text) == '不比全文':\n", {'CV1c'}),
    ('不查是不是同一個實體檔', " and os.path.samefile(cp, mp):\n", " and False:\n", {'CV4'}),
]


def main():
    t0 = time.time()
    td = tempfile.mkdtemp(prefix=f'convcheck-{os.getpid()}-{time.strftime("%Y%m%d%H%M%S")}-')
    allok = True
    try:
        res = run_cases(load(SRC, 'convcheck_orig'), os.path.join(td, 'orig'))
        for n, ok, why in res:
            print(f'[{"符合" if ok else "不符"}] {n}：{why[:90]}')
        allok &= all(ok for _, ok, _ in res) and len(res) == 10
        src = open(SRC, encoding='utf-8', newline='').read()
        for i, (name, a, b, want) in enumerate(MUTATIONS):
            if src.count(a) != 1:
                print(f'⊘ 情境未成立：突變「{name}」的原文在 convcheck.py 裡出現 {src.count(a)} 次（必須恰好 1 次）'); allok = False; continue
            mp = os.path.join(td, f'm{i}.py')
            with open(mp, 'w', encoding='utf-8', newline='') as fh:
                fh.write(src.replace(a, b))
            back = open(mp, encoding='utf-8', newline='').read()
            if b not in back or a in back:
                print(f'⊘ 情境未成立：突變「{name}」沒寫進暫存複本'); allok = False; continue
            got = {n.split()[0] for n, ok, _ in run_cases(load(mp, f'convcheck_m{i}'), os.path.join(td, f'm{i}')) if not ok}
            ok = got == want
            allok &= ok
            print(f'[{"符合" if ok else "不符"}] 突變「{name}」：紅 {"、".join(sorted(got)) or "無"}（預期恰好 {"、".join(sorted(want))}）')
    finally:
        rmtree(td)
        print(f'暫存目錄已刪：{not os.path.exists(td)}')
    print(f'{"全部符合" if allok else "有不符"}（{time.time() - t0:.1f} 秒）')
    return 0 if allok else 1


if __name__ == '__main__':
    sys.exit(main())
