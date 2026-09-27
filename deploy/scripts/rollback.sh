#!/usr/bin/env bash
# 回滚到上一个版本（或指定版本）。
#   DEPLOY_HOST=deploy@1.2.3.4 DOMAIN=quickcomepay.com bash deploy/scripts/rollback.sh [版本目录名]
set -euo pipefail
: "${DEPLOY_HOST:?需要 DEPLOY_HOST}"
: "${DOMAIN:?需要 DOMAIN}"
TARGET="${1:-}"

ssh "$DEPLOY_HOST" "sudo TARGET='$TARGET' bash -s" <<'REMOTE'
set -euo pipefail
cur="$(basename "$(readlink -f /var/www/quickcome/current)")"
if [ -z "$TARGET" ]; then
  TARGET="$(ls -1t /var/www/quickcome/releases | grep -v '^placeholder$' | grep -vx "$cur" | head -n 1)"
fi
[ -n "$TARGET" ] && [ -d "/var/www/quickcome/releases/$TARGET" ] || { echo "找不到可回滚的版本"; exit 1; }
echo "当前版本: $cur  → 回滚到: $TARGET"
ln -sfn "/var/www/quickcome/releases/$TARGET" /var/www/quickcome/current.tmp && mv -T /var/www/quickcome/current.tmp /var/www/quickcome/current
if [ -d "/srv/quickcome/lead-api/releases/$TARGET" ]; then
  ln -sfn "/srv/quickcome/lead-api/releases/$TARGET" /srv/quickcome/lead-api/current.tmp && mv -T /srv/quickcome/lead-api/current.tmp /srv/quickcome/lead-api/current
  systemctl restart quickcome-lead-api
fi
nginx -t && systemctl reload nginx
REMOTE

bash "$(dirname "$0")/verify.sh" "https://$DOMAIN"
