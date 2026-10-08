#!/usr/bin/env bash
# Fixed zero-GitHub-minutes CI worker. Invoke only through the guarded
# transient systemd sandbox. Never run from a production agent identity.
set -Eeuo pipefail
if [[ $# -ne 1 || ! -d "$1/apps/platform" ]]; then
  echo "CI_WORKER_INVALID_WORKSPACE" >&2
  exit 2
fi
src="$(realpath -- "$1")"
if [[ "$src" != /var/lib/kmj-codebridge-ci/jobs/*/src ]]; then
  echo "CI_WORKER_UNTRUSTED_WORKSPACE" >&2
  exit 2
fi
# CI-only root-owned Rust installation; no rustup/user config inheritance.
if [[ -x /opt/kmj-codebridge-ci-prerequisites/versions/rust1.90.0-pg17.10-v1/rust/bin/cargo ]]; then
  export PATH="/opt/kmj-codebridge-ci-prerequisites/versions/rust1.90.0-pg17.10-v1/rust/bin:$PATH"
fi
# Emit fixed preflight versions before any project code or gate executes.
platform_path="$PATH"
# Hosted platform assertions require Node 22; the separate license consumer
# assertion requires Node 24. Missing approved runtimes fail their named gate.
if [[ -d /opt/kmj-codebridge-node22/bin ]]; then
  export PATH="/opt/kmj-codebridge-node22/bin:$PATH"
fi
runtime_version() {
  local label="$1" value
  shift
  value="$(cd / && "$@" 2>/dev/null)" || value=UNAVAILABLE
  if [[ ! "$value" =~ ^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$ || ${#value} -gt 64 ]]; then
    value=UNAVAILABLE
  fi
  printf 'KMJ_CI_RUNTIME_%s=%s\n' "$label" "$value"
}
runtime_version PHP php -r 'echo PHP_VERSION;'
runtime_version NODE_PLATFORM node -p 'process.versions.node'
consumer_path="$platform_path"
if [[ -x /opt/kmj-codebridge-node/bin/node ]]; then
  consumer_path="/opt/kmj-codebridge-node/bin:$consumer_path"
fi
runtime_version NODE_CONSUMER /usr/bin/env PATH="$consumer_path" node -p 'process.versions.node'
runtime_version PYTHON python3 -c 'import sys; print(".".join(map(str, sys.version_info[:3])))'
runtime_version CARGO /bin/bash -o pipefail -c 'cargo --version | awk "{print \$2}"'
runtime_version POSTGRES /bin/bash -o pipefail -c '/usr/lib/postgresql/17/bin/postgres --version | awk "{print \$3}"'

cd "$src/apps/platform"
export APP_ENV=testing
export APP_KEY='0123456789abcdef0123456789abcdef'
export DB_CONNECTION=sqlite
export DB_DATABASE="$src/apps/platform/database/database.sqlite"
export DB_URL=''
export QUEUE_CONNECTION=sync
export CACHE_STORE=array
export SESSION_DRIVER=array
export MAIL_MAILER=array
export BCRYPT_ROUNDS=4
export PULSE_ENABLED=false
export TELESCOPE_ENABLED=false
export NIGHTWATCH_ENABLED=false
export CI=true
unset GITHUB_TOKEN GH_TOKEN GIT_ASKPASS SSH_AUTH_SOCK DATABASE_URL

gate() {
  local label="$1"
  shift
  echo "KMJ_CI_GATE_BEGIN=$label"
  "$@"
  echo "KMJ_CI_GATE_PASS=$label"
}
platform_runtime() {
  php --version && node --version &&
  php -r 'exit(PHP_VERSION_ID >= 80300 && PHP_VERSION_ID < 80600 ? 0 : 1);' &&
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 22 ? 0 : 1)'
}
php_syntax() {
  local files
  files="$(git -C "$src" ls-files ':(glob)apps/platform/**/*.php')" || return 1
  [[ -n "$files" ]] || return 1
  while IFS= read -r file; do
    php -l "$src/$file" || return 1
  done <<< "$files"
}
gate platform_runtime platform_runtime
test -f .env || cp .env.example .env
touch database/database.sqlite
gate php_key_generate php artisan key:generate --force
gate php_migrations php artisan migrate --force
gate php_syntax php_syntax
if [[ -f scripts/check-public-layout.mjs ]]; then
  gate public_layout node scripts/check-public-layout.mjs
fi
gate fmt_lint npm run check
gate frontend_build npm run build
gate typescript npm run types:check
gate php_config_clear php artisan config:clear --ansi
gate php_format php vendor/bin/pint --test
gate php_static_analysis php vendor/bin/phpstan analyse
gate php_tests php -d memory_limit=768M vendor/bin/phpunit -c phpunit.xml --no-progress --colors=never
export PATH="$platform_path"
if [[ -x /opt/kmj-codebridge-node/bin/node ]]; then
  export PATH="/opt/kmj-codebridge-node/bin:$PATH"
fi
cd "$src"
# All foundation assertions mirror the existing private Ubuntu workflows.
# No dependency fetch, signing key, production database or provider API is used.
export PYTHONPATH="$src"
export CARGO_NET_OFFLINE=true
export CARGO_HOME="$src/.ci-cargo"
export KMJ_PROGRESS_HEAD_SHA="$(cat "$src/.git/HEAD")"
export KMJ_PROGRESS_BASE_SHA="$(cat "$src/.ci-base-sha")"
export PYTHONDONTWRITEBYTECODE=1

audit_policy() {
  grep -q 'KMJ_PAID_FALLBACK' render.yaml &&
  grep -q 'KMJ_LOCAL_LLM' render.yaml &&
  grep -q 'kmjtechno/kmj-main-platform' mission/main-platform.yaml &&
  grep -q 'cloud_nexus_policy: untouched' mission/main-platform.yaml &&
  grep -q 'paid_ai_fallback: prohibited' mission/main-platform.yaml &&
  grep -q 'local_llm_inference: prohibited' mission/main-platform.yaml &&
  grep -q 'no_free_route_status: NO_FREE_ROUTE_AVAILABLE' mission/main-platform.yaml
}
audit_backup() {
  bash -n scripts/backup_platform.sh &&
  bash -n scripts/verify_backup_bundle.sh &&
  bash -n scripts/backup_preflight.sh &&
  grep -q 'BACKUP_REMOTE' scripts/backup_platform.sh &&
  grep -q 'BACKUP_AGE_RECIPIENT' scripts/backup_platform.sh &&
  grep -q 'sha256sum --check' scripts/verify_backup_bundle.sh &&
  grep -q 'No secret values were printed' scripts/backup_preflight.sh &&
  python3 scripts/test_backup_contract.py &&
  python3 scripts/test_restore_verification_contract.py &&
  bash -n infra/server/KMJ_SERVER_BOOTSTRAP.sh &&
  bash -n infra/server/KMJ_STAGE_TLS_REPAIR.sh
}
audit_architecture() {
  for file in .github/CODEOWNERS docs/adr/ADR-001-system-boundaries.md docs/adr/ADR-002-modular-monolith.md docs/adr/ADR-003-commercial-authority-chain.md docs/adr/ADR-004-cloud-ai-policy.md docs/adr/ADR-005-kristi-governance.md docs/architecture/first-vertical-slice.md work/backlog.yaml apps/platform/README.md apps/platform/KMJ_BOUNDARY.md packages/contracts/README.md services/license-core/README.md tests/architecture/README.md; do
    test -f "$file" || return 1
  done
  grep -q 'Cloud Nexus remains a separate engineering IDE' docs/adr/ADR-001-system-boundaries.md &&
  grep -q 'NO_FREE_ROUTE_AVAILABLE' docs/adr/ADR-004-cloud-ai-policy.md &&
  grep -q 'Organization -> Product -> Entitlement' docs/architecture/first-vertical-slice.md &&
  grep -q 'production_requires_owner_approval: true' work/backlog.yaml
}
gate foundation_python_runtime python3 -c 'import sys; import fastapi, httpx, pydantic, yaml; assert sys.version_info >= (3, 11)'
gate foundation_compile python3 -m compileall controller
gate foundation_workers python3 -m unittest tests.test_persistent_worker tests.test_worker_retry_recovery tests.test_delivery_control_bridge tests.test_staging_monitor_contract tests.test_live_public_surface_contract tests.test_opencode_free tests.test_router_official_client tests.test_codebridge_github_proxy
gate foundation_browser_qa node --test ops/staging/browser-qa.test.mjs
gate foundation_policy audit_policy
gate foundation_backup audit_backup
gate foundation_architecture audit_architecture
gate foundation_delivery python3 scripts/verify_delivery_progress.py
gate foundation_public_surface python3 scripts/verify_public_surface.py
gate foundation_free_router python3 scripts/verify_free_router.py
gate foundation_contracts python3 scripts/verify_contracts.py
gate rust_format cargo fmt --manifest-path services/license-core/Cargo.toml --check
gate rust_tests cargo test --offline --locked --manifest-path services/license-core/Cargo.toml
gate kslp_contract bash contracts/kslp-v1/verify-contract.sh
gate foundation_module_architecture python3 scripts/verify_architecture.py
gate foundation_runtime python3 scripts/verify_runtime.py
gate lease_encoder_syntax php -l apps/platform/app/Services/Licensing/CodeBridge/CodeBridgeLeaseEncoder.php
gate activation_proof php tests/codebridge/activation-proof.php apps/platform/app/Services/Licensing/Kslp/KslpActivationProof.php
gate renewal php tests/codebridge/renewal.php "$src/codebridge-test-fixture.json"
gate license_runtime node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'
gate node_lease_interop node tests/codebridge/verify.mjs "$src/codebridge-test-fixture.json"

# Mandatory real PostgreSQL concurrency: no SQLite downgrade, no skip.
if [[ ! -x /usr/bin/pg_virtualenv ]]; then
  echo "KMJ_CI_PG_REQUIRED_UNAVAILABLE" >&2
  exit 42
fi
echo "KMJ_CI_GATE_BEGIN=postgres_concurrency"
pg_virtualenv -v 17 /bin/bash -ec '
  : "$PGPORT"
  : "$PGHOST"
  export CODEBRIDGE_CONCURRENCY_REQUIRED=1
  export CODEBRIDGE_CONCURRENCY_DSN="pgsql:host=$PGHOST;port=$PGPORT;dbname=postgres"
  export CODEBRIDGE_CONCURRENCY_USER="$PGUSER"
  export CODEBRIDGE_CONCURRENCY_PASSWORD=""
  php -m | grep -Fxq pdo_pgsql
  php -r "exit(function_exists(\"pcntl_fork\") ? 0 : 1);"
  command -v psql
  pg_isready
  php tests/codebridge/concurrency-schema.php
  output="$(php tests/codebridge/concurrency.php 2>&1)"
  printf " %s\n" "$output"
  grep -F "CodeBridge real-DB concurrency checks: PASS" <<< "$output"
  if grep -Fq "SKIP:" <<< "$output"; then exit 1; fi
'
echo "KMJ_CI_GATE_PASS=postgres_concurrency"
echo "KMJ_CI_LINUX_SUITE_PASS=1"
# Windows was not tested here. Windows remains a separate gate.
