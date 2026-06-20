#!/usr/bin/env bash
# One-time: install a git pre-commit hook that runs validate.py, so a
# malformed prompts.json / pings.json can't be committed. Run from the repo:
#   bash install-hook.sh
set -e
HOOK=".git/hooks/pre-commit"
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# Block the commit if the config JSON files don't validate.
python3 "$(git rev-parse --show-toplevel)/validate.py" || {
  echo ""
  echo "Commit blocked: fix the JSON above (or 'git commit --no-verify' to bypass)."
  exit 1
}
EOF
chmod +x "$HOOK"
echo "Installed pre-commit hook → $HOOK"
