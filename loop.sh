#!/bin/bash

cd "$(dirname "$0")"

TASK_NUM=0

while true; do
    TASK_NUM=$((TASK_NUM + 1))
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    OUTPUT_FILE="/tmp/${PWD##*/}-loop-${TIMESTAMP}-${TASK_NUM}.txt"

    echo "=== Starting task ${TASK_NUM} ==="

    cat prompt.md | claude -p \
        --dangerously-skip-permissions \
        --output-format=stream-json \
        --verbose \
        | tee "$OUTPUT_FILE"

    # Check for LOOP_COMPLETE (all remaining items are blocked/future)
    if grep -q 'LOOP_COMPLETE: true' "$OUTPUT_FILE"; then
        echo "=== All tasks complete (nothing left to implement) ==="
        exit 0
    fi

    # Check for rate limit error
    if grep -q '"error":"rate_limit"' "$OUTPUT_FILE"; then
        echo "=== API rate limit reached ==="
        exit 1
    fi

    # Check for API errors (500, api_error, etc.)
    if grep -q 'API Error: 5[0-9][0-9]' "$OUTPUT_FILE" || grep -q '"type":"api_error"' "$OUTPUT_FILE"; then
        echo "=== API error detected (likely transient 500 error) ==="
        echo "Check $OUTPUT_FILE for details"
        exit 1
    fi

    echo "=== Task ${TASK_NUM} complete, sleeping 2s ==="
    sleep 2
done
