"""Turn GuitarSet's per-string note annotations into analysis windows.

Two kinds, because they answer two different questions:

  comp  — a strum, fenced between its onset and the next strum. This is the
          app's actual use case: fence one sustained chord, hit Analyze.
  solo  — a single note with nothing else sounding across it. This is the
          user's complaint stated as a measurement: play one note, how often
          do you get exactly one note back?

Ground truth for a window is the set of rounded MIDI pitches that genuinely
sound across it, not everything that was ever struck nearby.
"""
import zipfile, json, sys, collections, random

DATA = sys.argv[1]
ANN = zipfile.ZipFile(DATA + '/annotation.zip')

STRUM_CLUSTER = 0.080   # onsets this close are one strum
SKIP_TRANSIENT = 0.060  # let the pick noise pass before fencing
MAX_WIN = 1.20
MIN_COMP_WIN = 0.40
SUSTAIN_FRAC = 0.70     # a note must sound through this much of the window
MIN_SOLO_DUR = 0.35
MIN_SOLO_WIN = 0.30

def notes_of(jams):
    out = []
    for a in jams['annotations']:
        if a['namespace'] != 'note_midi':
            continue
        for e in a['data']:
            if e['duration'] and e['duration'] > 0:
                out.append((e['time'], e['duration'], e['value']))
    out.sort()
    return out

def chord_at(jams, t):
    for a in jams['annotations']:
        if a['namespace'] == 'chord':
            for e in a['data']:
                if e['time'] <= t < e['time'] + e['duration']:
                    return e['value']
    return None

def comp_windows(name, jams):
    ns = notes_of(jams)
    if not ns:
        return []
    # cluster onsets into strums
    strums, cur = [], [ns[0]]
    for n in ns[1:]:
        if n[0] - cur[0][0] <= STRUM_CLUSTER:
            cur.append(n)
        else:
            strums.append(cur); cur = [n]
    strums.append(cur)

    out = []
    for k, s in enumerate(strums):
        t0 = min(n[0] for n in s)
        nxt = min(n[0] for n in strums[k+1]) if k+1 < len(strums) else t0 + 99
        start = t0 + SKIP_TRANSIENT
        end = min(nxt - 0.02, start + MAX_WIN)
        if end - start < MIN_COMP_WIN:
            continue
        need = start + SUSTAIN_FRAC * (end - start)
        truth = sorted({round(v) for (t, d, v) in s if t + d >= need})
        if len(truth) < 3:
            continue
        out.append(dict(file=name, kind='comp', start=round(start, 4),
                        dur=round(end - start, 4), truth=truth,
                        chord=chord_at(jams, t0)))
    return out

def solo_windows(name, jams):
    ns = notes_of(jams)
    out = []
    for i, (t, d, v) in enumerate(ns):
        if d < MIN_SOLO_DUR:
            continue
        # nothing else may overlap this note at all
        if any(j != i and tt < t + d and tt + dd > t for j, (tt, dd, vv) in enumerate(ns)):
            continue
        start = t + 0.04
        end = t + min(d, 0.90)
        if end - start < MIN_SOLO_WIN:
            continue
        out.append(dict(file=name, kind='solo', start=round(start, 4),
                        dur=round(end - start, 4), truth=[round(v)],
                        chord=None))
    return out

allw = []
for fn in sorted(ANN.namelist()):
    if not fn.endswith('.jams'):
        continue
    j = json.loads(ANN.read(fn))
    base = fn.replace('.jams', '')
    allw += comp_windows(base, j) if '_comp' in fn else solo_windows(base, j)

# balance: cap per source file so no one player or tempo dominates
random.seed(7)
by = collections.defaultdict(list)
for w in allw:
    by[(w['file'], w['kind'])].append(w)
sel = []
for key, ws in by.items():
    random.shuffle(ws)
    sel += ws[:6]
random.shuffle(sel)

comp = [w for w in sel if w['kind'] == 'comp']
solo = [w for w in sel if w['kind'] == 'solo']
print(f'candidates: {len(allw)}  selected: {len(sel)}  (comp {len(comp)}, solo {len(solo)})')
print('comp notes/window:', round(sum(len(w["truth"]) for w in comp) / max(1, len(comp)), 2))
json.dump(sel, open(DATA + '/windows.json', 'w'))
print('wrote windows.json')
