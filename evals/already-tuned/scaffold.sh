#!/bin/bash
set -e
mkdir -p data tools
python3 -c "
import random; random.seed(1)
open('data/items.csv','w').write('id,price\n' + ''.join(f'{i},{random.randint(1,999)}\n' for i in range(5000)))"
cat > tools/pack.py <<'PY'
import csv, json
rows = list(csv.DictReader(open('data/items.csv')))
json.dump({'count': len(rows), 'total': sum(int(r['price']) for r in rows)}, open('out.json', 'w'))
PY
cat > build.sh <<'SH'
#!/bin/sh
set -e
python3 tools/pack.py
echo ok
SH
chmod +x build.sh
