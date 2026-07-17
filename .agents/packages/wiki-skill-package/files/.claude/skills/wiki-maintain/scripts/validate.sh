#!/usr/bin/env bash
# validate.sh — mechanical checks for the code wiki.
# Thin wrapper — delegates to validate.py for portability/speed on Git-Bash.
# Usage: bash validate.sh <wiki-dir>
# Exit 0 on pass (may print INFORMAL/THIN warnings), exit 1 on hard error.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/validate.py" "$@"
