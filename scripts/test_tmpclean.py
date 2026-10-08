"""scripts/lib/tmpclean.py 的驗法（2026-10-08）：刪不掉的暫存目錄必須被報出來，不能被吞掉。

  A 一般情況：目錄裡有唯讀檔 → 刪乾淨、回空清單
  B 還有程序握著：開一個子程序把目錄裡的檔開著不放（Windows 上開著的檔刪不掉）→ 必須回非空清單、點名那個檔、目錄還在；
    放掉之後再刪 → 回空清單、目錄不在（兩個方向）
  突變（暫存複本）：「回傳一律空清單」（等於 ignore_errors=True）→ B 必須紅、A 不紅
B 的前提（檔真的被握著）不成立時判「情境未成立」、回 4，不算通過：非 Windows 平台開著的檔照樣刪得掉。
用法：python scripts/test_tmpclean.py   回 0 全部符合；1 有不符；4 情境未成立。子程序同時最多 1 個，秒級。
"""
import importlib.util, io, os, stat, subprocess, sys, tempfile, time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'scripts', 'lib', 'tmpclean.py')
HOLD = 'import sys, time\nf = open(sys.argv[1], "a")\nprint("ready", flush=True)\ntime.sleep(60)\n'


class NotEstablished(Exception):
    pass


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def mkdir(base, tag):
    d = os.path.join(base, tag)
    os.makedirs(os.path.join(d, 'sub'))
    p = os.path.join(d, 'sub', 'held.txt')
    with open(p, 'w', encoding='utf-8') as fh:
        fh.write('x\n')
    os.chmod(p, stat.S_IREAD)
    return d, p


def cases(mod, base, tag):
    """回 {'A': 符合?, 'B': 符合?}"""
    res = {}
    d, _p = mkdir(base, f'{tag}-a')
    left = mod.rmtree_strict(d)
    res['A'] = left == [] and not os.path.exists(d)
    print(f'  [{"符合" if res["A"] else "不符"}] A 有唯讀檔 → 刪乾淨：留下 {left}、目錄還在 {os.path.exists(d)}')
    d, p = mkdir(base, f'{tag}-b')
    os.chmod(p, stat.S_IWRITE)
    hold = os.path.join(base, 'hold.py')
    with open(hold, 'w', encoding='utf-8') as fh:
        fh.write(HOLD)
    child = subprocess.Popen([sys.executable, hold, p], stdout=subprocess.PIPE)
    try:
        if child.stdout.readline().strip() != b'ready' or child.poll() is not None:
            raise NotEstablished('握檔的子程序沒起來')
        try:   # 前提：這個檔此刻真的刪不掉（不然 B 量不到東西）
            os.rename(p, p + '.probe')
            os.rename(p + '.probe', p)
            raise NotEstablished('開著的檔照樣能改名——這個平台握不住檔，B 的情境造不出來')
        except PermissionError:
            pass
        left = mod.rmtree_strict(d)
        named = any(os.path.normcase(p) in os.path.normcase(e) for e in left)
        held_ok = bool(left) and named and os.path.exists(d)
    finally:
        child.kill()
        child.wait(timeout=30)
    time.sleep(0.2)
    left2 = mod.rmtree_strict(d)
    res['B'] = held_ok and left2 == [] and not os.path.exists(d)
    print(f'  [{"符合" if res["B"] else "不符"}] B 程序握著 → 報出來、點名那個檔：留下 {len(left)} 處、點名 {named}；放掉後再刪：留下 {left2}、目錄還在 {os.path.exists(d)}')
    return res


def main():
    t0 = time.time()
    base = tempfile.mkdtemp(prefix=f'tmpclean-{os.getpid()}-{time.strftime("%Y%m%d%H%M%S")}-')
    orig = load(SRC, 'tmpclean_orig')
    ok = True
    try:
        print('原樣：')
        r = cases(orig, base, 'o')
        ok &= r == {'A': True, 'B': True}
        src = open(SRC, encoding='utf-8', newline='').read()
        a = "        return errs or [f'{d}（刪完還在，但沒有收到任何錯誤）']\n"
        if src.count(a) != 1:
            raise NotEstablished('突變的原文不是恰好一處')
        mp = os.path.join(base, 'm_swallow.py')
        with open(mp, 'w', encoding='utf-8', newline='') as fh:
            fh.write(src.replace(a, '        return []\n'))
        if '        return []\n' not in open(mp, encoding='utf-8').read():
            raise NotEstablished('突變沒寫進暫存複本')
        print('突變「回傳一律空清單」（等於 ignore_errors=True）：')
        r = cases(load(mp, 'tmpclean_m'), base, 'm')
        m_ok = r == {'A': True, 'B': False}
        ok &= m_ok
        print(f'[{"符合" if m_ok else "不符"}] 突變：紅 {[k for k, v in r.items() if not v] or "無"}（預期恰好 B）')
    except NotEstablished as e:
        print(f'⊘ 情境未成立：{e}（沒驗到，不是通過）')
        orig.rmtree_strict(base)
        return 4
    left = orig.rmtree_strict(base)
    if left:
        print(f'TEST-TMPCLEAN FAILED: 驗法自己的暫存目錄沒刪乾淨：{left}')
        return 1
    print(f'{"TEST-TMPCLEAN OK" if ok else "TEST-TMPCLEAN FAILED"}（{time.time() - t0:.1f} 秒）')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
