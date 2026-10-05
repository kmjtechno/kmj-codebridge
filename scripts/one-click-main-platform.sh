#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }

REPO='kmjtechno/kmj-main-platform'
TARGET="${CODEBRIDGE_PROJECT_ROOT:-/srv/kmj-codebridge-projects/kmj-main-platform}"
STATE="${CODEBRIDGE_STATE_DIR:-/var/lib/kmj-codebridge-main-platform}"
KEY_DIR="$STATE/repository"
KEY="$KEY_DIR/deploy_ed25519"

if id kmjrunner >/dev/null 2>&1; then
  SERVICE_USER=kmjrunner
elif id kmjprod >/dev/null 2>&1; then
  SERVICE_USER=kmjprod
elif id kmjstage >/dev/null 2>&1; then
  SERVICE_USER=kmjstage
else
  SERVICE_USER=root
fi

echo 'KMJ CodeBridge — Main Platform one-command setup'
echo "service_user=$SERVICE_USER"

need_packages=()
command -v git >/dev/null 2>&1 || need_packages+=(git)
command -v ssh-keygen >/dev/null 2>&1 || need_packages+=(openssh-client)
command -v curl >/dev/null 2>&1 || need_packages+=(curl)
command -v gh >/dev/null 2>&1 || need_packages+=(gh)
if (( ${#need_packages[@]} )); then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates "${need_packages[@]}"
fi

install -d -m 0755 /srv/kmj-codebridge-projects
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE" "$KEY_DIR"

repo_ok() {
  [[ -d "$TARGET/.git" && -f "$TARGET/apps/platform/composer.json" ]] || return 1
  grep -Fq '"name": "kmjtechno/kmj-main-platform"' "$TARGET/apps/platform/composer.json" || return 1
  origin="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == "git@github.com:kmjtechno/kmj-main-platform.git" || "$origin" == "https://github.com/kmjtechno/kmj-main-platform.git" || "$origin" == "ssh://git@github.com/kmjtechno/kmj-main-platform.git" ]]
}

if ! repo_ok; then
  if [[ -e "$TARGET" ]]; then
    echo "Existing target is not the expected Git checkout: $TARGET" >&2
    exit 2
  fi

  if [[ ! -f "$KEY" ]]; then
    ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C 'kmj-main-platform-codebridge'
    chown "$SERVICE_USER:$SERVICE_USER" "$KEY" "$KEY.pub"
    chmod 0600 "$KEY"
    chmod 0644 "$KEY.pub"
  fi

  GH_CONFIG_DIR="$(mktemp -d /tmp/kmj-gh-auth.XXXXXX)"
  export GH_CONFIG_DIR
  cleanup_gh() { rm -rf "$GH_CONFIG_DIR"; }
  trap cleanup_gh EXIT

  echo
  echo 'One browser approval is needed to authorize this VPS to add a read-only deploy key.'
  echo 'The temporary GitHub CLI login is deleted immediately after the key is added.'
  gh auth login --hostname github.com --git-protocol https --web

  title="KMJ Main Platform CodeBridge $(hostname -s)"
  public_key="$(cat "$KEY.pub")"
  set +e
  gh api --method POST "repos/$REPO/keys"     -f title="$title"     -f key="$public_key"     -F read_only=true >/dev/null 2>&1
  add_key_status=$?
  set -e
  if (( add_key_status != 0 )); then
    echo 'Deploy-key create returned non-zero; continuing because the same key may already be registered.'
  else
    echo 'Read-only Main Platform deploy key authorized.'
  fi

  cleanup_gh
  trap - EXIT
  unset GH_CONFIG_DIR

  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$(dirname "$TARGET")"
  SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  sudo -u "$SERVICE_USER" -H env GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$SSH_COMMAND"     git clone "git@github.com:$REPO.git" "$TARGET"

  sudo -u "$SERVICE_USER" -H git -C "$TARGET" config core.sshCommand "$SSH_COMMAND"
fi

repo_ok || { echo 'Main Platform repository verification failed.' >&2; exit 3; }

echo
echo 'Main Platform Git checkout ready.'
echo "project_root=$TARGET"
echo

curl -fsSL https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/main/scripts/setup-main-platform-agent.sh \
| env -u CODEBRIDGE_SOURCE_ROOT \
    CODEBRIDGE_SOURCE_ROOT="$TARGET" \
    CODEBRIDGE_SERVICE_USER="$SERVICE_USER" \
    bash
