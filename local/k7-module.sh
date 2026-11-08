#!/bin/sh
# Minimal fallback shim for guest-direct invocation; primary execution is TypeScript `/__k7/rpc`.
if [ -s /tmp/.lothost/.k7-report.txt ]; then
  exec cat /tmp/.lothost/.k7-report.txt
fi
MOD="$(printf '%s' "${1:-hub}" | tr -cd 'A-Za-z0-9_-' | cut -c1-32)"
PROJ="$(printf '%s' "${2:-w0m}" | tr -cd 'A-Za-z0-9_-' | cut -c1-32)"
ENV="$(printf '%s' "${3:-beta}" | tr -cd 'A-Za-z0-9_-' | cut -c1-32)"
printf '\033[1;36m[@k7 TabLinux Fallback] module=%s project=%s env=%s\033[0m\n' "$MOD" "$PROJ" "$ENV"
