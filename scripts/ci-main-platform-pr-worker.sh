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
cd "$src/apps/platform"
export APP_ENV=testing
export APP_KEY='0123456789abcdef0123456789abcdef'
export DB_CONNECTION=sqlite
export DB_DATABASE=':memory:'
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
gate fmt_lint npm run check
gate frontend_build npm run build
gate typescript npm run types:check
gate php_format php vendor/bin/pint --test
gate php_tests php -d memory_limit=768M vendor/bin/phpunit -c phpunit.xml --no-progress --colors=never
cd "$src"
gate activation_proof php tests/codebridge/activation-proof.php apps/platform/app/Services/Licensing/Kslp/KslpActivationProof.php
gate renewal php tests/codebridge/renewal.php "$src/codebridge-test-fixture.json"
gate node_lease_interop node tests/codebridge/verify.mjs "$src/codebridge-test-fixture.json"

# Mandatory real PostgreSQL concurrency: no SQLite downgrade, no skip.
if [[ ! -x /usr/bin/pg_virtualenv ]]; then
  echo "KMJ_CI_PG_REQUIRED_UNAVAILABLE" >&2
  exit 42
fi
echo "KMJ_CI_GATE_BEGIN=postgres_concurrency"
pg_virtualenv -v 16 /bin/bash -ec '
  : "$PGPORT"
  : "$PGHOST"
  export CODEBRIDGE_CONCURRENCY_REQUIRED=1
  export CODEBRIDGE_CONCURRENCY_DSN="pgsql:host=$PGHOST;port=$PGPORT;dbname=postgres"
  export CODEBRIDGE_CONCURRENCY_USER="$PGUSER"
  export CODEBRIDGE_CONCURRENCY_PASSWORD=""
  php tests/codebridge/concurrency-schema.php
  php tests/codebridge/concurrency.php
'
echo "KMJ_CI_GATE_PASS=postgres_concurrency"
echo "KMJ_CI_LINUX_SUITE_PASS=1"
# Windows was not tested here. Windows remains a separate gate.
