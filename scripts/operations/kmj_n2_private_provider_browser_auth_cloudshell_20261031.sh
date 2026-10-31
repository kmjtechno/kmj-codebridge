#!/usr/bin/env bash
# One-time browser authorization for private KMJ CloudOS checkout on Google Cloud Shell.
# Uses ephemeral GitHub CLI config; revokes temporary login after the test.
# The existing exact-SHA provider smoke performs all source and N2 safety checks.
set -Eeuo pipefail
umask 077
TARGET=kmjtechno/kmj-cloudos
SCRIPT=kmj_n2_private_provider_smoke_cloudshell_20261031.sh
SCRIPT_REF=2b122a4c694fee24c544dce0839baab3eb942c8f
SCRIPT_SHA=d39235d31502bbad2157f3688c722183f4ece4855c335c87e00a640737dcbea9
TMP="$(mktemp -d "$HOME/.kmj-gh-auth.XXXXXXXX")"
LOGIN_CREATED=no
cleanup() {
  local rc="$?"
  trap - EXIT
  if [ "$LOGIN_CREATED" = yes ] && command -v gh >/dev/null 2>&1; then
    gh auth logout --hostname github.com >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TMP"
  exit "$rc"
}
trap cleanup EXIT
echo KMJ_CLOUDOS_PRIVATE_GITHUB_AUTH_AND_N2_PROVIDER_V1
echo SCOPE=EPHEMERAL_BROWSER_AUTH_NO_TOKEN_OUTPUT
if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
  echo BLOCKED=INTERACTIVE_TTY_REQUIRED
  exit 3
fi
if ! command -v gh >/dev/null 2>&1; then
  echo GITHUB_CLI=NOT_INSTALLED
  if ! command -v sudo >/dev/null 2>&1 || ! command -v apt-get >/dev/null 2>&1; then
    echo BLOCKED=GITHUB_CLI_UNAVAILABLE
    exit 3
  fi
  echo ACTION=INSTALL_GITHUB_CLI_FROM_OS_APT
  if sudo -n true >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    if sudo -n timeout --signal=TERM --kill-after=10s 180s apt-get -o DPkg::Lock::Timeout=30 update -qq >"$TMP/apt-update.log" 2>&1 &&
       sudo -n timeout --signal=TERM --kill-after=10s 180s apt-get -o DPkg::Lock::Timeout=30 -y --no-install-recommends install gh >"$TMP/apt-install.log" 2>&1; then
      echo GITHUB_CLI_APT_INSTALL=PASS
    else
      echo BLOCKED=GITHUB_CLI_APT_INSTALL_FAILED
      tail -n 8 "$TMP/apt-install.log" 2>/dev/null | cut -c1-170 || true
      exit 4
    fi
  else
    echo BLOCKED=ROOT_APT_APPROVAL_REQUIRED
    exit 3
  fi
fi
command -v gh >/dev/null
echo GITHUB_CLI=AVAILABLE
# Isolate credentials even if the user has other gh accounts configured.
export GH_CONFIG_DIR="$TMP/gh"
mkdir -p -m 0700 "$GH_CONFIG_DIR"
unset GH_TOKEN GITHUB_TOKEN
echo ACTION=OWNER_BROWSER_GITHUB_SIGN_IN
echo 'GitHub browser authorization is required once for this isolated test.'
echo 'Approve only if the displayed GitHub account has access to kmjtechno/kmj-cloudos.'
# GitHub CLI must read from the terminal, not the enclosing heredoc's standard input.
if ! gh auth login --hostname github.com --git-protocol https --web --scopes repo </dev/tty; then
  echo BLOCKED=OWNER_BROWSER_AUTH_NOT_COMPLETED
  exit 5
fi
LOGIN_CREATED=yes
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo BLOCKED=GITHUB_CLI_AUTH_NOT_ACTIVE
  exit 5
fi
if ! gh api "repos/$TARGET" --jq '.private' 2>/dev/null | grep -qx true; then
  echo BLOCKED=PRIVATE_REPOSITORY_READ_ACCESS_NOT_GRANTED
  exit 5
fi
echo OWNER_PRIVATE_REPO_READ=PASS
echo AUTH_STORAGE=TEMPORARY_AND_REVOKED_ON_EXIT
FILE="$TMP/$SCRIPT"
curl -fLSs --retry 3 --connect-timeout 12 --max-time 90 \
 --proto '=https' --proto-redir '=https' \
 "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$SCRIPT_REF/scripts/operations/$SCRIPT" -o "$FILE"
echo "$SCRIPT_SHA  $FILE" | sha256sum -c -
bash -n "$FILE"
echo PROVIDER_SCRIPT_PIN_AND_SYNTAX=PASS
bash "$FILE"
echo RESULT=PRIVATE_AUTH_AND_N2_PROVIDER_SMOKE_PASS
