#!/bin/bash
set -e
mkdir -p src tools
for i in $(seq 1 10); do
  python3 -c "import random; random.seed($i); print('\n'.join(' '.join(random.choice('abcdefgh') for _ in range(40)) for _ in range(200)))" > src/page$(printf %02d $i).txt
done
cat > tools/compile.py <<'PY'
import hashlib, sys, zlib
src, dst = sys.argv[1], sys.argv[2]
data = open(src, 'rb').read()
h = data
for _ in range(1800000):
    h = hashlib.sha256(h).digest()
open(dst, 'wb').write(h + zlib.compress(data, 9))
PY
cat > build.sh <<'SH'
#!/bin/sh
# Builds out/*.bin from src/*.txt
set -e
rm -rf out
mkdir -p out
for f in src/*.txt; do
  python3 tools/compile.py "$f" "out/$(basename "$f" .txt).bin"
done
echo "built $(ls out | wc -l) files"
SH
chmod +x build.sh
