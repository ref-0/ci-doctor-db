"""Re-score every stored report under a scoring config, without API calls, and check it against the
targets: repos labelled fast land at 75+, slow under 50, and the scale reads sensibly.

Mirrors scoreOf in score.ts; once a config is chosen, port its numbers there.
Usage: python3 calibrate.py inbox/repos.csv inbox/research.csv
"""
import csv
import glob
import json
import math
import sys

labels = {}
for path in sys.argv[1:]:
    for r in csv.DictReader(open(path)):
        labels[r['repo'].lower()] = r.get('expected') or ''

reports = []
for d in sorted(glob.glob('reports/*')):
    files = sorted(glob.glob(f'{d}/*.json'))
    if files:
        r = json.load(open(files[-1]))
        if r.get('score') is not None and r['repo'].lower() in labels:
            reports.append(r)


def num(x):
    try:
        x = float(x)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def anchored(x, anchors):
    if x is None:
        return None
    if x <= anchors[0][0]:
        return anchors[0][1]
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * math.log(x / x0) / math.log(x1 / x0)
    return anchors[-1][1]


def lin(x, good, bad):
    return None if x is None else 100 * min(1, max(0, 1 - (x - good) / (bad - good)))


def logs(x, good, bad):
    # As score.ts's logScore: unknown stays unknown, and 0 counts as tiny (full marks).
    return None if x is None else 100 * min(1, max(0, 1 - (math.log(max(x, 1e-9)) - math.log(good)) / (math.log(bad) - math.log(good))))


def weigh(pairs):
    known = [(w, s) for w, s in pairs if s is not None]
    total = sum(w for w, _ in known)
    return sum(w * s for w, s in known) / total if total else None


def score(r, c):
    p50, p90 = num(r['wait']['p50']), num(r['wait']['p90'])
    lines = max(r['profile']['linesOfCode'], 1)
    jobs = r.get('jobs') or {}
    exp_wait = max(c.get('wait_floor', 2), c['exp_wait'][0] * (lines / 1e5) ** c['exp_wait'][1])
    exp_min = max(c.get('min_floor', 10), c['exp_min'][0] * (lines / 1e5) ** c['exp_min'][1])
    mpp = num(r['efficiency'].get('jobMinutesPerMergedPr'))
    speed = weigh([(c['w_wait'], anchored(p50, c['p50'])), (c['w_size'], logs(p50 / exp_wait if p50 is not None else None, 0.5, 2.5)), (c['w_tail'], anchored(p90, c['p90']))])
    rel = weigh([(c.get('w_flake', 14), lin(num(r['wait']['passedOnRerunRate']), 0.01, c['flake_bad'])), (c.get('w_main', 10), lin(num(r['main']['redRate']), 0.05, c.get('main_bad', 0.4))), (c.get('w_red', 6), lin(num(r['wait']['redRate']), 0.1, 0.5))])
    eff = weigh([(6, logs(mpp / exp_min if mpp is not None else None, 0.5, 4)), (4, logs(num(r['profile'].get('runsPerMergedPr')), 5, 60)), (4, lin(num(jobs.get('setupShare')), 0.2, 0.7)),
                 (3, logs(max(num(jobs.get('queueP90Sec')) or 1, 1) if jobs else None, 10, 300)), (3, lin(num((jobs.get('shard') or {}).get('idleTail')), 0.1, 0.4))])
    return round(weigh([(c['w_speed'], speed), (c['w_rel'], rel), (c['w_eff'], eff)])), speed, rel, eff


def med(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def report(name, c, show=False):
    s = {r['repo']: score(r, c) for r in reports}
    by = {k: [s[r['repo']][0] for r in reports if labels[r['repo'].lower()] == k] for k in ['fast', 'unknown', 'slow', '']}
    allx = sorted(v[0] for v in s.values())
    q = lambda p: allx[min(len(allx) - 1, int(p * len(allx)))]
    grades = {g: sum(1 for x in allx if lo <= x < hi) for g, lo, hi in [('A', 90, 101), ('B', 75, 90), ('C', 60, 75), ('D', 50, 60), ('F', 0, 50)]}
    fast_ok = sum(1 for x in by['fast'] if x >= 75) / max(len(by['fast']), 1)
    slow_ok = sum(1 for x in by['slow'] if x < 50) / max(len(by['slow']), 1)
    print(f"{name:28} fast med {med(by['fast'])} (≥75: {fast_ok:.0%})  slow med {med(by['slow'])} (<50: {slow_ok:.0%})  list med {med(by[''])}  all p10/50/90 {q(.1)}/{q(.5)}/{q(.9)}  grades {grades}")
    if show:
        for repo in ['honojs/hono', 'vitejs/vite', 'astral-sh/ruff', 'biomejs/biome', 'facebook/react', 'vercel/next.js', 'rust-lang/rust', 'apache/airflow',
                     'openclaw/openclaw', 'paperclipai/paperclip', 'pingdotgg/t3code', 'microsoft/playwright', 'vitest-dev/vitest', 'astral-sh/uv', 'oxc-project/oxc']:
            if repo in s:
                r = next(x for x in reports if x['repo'] == repo)
                print(f"   {repo:28} {s[repo][0]:>3}  speed {round(s[repo][1] or 0):>3} rel {round(s[repo][2] or 0):>3} eff {round(s[repo][3] or 0):>3}  p50 {num(r['wait']['p50']) or 0:5.1f}  {labels[repo.lower()]}")
    return s


BASE = dict(w_speed=50, w_rel=30, w_eff=20, w_wait=20, w_size=15, w_tail=15, flake_bad=0.12,
            p50=[[3, 100], [5, 90], [10, 75], [20, 55], [40, 30], [90, 10], [180, 0]],
            p90=[[5, 100], [8, 90], [15, 75], [30, 55], [60, 30], [120, 10], [240, 0]],
            exp_wait=(5, 0.5), exp_min=(60, 0.5))

# Chosen 19 Nov (calibration.md): speed first, red PR heads dropped, a light tail, the size curve fitted to the data, steeper wait anchors.
CALIBRATED = dict(BASE, w_speed=60, w_rel=20, w_eff=20, w_wait=20, w_size=15, w_tail=5, w_red=0,
                  p50=[[3, 100], [5, 90], [8, 80], [12, 65], [20, 45], [45, 15], [120, 0]],
                  p90=[[5, 100], [8, 90], [15, 75], [22, 60], [40, 40], [90, 10], [180, 0]],
                  exp_wait=(10.9, 0.23), exp_min=(155, 0.33))

if __name__ == '__main__':
    print(f'{len(reports)} scored reports\n')
    report('anchors, guessed size curve', BASE, show=True)
    report('calibrated', CALIBRATED, show=True)
