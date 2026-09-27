#!/usr/bin/env bash
# 发布（在本地或 CI 执行）：构建网站 → 上传新版本 → 切换软链接 → 重启 lead-api → 验证。
#   DEPLOY_HOST=deploy@1.2.3.4 DOMAIN=quickcomepay.com bash deploy/scripts/deploy.sh
# 服务器上的部署用户需要有 sudo 权限。
set -euo pipefail

: "${DEPLOY_HOST:?需要 DEPLOY_HOST，例如 deploy@1.2.3.4}"
: "${DOMAIN:?需要 DOMAIN}"
KEEP="${KEEP_RELEASES:-5}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TS="$(date -u +%Y%m%d%H%M%S)"
REV="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
REL="$TS-$REV"

echo "==> 构建网站（SITE_URL=https://$DOMAIN）"
(cd "$ROOT/site" && npm ci && SITE_URL="https://$DOMAIN" npm run build)

echo "==> 单元测试 lead-api"
(cd "$ROOT/lead-api" && npm ci && npm test)

echo "==> 上传版本 $REL"
ssh "$DEPLOY_HOST" "mkdir -p /tmp/qc-$REL"
rsync -az --delete "$ROOT/site/dist/" "$DEPLOY_HOST:/tmp/qc-$REL/site/"
rsync -az --delete --exclude node_modules --exclude data --exclude .env "$ROOT/lead-api/" "$DEPLOY_HOST:/tmp/qc-$REL/lead-api/"

echo "==> 在服务器上安装并切换"
ssh "$DEPLOY_HOST" "sudo bash -s" <<REMOTE
set -euo pipefail
mv /tmp/qc-$REL/site /var/www/quickcome/releases/$REL
chown -R root:root /var/www/quickcome/releases/$REL
chmod -R a+rX /var/www/quickcome/releases/$REL
mv /tmp/qc-$REL/lead-api /srv/quickcome/lead-api/releases/$REL
cd /srv/quickcome/lead-api/releases/$REL && npm ci --omit=dev --no-audit --no-fund
chown -R root:root /srv/quickcome/lead-api/releases/$REL
chmod -R a+rX /srv/quickcome/lead-api/releases/$REL
rm -rf /tmp/qc-$REL

# 原子切换：先建临时软链接再 mv 覆盖
ln -sfn /var/www/quickcome/releases/$REL /var/www/quickcome/current.tmp && mv -T /var/www/quickcome/current.tmp /var/www/quickcome/current
ln -sfn /srv/quickcome/lead-api/releases/$REL /srv/quickcome/lead-api/current.tmp && mv -T /srv/quickcome/lead-api/current.tmp /srv/quickcome/lead-api/current
systemctl restart quickcome-lead-api
nginx -t && systemctl reload nginx

# 本机验证
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:3001/api/health >/dev/null && break; sleep 1; done
curl -fsS http://127.0.0.1:3001/api/health

# 只保留最近 $KEEP 个版本
cd /var/www/quickcome/releases && ls -1t | grep -v '^placeholder$' | tail -n +$((KEEP + 1)) | xargs -r rm -rf
cd /srv/quickcome/lead-api/releases && ls -1t | tail -n +$((KEEP + 1)) | xargs -r rm -rf
REMOTE

echo "==> 外部验证"
bash "$(dirname "$0")/verify.sh" "https://$DOMAIN"
echo "发布完成：$REL"
