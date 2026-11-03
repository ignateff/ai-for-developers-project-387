#!/usr/bin/env bash
# Regenerate the Linux (CI) visual baselines of e2e/00-visual.spec.ts inside the
# official Playwright container matching the installed @playwright/test version.
# Runs on a throwaway copy of the repo so that pnpm install in the container
# cannot poison the host's platform-specific node_modules.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "error: docker is not running (start Docker/OrbStack first)" >&2
  exit 1
fi

playwright_version=$(node -p "require('@playwright/test/package.json').version")
pnpm_version=$(node -p "require('./package.json').packageManager.split('@')[1]")
image="mcr.microsoft.com/playwright:v${playwright_version}-noble"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rsync -a \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude test-results \
  --exclude playwright-report \
  --exclude '*.sqlite*' \
  ./ "$work/"

cat > "$work/run-in-container.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
corepack enable
corepack prepare pnpm@${pnpm_version} --activate
cd /work
pnpm install --frozen-lockfile
if ! pnpm rebuild better-sqlite3; then
  apt-get update && apt-get install -y build-essential python3
  pnpm rebuild better-sqlite3
fi
# Minimal shim: playwright.config.ts launches dev servers through mise run.
cat > /usr/local/bin/mise <<'SHIM'
#!/usr/bin/env bash
if [ "\$1" = "run" ]; then
  task="\$2"; shift 2
  [ "\${1:-}" = "--" ] && shift
  case "\$task" in
    dev-api) pkg="@calendar/api" ;;
    dev-web) pkg="@calendar/web" ;;
    *) echo "mise shim: unknown task \$task" >&2; exit 1 ;;
  esac
  exec pnpm --filter "\$pkg" run dev "\$@"
fi
exec "\$@"
SHIM
chmod +x /usr/local/bin/mise
pnpm exec playwright test e2e/00-visual.spec.ts --update-snapshots
EOF

docker run --rm -v "$work:/work" -w /work "$image" bash run-in-container.sh

cp "$work"/e2e/00-visual.spec.ts-snapshots/*-linux.png e2e/00-visual.spec.ts-snapshots/
echo "Linux baselines updated in e2e/00-visual.spec.ts-snapshots/"
