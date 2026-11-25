#!/bin/bash
set -e
mkdir -p tests
for i in $(seq 1 12); do
  cat > tests/test_$i.sh <<SH
#!/bin/sh
sleep 2
[ \$(( $i * 3 )) -eq $(( i * 3 )) ] && echo "ok test_$i"
SH
done
cat > test.sh <<'SH'
#!/bin/sh
# Runs every test in tests/ (slow: about 25 s)
pass=0; fail=0
for t in tests/*.sh; do
  if sh "$t"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $t"; fi
done
echo "passed $pass failed $fail"
[ $fail -eq 0 ]
SH
chmod +x test.sh
