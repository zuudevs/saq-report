import json, pandas as pd
from scipy.stats import wilcoxon
from pathlib import Path
SRC_DIR = Path(__file__).resolve().parents[2] / 'output' / 'benchmarks' / 'json-parser'
rows = [json.loads(l) for l in open(SRC_DIR / 'raw_benchmark_data.json', encoding='utf-8') if l.strip()]
data = []
for r in rows:
    e = {'workload': r['workload'], 'sha': r['payload_sha256'], 'seq': r['sequence']}
    for res in r['results']:
        e[res['name']] = res['sample']          # detik/op
    data.append(e)
df = pd.DataFrame(data)

per_req = df.assign(
    j=lambda d: d['JSON.parse'].apply(lambda s: pd.Series(s).median()),
    z=lambda d: d['ze_json'].apply(lambda s: pd.Series(s).median()),
)
for (workload, sha), g in per_req.groupby(['workload', 'sha']):
    if len(g) < 5:
        continue  # payload tanpa ulangan tidak diuji
    stat, p = wilcoxon(g['j'], g['z'])
    print(f'{workload:22} n_request={len(g):3}  '
          f'median JSON={g["j"].median()*1e6:9.2f} us/op  '
          f'ze={g["z"].median()*1e6:9.2f} us/op  p={p:.2e}')