#!/bin/bash
if [ "$RELEASE_COMMAND" = "1" ]; then
    echo "false"
else
    bun src/index.ts
fi