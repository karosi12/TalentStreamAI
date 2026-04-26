#!/bin/bash

# Check if lambda-deployment.zip exists and get its size
FILE_PATH="../backend/lambda-deployment.zip"

if [[ ! -f "$FILE_PATH" ]]; then
  echo '{"error": "File not found: '$FILE_PATH'"}'
  exit 1
fi

# Get file size in bytes
SIZE_BYTES=$(stat -c%s "$FILE_PATH" 2>/dev/null || stat -f%z "$FILE_PATH")

# Convert to MB
SIZE_MB=$(echo "scale=2; $SIZE_BYTES / 1024 / 1024" | bc)

# Check if over 50 MB
if (( $(echo "$SIZE_MB > 50" | bc -l) )); then
  echo '{"use_s3": "true", "size_mb": "'$SIZE_MB'"}'
else
  echo '{"use_s3": "false", "size_mb": "'$SIZE_MB'"}'
fi