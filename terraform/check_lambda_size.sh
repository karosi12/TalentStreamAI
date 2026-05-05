#!/bin/bash
set -euo pipefail

# Terraform external data source passes the query map as JSON on stdin (read once).
QUERY=$(cat)
FILE_PATH=$(printf '%s' "$QUERY" | python3 -c "import json,sys; print(json.load(sys.stdin)['file_path'])")

if [[ ! -f "$FILE_PATH" ]]; then
  echo "{\"error\": \"File not found: $FILE_PATH\"}" >&2
  exit 1
fi

SIZE_BYTES=$(stat -c%s "$FILE_PATH" 2>/dev/null || stat -f%z "$FILE_PATH")
SIZE_MB=$(echo "scale=2; $SIZE_BYTES / 1024 / 1024" | bc)

if (( $(echo "$SIZE_MB > 50" | bc -l) )); then
  echo "{\"use_s3\": \"true\", \"size_mb\": \"$SIZE_MB\"}"
else
  echo "{\"use_s3\": \"false\", \"size_mb\": \"$SIZE_MB\"}"
fi
