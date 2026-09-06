#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/scriptscat/scriptcat.git}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"
PUSH="${PUSH:-0}"

root="$(git rev-parse --show-toplevel)"
cd "$root"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to sync a dirty worktree." >&2
  exit 2
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi

git fetch --tags upstream "$UPSTREAM_REF"
git merge --no-edit "upstream/$UPSTREAM_REF"

corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm exec vitest run src/app/service/service_worker/gm_api/gm_api.test.ts --no-coverage
pnpm run typecheck
pnpm run build

echo "SYNC_BUILD_OK $(git rev-parse HEAD)"
echo "Load unpacked from: $root/dist/ext"

if [[ "$PUSH" == "1" ]]; then
  git push origin HEAD
fi
