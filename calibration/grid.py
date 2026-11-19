import sys, itertools, os
sys.path.insert(0, os.path.dirname(__file__))
from calib import *
B = ns['BASE']
P50 = {'base': B['p50'], 'steep': [[3,100],[5,90],[10,75],[15,60],[25,40],[60,10],[120,0]],
       'steeper': [[3,100],[5,90],[8,80],[12,65],[20,45],[45,15],[120,0]]}
P90 = {'base': B['p90'], 'steep': [[5,100],[8,90],[15,75],[22,60],[40,40],[90,10],[180,0]]}
SIZE = {'base': dict(exp_wait=(5, 0.5), exp_min=(60, 0.5)), 'fit': dict(exp_wait=(10.9, 0.23), exp_min=(155, 0.33))}
if __name__ == "__main__":
    rows = []
    for ws, wr, wt, wred, p50k, p90k, sz in itertools.product([50,55,60,65,70],[15,20,25,30],[15,10,5],[6,3,0],P50,P90,SIZE):
        we = 100 - ws - wr
        if we < 10: continue
        c = dict(B, w_speed=ws, w_rel=wr, w_eff=we, w_tail=wt, w_red=wred, p50=P50[p50k], p90=P90[p90k], **SIZE[sz])
        a = evaluate(c, part=0)
        obj = (a['fast75'] + a['slow50']) / 2 - 0.1 * (a['fast_bad'] + a['slow_good'])
        rows.append((obj, (ws, wr, we, wt, wred, p50k, p90k, sz), c, a))
    rows.sort(key=lambda x: -x[0])
    for obj, k, c, a in rows[:15]:
        b = evaluate(c, part=1); full = evaluate(c)
        print(f"{obj:.3f} {k}  A f75 {a['fast75']:.2f} s50 {a['slow50']:.2f} | B f75 {b['fast75']:.2f} s50 {b['slow50']:.2f} (n {b['n_fast']}/{b['n_slow']}) | all f75 {full['fast75']:.2f} s50 {full['slow50']:.2f} bands {full['bands']} p10/50/90 {full['p10_50_90']}")
