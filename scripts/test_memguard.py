"""scripts/memguard.py 的驗法（2026-10-08）。

  P1a～e 判斷「該不該停」的純函式：最近 3 次都低→停；中間有一次夠→不停；不到 3 次→不停；讀不到算低→停；一直夠→不停
  E1 從命令列入口跑（repo 裡那一支）：門檻 1 MB（永遠夠）→ 沒觸發、照傳指令的回傳值 3
  E2 門檻 10^9 MB（永遠低）、連續 3 次：被監看的指令開了一個孫程序 → 觸發、回 7、job 剩 0、孫程序也不在了、log 有前 10 名
  E3 設定值的對照組：同樣永遠低，但連續 10 次、指令 1.5 秒就結束 → 不觸發、回 0（改一個值、行為跟著變）
突變（暫存複本裡的 memguard.py／jobkill.py；每一條紅的集合必須恰好等於預期）：
  不看連續（只看最後一次）→ P1b；拿掉「不到 k 次就不停」→ P1c、E3；讀不到當成夠 → P1d；
  不主動 kill ＋ 拿掉 KILL_ON_JOB_CLOSE（兩道互為備援，單獨拿掉一道不會紅，見 lib/jobkill.py 檔頭）→ E2
用法：python scripts/test_memguard.py   回 0 全部符合；1 有不符。子程序同時最多 3 個（memguard、指令、孫程序），約 20 秒。
"""
import ctypes, importlib.util, io, os, shutil, subprocess, sys, tempfile, time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MG = os.path.join(ROOT, 'scripts', 'memguard.py')
JK = os.path.join(ROOT, 'scripts', 'lib', 'jobkill.py')
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'lib'))
from tmpclean import rmtree_strict  # noqa: E402

KID = '''import subprocess, sys, time
g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
open(sys.argv[1], 'w').write(f"{g.pid} {__import__('os').getpid()}\\n")
time.sleep(float(sys.argv[2])); sys.exit(int(sys.argv[3]))
'''


def alive(pid):
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    code = ctypes.c_ulong()
    ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(h)
    return bool(ok) and code.value == 259   # STILL_ACTIVE


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, os.path.dirname(path) + os.sep + 'lib')
    spec.loader.exec_module(mod)
    sys.path.pop(0)
    return mod


def run(mg, td, opts, sleep, code):
    kid = os.path.join(td, 'kid.py'); pidf = os.path.join(td, f'g{time.time_ns()}.pid')
    with open(kid, 'w', encoding='utf-8') as fh:
        fh.write(KID)
    outf = pidf + '.out'
    t0 = time.time()
    with open(outf, 'wb') as fh:   # 寫檔、不接管線：子孫沒被收掉時會握著管線，run 會一直等到它們睡完（2026-10-08 第一版就這樣多跑了 3 分鐘）
        r = subprocess.run([sys.executable, mg, *opts, '--', sys.executable, kid, pidf, str(sleep), str(code)], stdout=fh, stderr=subprocess.STDOUT, timeout=120)
    dt = time.time() - t0
    out = open(outf, encoding='utf-8', errors='replace').read()
    time.sleep(0.5)
    pids = [int(x) for x in open(pidf).read().split()] if os.path.exists(pidf) else []
    return r.returncode, out, pids, dt


def cases(mg_path, td, entry_mg):
    mod = load(mg_path, f'mg{time.time_ns()}')
    s = mod.should_stop
    res = {
        'P1a': s([3000, 1000, 1000, 1000], 2048, 3) is True,
        'P1b': s([1000, 1000, 3000, 1000], 2048, 3) is False,
        'P1c': s([1000, 1000], 2048, 3) is False,
        'P1d': s([None, None, None], 2048, 3) is True,
        'P1e': s([3000] * 5, 2048, 3) is False,
    }
    leftovers = []
    rc, out, pids, dt = run(entry_mg, td, ['--threshold-mb', '1', '--interval', '0.3', '--label', 'test-e1'], 1.5, 3)
    res['E1'] = rc == 3 and any(l.startswith('MEMGUARD: 指令結束 rc=3') and '沒有觸發' in l for l in out.splitlines())
    leftovers += pids
    rc, out, pids, dt = run(mg_path, td, ['--threshold-mb', '1000000000', '--interval', '0.3', '--consecutive', '3', '--label', 'test-e2'], 60, 0)
    lines = out.splitlines()
    res['E2'] = (rc == 7 and any(l.startswith('MEMGUARD TRIGGERED: 連續 3 次') for l in lines)
                 and 'MEMGUARD: job 裡剩 0 個程序（必須是 0）' in lines and sum(1 for l in lines if l.startswith('  ') and ' MB  ' in l) >= 1
                 and len(pids) == 2 and not any(alive(p) for p in pids) and dt < 30)
    e2_detail = f'rc={rc} 子孫 {pids} 還活著的 {[p for p in pids if alive(p)]} {dt:.1f} 秒'
    leftovers += pids
    # E3：設定值的對照組（跟 E2 只差 consecutive 3→10）；讀不到 10 次，所以也守「不到 k 次就不停」那一道
    rc, out, pids, dt = run(mg_path, td, ['--threshold-mb', '1000000000', '--interval', '0.3', '--consecutive', '10', '--label', 'test-e3'], 1.5, 0)
    res['E3'] = rc == 0 and not any(l.startswith('MEMGUARD TRIGGERED') for l in out.splitlines())
    leftovers += pids
    for p in leftovers:   # 突變留下的子孫：只收這一輪自己開、自己記下 PID 的（幾秒內建立，不會是重用的 PID）
        if alive(p):
            subprocess.run(['taskkill', '/pid', str(p), '/f'], capture_output=True)
    return res, e2_detail


MUTS = [   # (名稱, [(檔, 原文, 改成)], 預期紅)
    # 「不看連續」只有純函式分得出來：真的記憶體讀數不會照劇本忽高忽低（2026-10-08 第一版預期它也紅 E3，寫錯了——E3 讀不到 10 次）
    ('不看連續（只看最後一次）', [('memguard.py', 'for r in readings[-k:])', 'for r in readings[-1:])')], {'P1b'}),
    # 原文在執行時才組：寫成字面時「k、冒號、反斜線 n」會被公開前自查的路徑樣式當成磁碟代號（2026-10-08 被閘門擋下過）
    ('拿掉「不到 k 次就不停」', [('memguard.py', '    if len(readings) < k:' + chr(10) + '        return False' + chr(10), '')], {'P1c', 'E3'}),
    ('讀不到當成夠', [('memguard.py', 'r is None or r < threshold', 'r is not None and r < threshold')], {'P1d'}),
    ('不主動 kill＋拿掉 KILL_ON_JOB_CLOSE', [('memguard.py', 'left = job.kill(TRIGGERED_RC)', 'left = 0'),
                                          ('lib/jobkill.py', 'info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
                                           'info.BasicLimitInformation.LimitFlags = 0')], {'E2'}),
]


def copy_tree(td, tag):
    d = os.path.join(td, tag, 'scripts')
    os.makedirs(os.path.join(d, 'lib'))
    shutil.copy(MG, os.path.join(d, 'memguard.py')); shutil.copy(JK, os.path.join(d, 'lib', 'jobkill.py'))
    return d


def main():
    t0 = time.time()
    td = tempfile.mkdtemp(prefix=f'memguard-{os.getpid()}-{time.strftime("%Y%m%d%H%M%S")}-')
    ok = True
    try:
        d = copy_tree(td, 'orig')
        res, det = cases(os.path.join(d, 'memguard.py'), td, MG)
        for k, v in res.items():
            print(f'[{"符合" if v else "不符"}] {k}' + (f'（{det}）' if k == 'E2' else ''))
        ok &= all(res.values()) and len(res) == 8
        for i, (name, edits, want) in enumerate(MUTS):
            d = copy_tree(td, f'm{i}')
            for f, a, b in edits:
                p = os.path.join(d, f)
                s = open(p, encoding='utf-8', newline='').read()
                if s.count(a) != 1:
                    print(f'⊘ 情境未成立：突變「{name}」的原文在 {f} 出現 {s.count(a)} 次'); ok = False; break
                open(p, 'w', encoding='utf-8', newline='').write(s.replace(a, b))
                if b not in open(p, encoding='utf-8').read():
                    print(f'⊘ 情境未成立：突變「{name}」沒寫進 {f}'); ok = False; break
            else:
                res, det = cases(os.path.join(d, 'memguard.py'), td, os.path.join(d, 'memguard.py'))
                got = {k for k, v in res.items() if not v}
                ok &= got == want
                print(f'[{"符合" if got == want else "不符"}] 突變「{name}」：紅 {"、".join(sorted(got)) or "無"}（預期恰好 {"、".join(sorted(want))}）')
    finally:
        left = rmtree_strict(td)
    if left:
        print(f'TEST-MEMGUARD FAILED: 暫存目錄沒刪乾淨（{len(left)} 處）'); return 1
    print(f'{"TEST-MEMGUARD OK" if ok else "TEST-MEMGUARD FAILED"}（{time.time() - t0:.1f} 秒）')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
