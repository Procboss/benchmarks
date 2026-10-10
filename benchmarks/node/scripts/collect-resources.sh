#!/usr/bin/env bash
# pboss-vs-pm2 Node benchmark — manual-use wrapper around collect-resources.mjs
# (the benchmark scripts call the .mjs directly; this exists so a human can
# grab the same numbers against any pid without remembering node flags).
#
#   ./collect-resources.sh sample --roots 1234 --interval 500 --duration 10
#   ./collect-resources.sh find --roots 1234 --match server.ts
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/collect-resources.mjs" "$@"
