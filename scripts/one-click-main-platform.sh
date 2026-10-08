#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }

REPO='kmjtechno/kmj-main-platform'
TARGET="${CODEBRIDGE_PROJECT_ROOT:-/srv/kmj-codebridge-projects/kmj-main-platform}"
STATE="${CODEBRIDGE_STATE_DIR:-/var/lib/kmj-codebridge-main-platform}"
KEY_DIR="$STATE/repository"
KEY="$KEY_DIR/deploy_ed25519"
SETUP_REVISION='e54b09acca7ee826e0bf921f1436b11f1506e035'
SETUP_SHA256='f4544caf765888ed70189ce92a424fd3b6280ca15c9e89805d0bb43b29cee274'

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
  origin="$(git -c safe.directory="$TARGET" -C "$TARGET" remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == "git@github.com:kmjtechno/kmj-main-platform.git" || "$origin" == "https://github.com/kmjtechno/kmj-main-platform.git" || "$origin" == "ssh://git@github.com/kmjtechno/kmj-main-platform.git" ]]
}

if ! repo_ok; then
  if [[ -d "$TARGET/.git" && -f "$TARGET/apps/platform/composer.json" ]] && \
     grep -Fq '"name": "kmjtechno/kmj-main-platform"' "$TARGET/apps/platform/composer.json"; then
    echo 'Repairing existing Main Platform checkout metadata.'
    git -c safe.directory="$TARGET" -C "$TARGET" remote set-url origin "git@github.com:$REPO.git"
  fi
fi

if ! repo_ok; then
  if [[ -e "$TARGET" ]]; then
    backup="${TARGET}.recovery-$(date +%Y%m%d%H%M%S)"
    echo "Preserving unexpected target at: $backup"
    mv "$TARGET" "$backup"
  fi

  if [[ ! -f "$KEY" ]]; then
    ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C 'kmj-main-platform-codebridge'
    chown "$SERVICE_USER:$SERVICE_USER" "$KEY" "$KEY.pub"
    chmod 0600 "$KEY"
    chmod 0644 "$KEY.pub"
  fi

  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$(dirname "$TARGET")"
  SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

  echo 'Trying the existing read-only Main Platform deploy key.'
  set +e
  sudo -u "$SERVICE_USER" -H env GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$SSH_COMMAND" \
    git clone "git@github.com:$REPO.git" "$TARGET"
  clone_status=$?
  set -e

  if (( clone_status != 0 )); then
    rm -rf "$TARGET"

    GH_CONFIG_DIR="$(mktemp -d /tmp/kmj-gh-auth.XXXXXX)"
    export GH_CONFIG_DIR
    cleanup_gh() { rm -rf "$GH_CONFIG_DIR"; }
    trap cleanup_gh EXIT

    echo
    echo 'One browser approval is needed to authorize this VPS read-only deploy key.'
    echo 'The temporary GitHub CLI login is deleted immediately after authorization.'
    gh auth login --hostname github.com --git-protocol https --web

    title="KMJ Main Platform CodeBridge $(hostname -s)"
    public_key="$(cat "$KEY.pub")"
    set +e
    gh api --method POST "repos/$REPO/keys" \
      -f title="$title" \
      -f key="$public_key" \
      -F read_only=true >/dev/null 2>&1
    add_key_status=$?
    set -e

    if (( add_key_status != 0 )); then
      echo 'Deploy-key create returned non-zero; retrying because the same key may already exist.'
    else
      echo 'Read-only Main Platform deploy key authorized.'
    fi

    cleanup_gh
    trap - EXIT
    unset GH_CONFIG_DIR

    sudo -u "$SERVICE_USER" -H env GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$SSH_COMMAND" \
      git clone "git@github.com:$REPO.git" "$TARGET"
  fi

  sudo -u "$SERVICE_USER" -H git -C "$TARGET" remote set-url origin "git@github.com:$REPO.git"
  sudo -u "$SERVICE_USER" -H git -C "$TARGET" config core.sshCommand "$SSH_COMMAND"
fi

repo_ok || { echo 'Main Platform repository verification failed.' >&2; exit 3; }

echo
echo 'Main Platform Git checkout ready.'
echo "project_root=$TARGET"
echo

SETUP_SCRIPT="$(mktemp /tmp/kmj-codebridge-setup.XXXXXX)"
cleanup_setup() { rm -f "$SETUP_SCRIPT"; }
trap cleanup_setup EXIT
curl -fsSL --proto '=https' --tlsv1.2 \
  "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$SETUP_REVISION/scripts/setup-main-platform-agent.sh" \
  -o "$SETUP_SCRIPT"
printf '%s  %s\n' "$SETUP_SHA256" "$SETUP_SCRIPT" | sha256sum -c - >/dev/null
chmod 0700 "$SETUP_SCRIPT"
env -u CODEBRIDGE_SOURCE_ROOT \
  CODEBRIDGE_SOURCE_ROOT="$TARGET" \
  CODEBRIDGE_SERVICE_USER="$SERVICE_USER" \
  bash "$SETUP_SCRIPT"
cleanup_setup
trap - EXIT
