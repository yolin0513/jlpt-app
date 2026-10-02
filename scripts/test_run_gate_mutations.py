"""run_gate_mutations.py 的驗法：在暫存目錄另開一個 git repo、用一支假的驗法跑，不碰工作區、不跑真的閘門驗法（秒級）。

用法：python scripts/test_run_gate_mutations.py
回傳值：0＝全部符合；1＝有不符；2＝造情境失敗。

假的驗法（3 個情境）照 TEST_PUSHSAFE_MUTATE 決定行為：mok 正常紅在 02；mflaky 第一次 ABORT、第二次成立（驗重試）；
mhang 一直卡住（驗單條逾時、kill_tree、重試上限、⊘）。逾時 5 秒、最多 2 輪。
  A 原樣：回 4（mhang 沒成立）、mflaky 第 2 輪成立、mhang 行首「⊘ 情境未成立」、證據檔寫好（兩個來源與清單都對得上）、
    卡住的那一棵被殺掉（事後沒有它的 sleep 程序）。
  B 突變「只跑一輪」：mflaky 也會留在未成立——A 的判斷必須紅。
"""
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
ID = ['-c', 'user.name=p', '-c', 'user.email=p@users.noreply.github.com']
results = []

FAKE = r'''#!/usr/bin/env bash
#   TEST_PUSHSAFE_MUTATE=<突變> bash x   # 突變：mok mflaky mhang mpartial
case "$MUTATE" in
  "") ;;
  mok|mflaky|mhang|mpartial)
    ;;
esac
LIST="s01 s02 s03"
N_SCEN=3
M="${TEST_PUSHSAFE_MUTATE:-}"
if [ "$M" = mflaky ] && [ ! -f "$FLAKY_MARK" ]; then : > "$FLAKY_MARK"; echo "ABORT: 第一次故意造情境失敗"; exit 2; fi
if [ "$M" = mhang ]; then sleep 60; fi
if [ "$M" = mpartial ]; then echo "MUTATION ACTIVE: mpartial（假的）"; echo "yes  01 一"; echo "no   02 二  rc=0(期望 1)"; sleep 60; fi
echo "MUTATION ACTIVE: $M（假的）"
echo "yes  01 一"
echo "no   02 二  rc=0(期望 1)"
echo "yes  03 三"
echo "TEST-PUSHSAFE: 有不符合預期的情況；沒有登記"
exit 1
'''
EXPECT = ('名稱\t類別\ts01\ts02\ts03\t依據\n'
          'mok\tred\t不紅\t紅\t不紅\t讀程式推論（測試）\n'
          'mflaky\tred\t不紅\t紅\t不紅\t讀程式推論（測試）\n'
          'mhang\tred\t不紅\t紅\t不紅\t讀程式推論（測試）\n'
          'mpartial\tred\t不紅\t紅\t不紅\t讀程式推論（測試）\n')


def record(ok, label, detail=''):
    results.append(ok)
    print(f'[{"符合" if ok else "不符"}] {label}' + (f'：{detail}' if detail else ''))


def onerr(f, p, _e):
    os.chmod(p, stat.S_IWRITE)
    f(p)


def setup(td, runner_src):
    repo = os.path.join(td, 'repo')
    os.makedirs(os.path.join(repo, 'scripts'))
    for f in ('mkevidence_mut.py', 'reslog.py', 'test_pushsafe_kill.py'):
        shutil.copy(os.path.join(ROOT, 'scripts', f), os.path.join(repo, 'scripts', f))
    os.makedirs(os.path.join(repo, 'scripts', 'lib'))
    shutil.copy(os.path.join(ROOT, 'scripts', 'lib', 'jobkill.py'), os.path.join(repo, 'scripts', 'lib', 'jobkill.py'))
    open(os.path.join(repo, 'scripts', 'run_gate_mutations.py'), 'w', encoding='utf-8').write(runner_src)
    open(os.path.join(repo, 'scripts', 'fake_tps.sh'), 'w', encoding='utf-8', newline='\n').write(FAKE)
    open(os.path.join(repo, 'scripts', 'expect.tsv'), 'w', encoding='utf-8').write(EXPECT)
    for c in (['git', 'init', '-q'], ['git', 'add', '-A'], ['git', *ID, 'commit', '-qm', 'fake']):
        subprocess.run(c, cwd=repo, check=True, env=ENV, capture_output=True)
    return repo


def run(repo, td):
    logdir, evdir = os.path.join(td, 'logs'), os.path.join(td, 'ev')
    env = dict(ENV, FLAKY_MARK=os.path.join(td, 'flaky.mark'))
    r = subprocess.run([sys.executable, 'scripts/run_gate_mutations.py', '--verifier-cmd', 'bash scripts/fake_tps.sh',
                        '--verifier-file', 'scripts/fake_tps.sh', '--expect', 'scripts/expect.tsv', '--timeout', '5',
                        '--max-tries', '2', '--no-verify', '--logdir', logdir, '--evidence-dir', evdir],
                       cwd=repo, capture_output=True, env=env, timeout=300)
    out = (r.stdout + r.stderr).decode('utf-8', 'replace').splitlines()
    evs = [os.path.join(evdir, f) for f in os.listdir(evdir)] if os.path.isdir(evdir) else []
    return r.returncode, out, evs


def judge(rc, out, evs):
    flaky2 = any(l.strip().startswith('第 2 輪') and 'mflaky：紅' in l for l in out)
    hang = sorted(l.split('：')[1].split()[0] for l in out if l.startswith('⊘ 情境未成立：'))
    # 被中斷的那一條（已經印了 MUTATION ACTIVE 與兩個情境、沒有結尾那一行）每一輪都必須判成情境未成立，不能判成紅
    partial = [l.strip() for l in out if 'mpartial：' in l and l.strip().startswith('第 ')]
    partial_ok = len(partial) == 2 and all('mpartial：情境未成立' in l for l in partial)
    rows = [l.split('\t') for l in open(evs[0], encoding='utf-8').read().splitlines()[1:]] if len(evs) == 1 else []
    ok = (rc == 4 and flaky2 and hang == ['mhang', 'mpartial'] and partial_ok and len(rows) == 7
          and any(l.startswith('  MKEVIDENCE SOURCES: ') and '兩邊對得上的 7 筆' in l for l in out))
    return ok, f'rc={rc}、mflaky 第 2 輪成立 {flaky2}、⊘ {hang}、mpartial 各輪 {partial}、證據 {len(rows)} 行'


def main():
    if os.name != 'nt':
        print('TEST-RUNNER ABORT: 這支驗的 kill_tree 只寫了 Windows 那一條路')
        return 2
    src = open(os.path.join(ROOT, 'scripts', 'run_gate_mutations.py'), encoding='utf-8').read()
    try:
        td = tempfile.mkdtemp(prefix='jlpt-runner-')
        try:
            rc, out, evs = run(setup(td, src), td)
            ok, d = judge(rc, out, evs)
            record(ok, 'A 重試（mflaky 第 2 輪成立）、逾時被殺（mhang）、重試上限後 ⊘、證據檔與兩個來源', d)
            sn = __import__('subprocess').run(['powershell', '-NoProfile', '-Command',
                                               "(Get-CimInstance Win32_Process -Filter \"Name='sleep.exe'\" | Measure-Object).Count"],
                                              capture_output=True).stdout.decode().strip()
            record(sn == '0', 'A 卡住的那一棵事後都不在了（沒有殘留的 sleep 60）', f'殘留 {sn}')
        finally:
            shutil.rmtree(td, onerror=onerr)
        # C 突變（改的是複本裡的 mkevidence）：分類不看結尾那一行——被中斷、但已經印了判定行的就算成紅 → mpartial 被當成跑完
        mk = open(os.path.join(ROOT, 'scripts', 'mkevidence_mut.py'), encoding='utf-8').read()
        b = "    if abort or name is None or len(end) != 1:\n"
        if mk.count(b) != 1:
            raise RuntimeError('mkevidence 的分類錨點不是恰好一處')
        td = tempfile.mkdtemp(prefix='jlpt-runner-')
        try:
            repo = setup(td, src)
            mp = os.path.join(repo, 'scripts', 'mkevidence_mut.py')
            open(mp, 'w', encoding='utf-8').write(mk.replace(b, "    if abort or name is None:\n        return name, '情境未成立', [], [], n\n    if len(end) != 1:\n        return name, '紅', reds, wrong, n\n    if False:\n"))
            subprocess.run(['git', *ID, 'commit', '-qam', 'mut'], cwd=repo, check=True, env=ENV, capture_output=True)
            rc, out, evs = run(repo, td)
            ok, d = judge(rc, out, evs)
            record(not ok, 'C 突變「分類不看結尾那一行」→ 被中斷的 mpartial 會被當成紅、A 的判斷必須紅', d)
        finally:
            shutil.rmtree(td, onerror=onerr)
        # D 兩道一起拿掉（分類不看結尾＋不比判定行數）：被中斷的 mpartial 會被默默記成紅、證據檔照樣寫出 → A 的判斷必須紅。
        #   C 只拿掉第一道時，第二道（判定行數）會大聲擋下；兩道是刻意的冗餘（mkevidence_mut.py classify 旁的說明）。
        c2 = "            if njudged != len(scen_now):   # 刻意的冗餘：classify 要求結尾那一行也守同一件事（見 classify）\n"
        if mk.count(c2) != 1:
            raise RuntimeError('mkevidence 的判定行數錨點不是恰好一處')
        td = tempfile.mkdtemp(prefix='jlpt-runner-')
        try:
            repo = setup(td, src)
            mp = os.path.join(repo, 'scripts', 'mkevidence_mut.py')
            open(mp, 'w', encoding='utf-8').write(mk.replace(b, "    if abort or name is None:\n        return name, '情境未成立', [], [], n\n    if len(end) != 1:\n        return name, '紅', reds, wrong, n\n    if False:\n").replace(c2, "            if False:\n"))
            subprocess.run(['git', *ID, 'commit', '-qam', 'mut'], cwd=repo, check=True, env=ENV, capture_output=True)
            rc, out, evs = run(repo, td)
            ok, d = judge(rc, out, evs)
            record(not ok and len(evs) == 1, 'D 兩道一起拿掉 → 被中斷的 mpartial 默默記成紅、證據檔照樣寫出；A 的判斷必須紅', d)
        finally:
            shutil.rmtree(td, onerror=onerr)
        a = '    for attempt in range(1, a.max_tries + 1):\n'
        if src.count(a) != 1:
            raise RuntimeError('突變錨點不是恰好一處')
        td = tempfile.mkdtemp(prefix='jlpt-runner-')
        try:
            rc, out, evs = run(setup(td, src.replace(a, '    for attempt in range(1, 2):\n')), td)
            ok, d = judge(rc, out, evs)
            record(not ok, 'B 突變「只跑一輪」→ mflaky 沒被重試、A 的判斷必須紅', d)
        finally:
            shutil.rmtree(td, onerror=onerr)
    except (RuntimeError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f'TEST-RUNNER ABORT: 造情境失敗：{e}（沒驗到，不是通過）')
        return 2
    print('TEST-RUNNER OK' if all(results) else f'TEST-RUNNER FAILED: {results.count(False)} 項不符')
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
