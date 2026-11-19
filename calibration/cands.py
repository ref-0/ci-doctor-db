import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from calib import *
from grid import P50, P90, SIZE
B = ns['BASE']
def mk(ws, wr, wt, wred, p50k, p90k, sz, **kw):
    return dict(B, w_speed=ws, w_rel=wr, w_eff=100-ws-wr, w_tail=wt, w_red=wred, p50=P50[p50k], p90=P90[p90k], **SIZE[sz], **kw)
C = {
 'BASE': B,
 'C1 55/15/30 tail5 red3 fit': mk(55,15,5,3,'base','base','fit'),
 'C2 60/15/25 tail5 red0 fit': mk(60,15,5,0,'base','base','fit'),
 'C3 55/25/20 tail5 red0 fit': mk(55,25,5,0,'base','base','fit'),
 'C4 60/20/20 tail5 red0 fit steep': mk(60,20,5,0,'steep','steep','fit'),
 'C5 60/25/15 tail10 red0 fit': mk(60,25,10,0,'base','base','fit'),
}
if __name__ == '__main__':
    for name, c in C.items():
        e = evaluate(c); a = evaluate(c, 0); b = evaluate(c, 1)
        print(f"{name:34} fast≥75 {e['fast75']:.0%} (A {a['fast75']:.0%} B {b['fast75']:.0%})  slow<50 {e['slow50']:.0%} (A {a['slow50']:.0%} B {b['slow50']:.0%})  fast med {e['fast_med']} slow med {e['slow_med']} failing med {e['failing_med']} well-run med {e['wellrun_med']}  bands {e['bands']} p10/50/90 {e['p10_50_90']}")
        print('     ', '  '.join(f"{n.split('/')[1]} {v[0]}" for n, v in named(c).items()))
