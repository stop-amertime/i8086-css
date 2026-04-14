#!/bin/bash
# Quick boot test: build CSS and check for hearts
set -e
CALCITE="/c/Users/AdmT9N0CX01V65438A/Documents/src/calcite/target/release/calcite-cli.exe"
BOOTLE="/c/Users/AdmT9N0CX01V65438A/Documents/src/calcite/programs/bootle.com"
CSS="/tmp/v4-test.css"
TICKS="${1:-500000}"

echo "Building CSS..."
node --max-old-space-size=8192 transpiler/generate-dos.mjs "$BOOTLE" -o "$CSS" 2>&1

echo "Running calcite (${TICKS} ticks)..."
OUTPUT=$("$CALCITE" --input "$CSS" --ticks "$TICKS" --halt halt 2>&1)
if echo "$OUTPUT" | grep -q '♥'; then
  echo "PASS: Hearts detected — boot successful"
  exit 0
else
  echo "FAIL: No hearts detected"
  echo "$OUTPUT" | tail -20
  exit 1
fi
