"""What the calibration run says: ranking, cross-checks, size fits, practices against outcomes, and
the fixes that come up most.

Usage: python3 analyze.py inbox/repos.csv inbox/research.csv
"""
import collections
import csv
import glob
import json
import math
import sys

listed = {}
for path in sys.argv[1:]:
    for r in csv.DictReader(open(path)):
        listed.setdefault(r['repo'].lower(), {**r, '_list': path.split('/')[-1]})

rows = []
for d in sorted(glob.glob('reports/*')):
    files = sorted(glob.glob(f'{d}/*.json'))
    if not files:
        continue
    r = json.load(open(files[-1]))
    l = listed.get(r['repo'].lower())
    if l:
        rows.append((r, l))


def num(x):
    try:
        x = float(x)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def med(xs):
    xs = sorted(x for x in xs if x is not None)
    return xs[len(xs) // 2] if xs else None


def fit(points):
    n = len(points)
    mx = sum(x for x, _ in points) / n
    my = sum(y for _, y in points) / n
    b = sum((x - mx) * (y - my) for x, y in points) / sum((x - mx) ** 2 for x, _ in points)
    a = my - b * mx
    r2 = 1 - sum((y - a - b * x) ** 2 for x, y in points) / sum((y - my) ** 2 for _, y in points)
    return a, b, r2


scored = [(r, l) for r, l in rows if r.get('score') is not None]
print(f'reports {len(rows)}, scored {len(scored)}, unscored {len(rows) - len(scored)}, no report {len(listed) - len(rows)}')
print('size classes', collections.Counter(r['size'] for r, _ in scored))
print('windows under 1 day', sum(1 for r, _ in scored if (r['window']['days'] or 0) < 1))

print('\n== ranking')
for r, l in sorted(scored, key=lambda x: -x[0]['score']):
    p = r['parts']
    print(f"{r['score']:>4} {p.get('speed')!s:>4} {p.get('reliability')!s:>4} {p.get('efficiency')!s:>4}  {r['repo'][:40]:40} {r['size']:>6} {r['profile']['linesOfCode']:>9} p50 {num(r['wait']['p50']) or 0:6.1f} p90 {num(r['wait']['p90']) or 0:6.1f}  {l.get('expected') or ''}")

print('\n== research labels against the score')
for label in ['fast', 'unknown', 'slow']:
    xs = [r for r, l in scored if l.get('expected') == label]
    if xs:
        print(f"{label:8} n={len(xs):3} median score {med([r['score'] for r in xs])}, speed {med([r['parts'].get('speed') for r in xs])}, p50 {med([num(r['wait']['p50']) for r in xs]):.1f}")

print('\n== our p50 against the list\'s main-workflow median')
pairs = [(num(r['wait']['p50']), num(l.get('median_pr_ci_min')), r['repo']) for r, l in scored]
pairs = [(a, b, n) for a, b, n in pairs if a and b]
ratios = sorted(a / b for a, b, _ in pairs)
print(f'n {len(ratios)}, ratio p25 {ratios[len(ratios) // 4]:.2f} p50 {ratios[len(ratios) // 2]:.2f} p75 {ratios[3 * len(ratios) // 4]:.2f}, within 0.5–2×: {sum(0.5 < x < 2 for x in ratios)}')
for a, b, n in pairs:
    if not 0.5 < a / b < 2:
        print(f'   {n}: ours {a:.1f}, list {b:.1f}')

print('\n== size fits (log–log)')
pts = [(math.log(r['profile']['linesOfCode']), math.log(num(r['wait']['p50']))) for r, _ in scored if r['profile']['linesOfCode'] > 1000 and num(r['wait']['p50'])]
a, b, r2 = fit(pts)
print(f'p50 wait ≈ {math.exp(a + b * math.log(1e5)):.1f} min × (lines/100k)^{b:.2f}  r² {r2:.2f} n {len(pts)}')
wait_fit = (a, b)
pts = [(math.log(r['profile']['linesOfCode']), math.log(num(r['efficiency']['jobMinutesPerMergedPr']))) for r, _ in scored
       if r['profile']['linesOfCode'] > 1000 and num(r['efficiency'].get('jobMinutesPerMergedPr'))]
a, b, r2 = fit(pts)
print(f'job-min per merged PR ≈ {math.exp(a + b * math.log(1e5)):.0f} × (lines/100k)^{b:.2f}  r² {r2:.2f} n {len(pts)}')
pts = [(math.log(max(r['headsPerWeek'], 1)), math.log(num(r['wait']['p50']))) for r, _ in scored if num(r['wait']['p50'])]
a, b, r2 = fit(pts)
print(f'p50 wait against PR pushes a week: exponent {b:.2f}  r² {r2:.2f}')

print('\n== practices against speed for size (p50 ÷ fitted expectation; lower is better)')
def ratio(r):
    p = num(r['wait']['p50'])
    lines = r['profile']['linesOfCode']
    return p / math.exp(wait_fit[0] + wait_fit[1] * math.log(lines)) if p and lines > 1000 else None
for key in ['cancelInProgress', 'pathFilters', 'affected', 'mergeQueue', 'remoteCache', 'depCache', 'compilerCache', 'shardsConfigured', 'scheduled', 'draftSkip', 'timeouts', 'fastLint', 'preCommit']:
    yes = [ratio(r) for r, _ in scored if r['practices'].get(key)]
    no = [ratio(r) for r, _ in scored if not r['practices'].get(key)]
    print(f"{key:18} with {len([x for x in yes if x]):3} median {med(yes) or 0:.2f}   without {len([x for x in no if x]):3} median {med(no) or 0:.2f}")
print('task runner', collections.Counter(r['practices'].get('taskRunner') or '-' for r, _ in scored).most_common())
print('providers', collections.Counter((r.get('jobs') or {}).get('providers', [['-']])[0][0] for r, _ in scored).most_common())
print('languages', collections.Counter((r['profile']['languages'] or [['-']])[0][0] for r, _ in scored).most_common(12))

print('\n== fixes, by how often they come up')
kinds = collections.Counter()
for r, _ in scored:
    for f in r['fixes']:
        kinds[f['guide'].split('/')[-1] + ' · ' + f['text'].split(':')[0][:60]] += 1
for k, n in kinds.most_common(25):
    print(f'{n:4}  {k}')

print('\n== distributions')
for name, get in [('p50 wait', lambda r: num(r['wait']['p50'])), ('p90/p50', lambda r: (num(r['wait']['p90']) or 0) / (num(r['wait']['p50']) or 1)),
                  ('green only on rerun', lambda r: num(r['wait']['passedOnRerunRate'])), ('main red', lambda r: num(r['main']['redRate'])),
                  ('queue p90 s', lambda r: num((r.get('jobs') or {}).get('queueP90Sec'))), ('setup share', lambda r: num((r.get('jobs') or {}).get('setupShare'))),
                  ('runs per merged PR', lambda r: num(r['profile'].get('runsPerMergedPr'))), ('job-min / merged PR', lambda r: num(r['efficiency'].get('jobMinutesPerMergedPr'))),
                  ('test share', lambda r: num(r['profile'].get('testShare')))]:
    xs = sorted(x for x in (get(r) for r, _ in scored) if x is not None)
    if xs:
        q = lambda p: xs[min(len(xs) - 1, int(p * len(xs)))]
        print(f'{name:20} n {len(xs):3}  p10 {q(.1):.2f}  p50 {q(.5):.2f}  p90 {q(.9):.2f}')
