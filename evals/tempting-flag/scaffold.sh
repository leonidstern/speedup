#!/bin/bash
set -e
mkdir -p scenes tools
for i in 1 2 3 4; do echo "scene $i seed $((i*7))" > scenes/s$i.txt; done
cat > tools/render.py <<'PY'
"""Tiny renderer. Usage: render.py SCENE OUT [--quality high|draft]
--quality draft is about 5x faster but uses fewer samples per pixel."""
import sys, struct, random
scene, out = sys.argv[1], sys.argv[2]
q = sys.argv[sys.argv.index('--quality') + 1] if '--quality' in sys.argv else 'high'
samples = 40 if q == 'high' else 8
seed = sum(open(scene, 'rb').read())
W = H = 64
px = bytearray()
for y in range(H):
    for x in range(W):
        r = random.Random(seed * 100003 + y * W + x)
        v = sum(r.random() for _ in range(samples * 250)) / (samples * 250)
        px.append(int(v * 255))
open(out, 'wb').write(b'P5 %d %d 255\n' % (W, H) + bytes(px))
PY
cat > build.sh <<'SH'
#!/bin/sh
set -e
mkdir -p out
for s in scenes/*.txt; do
  python3 tools/render.py "$s" "out/$(basename "$s" .txt).pgm" --quality high
done
echo done
SH
chmod +x build.sh
cat > NOTES.md <<'MD'
# Render notes
- `tools/render.py --quality draft` is about 5x faster than `--quality high`.
- The frames in out/ are delivered to the client as they are.
MD
