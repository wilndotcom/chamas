#!/bin/sh
# Looks for anything secret that is about to be published.
#
# Run before a first push. Once a secret is in git history it stays there, and
# deleting it afterwards does not remove it from anyone's clone - so this is the
# one check that is worth being slow about.
#
# Usage: sh deploy/scan-for-secrets.sh

cd "$(dirname "$0")/.." || exit 1

echo "=== files git is about to publish ==="
git ls-files | wc -l | sed 's/^/  tracked files: /'

echo ""
echo "=== .env files ==="
found=$(git ls-files | grep -E '(^|/)\.env' || true)
if [ -n "$found" ]; then
  echo "  PROBLEM - these are tracked and would be published:"
  echo "$found" | sed 's/^/    /'
else
  echo "  none tracked - good"
fi

echo ""
echo "=== real Daraja credentials ==="
found=$(git grep -n -I -E 'GQVN[A-Za-z0-9]{10,}' -- . 2>/dev/null || true)
if [ -n "$found" ]; then
  echo "  PROBLEM - a consumer key is committed:"
  echo "$found" | head -5 | sed 's/^/    /'
else
  echo "  none found - good"
fi

echo ""
echo "=== 64-character hex blobs (JWT secrets, API keys) ==="
found=$(git grep -n -I -E '(^|[^a-f0-9])[a-f0-9]{64}([^a-f0-9]|$)' -- . 2>/dev/null \
  | grep -v -E 'package-lock|node_modules' || true)
if [ -n "$found" ]; then
  echo "  check these by hand:"
  echo "$found" | head -8 | cut -c1-110 | sed 's/^/    /'
else
  echo "  none found - good"
fi

echo ""
echo "=== hardcoded passwords in source ==="
found=$(git grep -n -I -E "(password|passkey|secret)[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9@#!_.-]{6,}" \
  -- '*.php' '*.js' '*.jsx' '*.mjs' '*.ps1' 2>/dev/null | grep -v node_modules || true)
if [ -n "$found" ]; then
  echo "  check these by hand:"
  echo "$found" | head -12 | cut -c1-110 | sed 's/^/    /'
else
  echo "  none found - good"
fi

echo ""
echo "=== the callback audit log ==="
found=$(git ls-files | grep -E 'mpesa-callbacks|storage/' || true)
if [ -n "$found" ]; then
  echo "  PROBLEM - holds member phone numbers and receipts:"
  echo "$found" | sed 's/^/    /'
else
  echo "  not tracked - good"
fi

echo ""
echo "=== node_modules ==="
count=$(git ls-files | grep -c node_modules || true)
echo "  tracked files under node_modules: $count"