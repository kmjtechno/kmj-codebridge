#!/usr/bin/env bash
# Owner-run on KMJ-elite. Installs the dynamic-DNS timer; does not change DNS
# until the first --apply run. Usage:
#   sudo bash install.sh            # install files + dry run
#   sudo systemctl enable --now kmj-elite-ddns.timer   # after dry run looks right
set -euo pipefail
cd "$(dirname "$0")"
test "$(id -u)" = 0 || { echo "run with sudo"; exit 1; }
install -d -m 0755 /opt/kmj-elite-ddns
install -m 0644 ../../scripts/production/elite_dynamic_dns.py /opt/kmj-elite-ddns/elite_dynamic_dns.py
install -d -m 0700 /etc/kmj-elite-ddns
if [ ! -s /etc/kmj-elite-ddns/cloudflare.token ]; then
  echo "Paste Cloudflare API token (Zone.DNS:Edit, kmjtechno.com only), then Enter:"
  read -rs token
  umask 077
  printf '%s\n' "$token" > /etc/kmj-elite-ddns/cloudflare.token
  unset token
fi
chmod 0600 /etc/kmj-elite-ddns/cloudflare.token
install -d -m 0700 /var/lib/kmj-elite-ddns
if [ ! -s /var/lib/kmj-elite-ddns/last-ipv4 ]; then
  echo 150.242.200.81 > /var/lib/kmj-elite-ddns/last-ipv4
fi
install -m 0644 kmj-elite-ddns.service kmj-elite-ddns.timer /etc/systemd/system/
systemctl daemon-reload
python3 -B /opt/kmj-elite-ddns/elite_dynamic_dns.py --self-test
python3 -B /opt/kmj-elite-ddns/elite_dynamic_dns.py | tee /var/lib/kmj-elite-ddns/install-dry-run.txt
echo "ELITE_DDNS_INSTALL=OK  next: sudo systemctl enable --now kmj-elite-ddns.timer"
