#!/bin/bash
if [ "$RELEASE_COMMAND" = "1" ]; then
    bun src/index.ts
else
    echo "false"
fi