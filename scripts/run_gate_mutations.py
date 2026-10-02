"""閘門突變的執行程式（共用慣例 v11.5 §5.18、§5.19、§5.20、§5.21；Dispatch 2026-10-02 排定的「29 條重跑」用這支）。

用法：python scripts/run_gate_mutations.py [--names a,b,…] [--timeout 900] [--max-tries 3] [--no-verify]
       （不給 --names：跑預期表裡「依據」是事前推論的那幾條——就是 2026-10-02 還沒重跑過的 29 條）
回傳值：0＝每一條都情境成立、證據檔寫好了；1＝開跑前的檢查沒過、或證據檔產生不出來；
        4＝重試到上限還有情境未成立的（行首「⊘ 情境未成立」逐條列出；證據檔照樣寫，那幾條記成情境未成立）。
重負載：單線、一次一條，每條約 4 分鐘；開跑前要 Dispatch 許可。

流程：
  1. 開跑前：主 repo 必須等於 HEAD（驗法只測已 commit 的版本）；預期表先核對一次（mkevidence --check-only），印量到的格數。
  2. 每一條：TEST_PUSHSAFE_MUTATE=<名稱> bash scripts/test_pushsafe.sh，外面包 reslog（逐一計數峰值）；完整輸出寫進
     .logs/<這一場>-a<第幾輪>.<名稱>.log；跑完立刻在 .logs/<這一場>-a<第幾輪>.summary 寫一行「名稱 rc=… 秒=…」（進度紀錄，
     跑的這一方寫的；log 裡的 MUTATION ACTIVE 是那一條自己寫的——兩個來源）。
     每一條放進一個 Windows Job Object（scripts/lib/jobkill.py）：之後開的所有子孫都屬於它——Git Bash 先 fork 再換程式，
     子孫的父 PID 接不起來，從根往下找會漏；單條逾時（--timeout）就結束整個 job、確認裡面活著的是 0，進度記 rc=124。
  3. 分類只看 log 的行首（mkevidence.classify）：情境未成立（ABORT、沒有 MUTATION ACTIVE、沒有結尾、逾時）的換下一輪重跑，
     最多 --max-tries 輪；都沒成立的行首「⊘ 情境未成立」。
  4. 交給 mkevidence 產生入庫的證據檔 docs/evidence/gate-mutations-<日期>-<commit>.tsv（帶預期表、清單、--claim-complete、
     每一輪的進度紀錄）。
  5. 突變那幾輪會刪掉主 repo 的驗法登記；最後正常跑一次閘門驗法把它補回來（--no-verify 可略過，推送前要自己跑）。
"""
import argparse
import datetime
import io
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import mkevidence_mut  # noqa: E402
import reslog  # noqa: E402
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'lib'))
import jobkill  # noqa: E402

ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
NOT_ESTABLISHED = '⊘ 情境未成立'


def git(*a):
    r = subprocess.run(['git', *a], cwd=ROOT, capture_output=True, env=ENV)
    return r.returncode, r.stdout.decode('utf-8', 'replace').strip()


def planned_from_expect(path):
    lines = [l for l in open(path, encoding='utf-8').read().splitlines() if l.strip() and not l.startswith('#')]
    head = lines[0].split('\t')
    return [l.split('\t')[0] for l in lines[1:] if l.split('\t')[len(head) - 1].startswith('讀程式推論')]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--names', help='逗號分隔；不給就跑預期表裡事前推論的那幾條')
    ap.add_argument('--timeout', type=float, default=900)
    ap.add_argument('--max-tries', type=int, default=3)
    ap.add_argument('--no-verify', action='store_true')
    ap.add_argument('--expect', default=os.path.join(ROOT, 'scripts', 'mutation-expect.tsv'))
    ap.add_argument('--verifier-cmd', default='bash scripts/test_pushsafe.sh', help='（測試用）被包住的驗法指令')
    ap.add_argument('--verifier-file', default=os.path.join(ROOT, 'scripts', 'test_pushsafe.sh'),
                    help='（測試用）mkevidence 核對預期表用的驗法檔')
    ap.add_argument('--evidence-dir', default=os.path.join(ROOT, 'docs', 'evidence'))
    ap.add_argument('--logdir', default=os.path.join(ROOT, '.logs'))
    a = ap.parse_args(argv)

    rc, st = git('status', '--porcelain')
    if rc != 0 or st:
        print(f'RUNNER ABORT: 主 repo 不等於 HEAD（{st[:200] or "git status 失敗"}）——驗法只測已 commit 的版本，先 commit')
        return 1
    _rc, head = git('rev-parse', '--short', 'HEAD')
    stamp = f'mut-{datetime.datetime.now().strftime("%Y%m%d-%H%M%S")}-{head}'
    os.makedirs(a.logdir, exist_ok=True)
    common = ['--expect', a.expect, '--verifier', a.verifier_file]
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'mkevidence_mut.py'), '--out', os.devnull, '--check-only', *common],
                       capture_output=True, env=ENV)
    out = r.stdout.decode('utf-8', 'replace')
    for l in out.splitlines():
        print('  ' + l)
    if r.returncode != 0 or not any(l.startswith('MKEVIDENCE EXPECT-CHECK: 預期表實際讀到') for l in out.splitlines()):
        print(f'RUNNER ABORT: 預期表核對沒過（rc={r.returncode}），不開跑')
        return 1
    names = [x for x in (a.names.split(',') if a.names else planned_from_expect(a.expect)) if x]
    if not names:
        print('RUNNER ABORT: 要跑的清單是空的')
        return 1
    planned = os.path.join(a.logdir, f'{stamp}.planned')
    open(planned, 'w', encoding='utf-8').write('\n'.join(names) + '\n')
    print(f'RUNNER: 這一場 {stamp}；清單 {len(names)} 條（{os.path.relpath(planned, ROOT)}）；單條逾時 {a.timeout:g} 秒、最多 {a.max_tries} 輪')

    logs, summaries, todo = [], [], list(names)
    for attempt in range(1, a.max_tries + 1):
        if not todo:
            break
        prefix = f'{stamp}-a{attempt}'
        summ = os.path.join(a.logdir, f'{prefix}.summary')
        summaries.append(summ)
        nxt = []
        for i, name in enumerate(todo, 1):
            lp = os.path.join(a.logdir, f'{prefix}.{name}.log')
            env = dict(ENV, TEST_PUSHSAFE_MUTATE=name)
            t0 = time.time()
            fh = open(lp, 'wb')
            job = jobkill.Job()   # 這一條開出來的所有子孫都在這個 job 裡（Git Bash 的父 PID 接不起來也管得到）
            p = subprocess.Popen([sys.executable, os.path.join(ROOT, 'scripts', 'reslog.py'), '--label', f'mut-{name}', '--estimate', '230',
                                  '--logdir', a.logdir, '--', *a.verifier_cmd.split()], cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, env=env)
            job.add(p)
            try:
                prc = p.wait(timeout=a.timeout)
            except subprocess.TimeoutExpired:
                left = job.kill(124)   # 刻意的冗餘：job.close() 時 KILL_ON_JOB_CLOSE 也會收（見 lib/jobkill.py 檔頭，單獨拿掉任一道不會紅）
                prc = 124
                fh.write(f'RUNNER: 逾時 {a.timeout:g} 秒，已結束整個 job（殺完還活著 {left} 個）\n'.encode('utf-8'))
                if left:
                    print(f'      ！{name} 逾時殺完 job 裡還有 {left} 個程序活著')
            _act, total = job.counts()
            job.close()
            fh.close()
            sec = int(time.time() - t0)
            with open(summ, 'a', encoding='utf-8') as sh:   # 進度紀錄：跑完一條立刻寫
                sh.write(f'{name} rc={prc} 秒={sec}\n')
            logs.append(lp)
            cls = mkevidence_mut.classify(open(lp, encoding='utf-8', errors='replace').read())[1]
            print(f'  第 {attempt} 輪 {i}/{len(todo)} {name}：{cls}（rc={prc}、{sec} 秒、這一條開過 {total} 個程序）', flush=True)
            if cls == '情境未成立':
                nxt.append(name)
        todo = nxt
    for n in todo:
        print(f'{NOT_ESTABLISHED}：{n} 重試 {a.max_tries} 輪都沒成立——這一條什麼都沒量到')

    os.makedirs(a.evidence_dir, exist_ok=True)
    ev = os.path.join(a.evidence_dir, f'gate-mutations-{datetime.date.today().isoformat()}-{head}.tsv')
    cmd = [sys.executable, os.path.join(ROOT, 'scripts', 'mkevidence_mut.py'), '--out', ev, *common, '--planned', planned, '--claim-complete']
    for s_ in summaries:
        cmd += ['--summary', s_]
    r = subprocess.run(cmd + logs, capture_output=True, env=ENV)
    out = r.stdout.decode('utf-8', 'replace')
    for l in out.splitlines():
        print('  ' + l)
    if r.returncode != 0:
        print(f'RUNNER FAILED: 證據檔產生不出來（mkevidence rc={r.returncode}）')
        return 1
    if not a.no_verify:
        print('RUNNER: 突變那幾輪刪掉了驗法登記，正常跑一次閘門驗法補回來')
        v = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'reslog.py'), '--label', 'test_pushsafe-after-mutations',
                            '--estimate', '360', '--logdir', a.logdir, '--', *a.verifier_cmd.split()], cwd=ROOT, capture_output=True, env=ENV)
        tail = [l for l in v.stdout.decode('utf-8', 'replace').splitlines() if l.startswith(('TEST-PUSHSAFE:', 'RESLOG:'))]
        for l in tail:
            print('  ' + l)
    print(f'RUNNER {"OK" if not todo else "NOT-ESTABLISHED"}: 證據檔 {os.path.relpath(ev, ROOT)}')
    return 0 if not todo else 4


if __name__ == '__main__':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.exit(main())
