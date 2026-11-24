#!/usr/bin/env bash
# Sets up the marketplace on an Ubuntu server without Docker (it can share one
# with other sites). Run it from the project folder on the server:
#
#   sudo DOMAIN=courses.example.com ADMIN=yourname bash deploy/setup.sh
#
# DOMAIN needs a DNS record pointing at this server. ADMIN creates the owner
# account and prints its password; leave it out on later runs. Running it
# again updates the code and restarts, keeping accounts, weeks and settings.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. sudo DOMAIN=courses.example.com bash deploy/setup.sh}"
[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/studywise-server
DATA=/var/lib/studywise-server
ENV_FILE=/etc/studywise-server.env
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# Oracle's Ubuntu images reject everything but SSH; the Oracle console's
# security list also needs ports 80 and 443 open.
echo "==> Opening ports 80 and 443"
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 1 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi

echo "==> Installing the app in $APP"
id studywise >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin studywise
mkdir -p "$APP" "$DATA"
rm -rf "$APP/public" "$APP/lib"
cp -r "$SRC/server.js" "$SRC/manage.js" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/lib" "$SRC/public" "$APP/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
chown -R studywise:studywise "$DATA"
chmod 750 "$DATA"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
PUBLIC_URL=https://$DOMAIN
DATA_DIR=$DATA
HOST=127.0.0.1
PORT=3005
TRUST_PROXY=1
MAX_UPLOAD_MB=300
UPLOADS_PER_DAY=60
SIGNUPS_PER_DAY=5
ENV
  chmod 600 "$ENV_FILE"
fi
sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" "$ENV_FILE"

# Accounts and weeks from SSH: sudo studywise-server-admin list
cat > /usr/local/bin/studywise-server-admin <<'WRAPPER'
#!/usr/bin/env bash
set -a; . /etc/studywise-server.env; set +a
cd /opt/studywise-server && exec sudo -E -u studywise /usr/bin/node manage.js "$@"
WRAPPER
chmod 755 /usr/local/bin/studywise-server-admin

if [ -n "${ADMIN:-}" ]; then
  echo "==> Creating owner account $ADMIN"
  /usr/local/bin/studywise-server-admin add-user "$ADMIN" --owner
fi

echo "==> Starting the server"
cp "$SRC/deploy/studywise-server.service" /etc/systemd/system/studywise-server.service
systemctl daemon-reload
systemctl enable studywise-server
systemctl restart studywise-server

# Each site keeps its own file in /etc/caddy/sites, so sites on the same
# server don't overwrite each other.
echo "==> Configuring Caddy for $DOMAIN"
mkdir -p /etc/caddy/sites
sed -e "s/{{DOMAIN}}/$DOMAIN/g" "$SRC/deploy/Caddyfile" > /etc/caddy/sites/studywise-server.caddy
grep -q '^import /etc/caddy/sites/\*.caddy' /etc/caddy/Caddyfile 2>/dev/null ||
  echo "import /etc/caddy/sites/*.caddy" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

echo
echo "Done. Open https://$DOMAIN"
echo "If it doesn't load, check that $DOMAIN points at this server."
