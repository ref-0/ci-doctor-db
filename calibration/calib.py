"""Evaluate scoring configs against the trusted label sets. Run from ~/ref0-work/ci-score."""
import csv, sys, hashlib, os
sys.path.insert(0, os.path.dirname(__file__))
from sets import DISTRUST, FAILING
sys.argv = ['x', 'inbox/repos.csv', 'inbox/research.csv']  # run from ~/ref0-work/ci-score: python3 -I calibration/cands.py
src = open('calibrate.py').read().split("if __name__")[0]; ns = {}; exec(src, ns)
score, num = ns['score'], ns['num']
import glob, json
reports = []
for d in sorted(glob.glob('reports/*')):
    fs = sorted(glob.glob(f'{d}/*.json'))
    if fs:
        r = json.load(open(fs[-1]))
        if r.get('score') is not None: reports.append(r)
lab = {r['repo'].lower(): r for r in csv.DictReader(open('inbox/research.csv'))}

def trust(repo):
    l = lab.get(repo.lower())
    if not l or l['expected'] not in ('fast', 'slow'): return None
    if l['slice'] == 'well-run' or repo.lower() in DISTRUST or repo.lower() in FAILING: return None
    return l['expected']

def half(repo): return int(hashlib.sha1(repo.lower().encode()).hexdigest(), 16) % 2

GRADES = [(97,'S+'),(94,'A+'),(90,'A'),(85,'B+'),(75,'B'),(70,'C+'),(60,'C'),(57,'D+'),(50,'D')]
def grade(s): return next((g for f, g in GRADES if s >= f), 'F')
def band(s): return 'B+' if s >= 75 else ('C/D' if s >= 50 else 'F')

def evaluate(c, part=None):
    out = {'fast': [], 'slow': [], 'failing': [], 'wellrun': [], 'all': []}
    for r in reports:
        s = score(r, c)[0]; out['all'].append(s)
        k = r['repo'].lower()
        if part is not None and half(r['repo']) != part: continue
        t = trust(r['repo'])
        if t: out[t].append(s)
        if k in FAILING: out['failing'].append(s)
        l = lab.get(k)
        if l and l['slice'] == 'well-run' and l['expected'] == 'fast': out['wellrun'].append(s)
    f, sl = out['fast'], out['slow']
    m = {'n_fast': len(f), 'n_slow': len(sl), 'fast75': sum(x >= 75 for x in f) / max(len(f), 1), 'slow50': sum(x < 50 for x in sl) / max(len(sl), 1),
         'fast_bad': sum(x < 60 for x in f), 'slow_good': sum(x >= 75 for x in sl),
         'fast_med': sorted(f)[len(f)//2] if f else None, 'slow_med': sorted(sl)[len(sl)//2] if sl else None}
    allx = sorted(out['all']); q = lambda p: allx[min(len(allx)-1, int(p*len(allx)))]
    m['p10_50_90'] = (q(.1), q(.5), q(.9))
    m['bands'] = {b: sum(band(x) == b for x in allx) for b in ['B+', 'C/D', 'F']}
    m['failing_med'] = sorted(out['failing'])[len(out['failing'])//2] if out['failing'] else None
    m['wellrun_med'] = sorted(out['wellrun'])[len(out['wellrun'])//2] if out['wellrun'] else None
    return m

NAMED = ['honojs/hono', 'vitejs/vite', 'astral-sh/ruff', 'biomejs/biome', 'facebook/react', 'vercel/next.js', 'oxc-project/oxc', 'pingdotgg/t3code', 'microsoft/aspire']
def named(c):
    res = {}
    for n in NAMED:
        r = next((x for x in reports if x['repo'] == n), None)
        if r: s = score(r, c); res[n] = (s[0], *(round(v) if v is not None else None for v in s[1:]), round(num(r['wait']['p50']), 1))
    return res
