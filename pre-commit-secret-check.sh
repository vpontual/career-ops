#!/bin/bash
# pre-commit hook: block common secret/infra leaks before they reach a public repo.
# Install with:
#   chmod +x pre-commit-secret-check.sh
#   ln -sf ../../pre-commit-secret-check.sh .git/hooks/pre-commit
#
# Patterns checked here are GENERIC (API keys, RFC1918 IPs, .env files).
# For personal identifiers (emails, phones, internal hostnames), add them to
# .git/hooks/local-patterns (gitignored) — one extended-regex per line. Example:
#   v\.pontual@gmail\.com
#   vpmm\.local

set -e

# Generic forbidden patterns — safe to commit.
FORBIDDEN_PATTERNS=(
  # Private IPv4 ranges (RFC1918)
  '\b10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}\b'
  # API key formats
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'AIza[0-9A-Za-z_-]{35}'
  'ghp_[A-Za-z0-9]{36}'
  'ghs_[A-Za-z0-9]{36}'
  # OpenAI-style
  'sk-[A-Za-z0-9]{48}'
  # Assigned env values for sensitive keys
  '(GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY)=[A-Za-z0-9_\-]{10,}'
)

# Optional local-only patterns (personal identifiers, internal hostnames).
LOCAL_PATTERNS_FILE=".git/hooks/local-patterns"
if [ -f "$LOCAL_PATTERNS_FILE" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && [[ ! "$line" =~ ^# ]] && FORBIDDEN_PATTERNS+=("$line")
  done < "$LOCAL_PATTERNS_FILE"
fi

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)
if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

# Block any attempt to commit a .env (not .env.example)
for file in $STAGED_FILES; do
  case "$file" in
    .env|.env.*|!(*.example))
      if [ "$(basename "$file")" = ".env" ]; then
        echo "BLOCKED: refusing to commit .env (never commit actual secrets)"
        exit 1
      fi
      ;;
  esac
done

FAILED=0
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  MATCHES=$(git diff --cached -U0 | grep -E "^\+" | grep -Ev "^\+\+\+" | grep -E "$pattern" || true)
  if [ -n "$MATCHES" ]; then
    echo "BLOCKED: staged diff contains forbidden pattern: $pattern"
    echo "$MATCHES" | head -3 | sed 's/^/  /'
    FAILED=1
  fi
done

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "This is a PUBLIC fork. Do not commit personal info, internal IPs, or secrets."
  echo "Move them to .env (gitignored) or a user-scoped override file."
  echo "To add your own personal patterns: edit .git/hooks/local-patterns"
  exit 1
fi
