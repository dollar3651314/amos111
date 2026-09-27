#!/usr/bin/env bash
# 服务器初始化（只执行一次）。在目标服务器上以 sudo 运行：
#   sudo DOMAIN=quickcomepay.com ALT_DOMAIN=getquickcome.com ADMIN_EMAIL=ops@example.com bash server-init.sh
# 需要把整个 deploy/ 目录上传到服务器后，在 deploy/scripts 目录里执行。
# 本脚本可以重复执行（幂等）。执行前请确认：当前 SSH 会话使用的是密钥登录，否则禁用密码登录后会被锁在门外。
set -euo pipefail

: "${DOMAIN:?需要 DOMAIN}"
: "${ALT_DOMAIN:=}"
: "${ADMIN_EMAIL:?需要 ADMIN_EMAIL（证书到期提醒邮箱）}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(dirname "$HERE")"

echo "==> 1/8 系统更新与基础软件"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nginx certbot ufw fail2ban unattended-upgrades curl rsync openssl ca-certificates gnupg
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> 2/8 Node.js 22 LTS（NodeSource 官方源）"
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

echo "==> 3/8 服务账号与目录"
id quickcome >/dev/null 2>&1 || useradd --system --home /var/lib/quickcome --shell /usr/sbin/nologin quickcome
install -d -m 755 /var/www/quickcome/releases /srv/quickcome/lead-api/releases /var/www/letsencrypt
install -d -m 700 -o quickcome -g quickcome /var/lib/quickcome
install -d -m 700 /etc/quickcome /var/backups/quickcome
if [ ! -f /etc/quickcome/lead-api.env ]; then
  install -m 600 "$DEPLOY/../lead-api/.env.example" /etc/quickcome/lead-api.env 2>/dev/null \
    || install -m 600 /dev/null /etc/quickcome/lead-api.env
  echo "   !! 请编辑 /etc/quickcome/lead-api.env，填写 SMTP 账号和收件邮箱"
fi
[ -f /etc/quickcome/backup.key ] || (umask 077 && openssl rand -base64 48 > /etc/quickcome/backup.key)

echo "==> 4/8 SSH 加固（只允许密钥登录，禁止 root 登录）"
cat > /etc/ssh/sshd_config.d/90-quickcome.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "==> 5/8 防火墙与 fail2ban"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban

echo "==> 6/8 Nginx 配置"
install -m 644 "$DEPLOY/nginx/quickcome-http.conf" /etc/nginx/conf.d/quickcome-http.conf
install -m 644 "$DEPLOY/nginx/quickcome-site.conf" /etc/nginx/snippets/quickcome-site.conf
install -m 644 "$DEPLOY/nginx/quickcome-ssl.conf" /etc/nginx/snippets/quickcome-ssl.conf
[ -f /etc/nginx/snippets/cloudflare-realip.conf ] || echo "# 由 update-cloudflare-ips.sh 生成" > /etc/nginx/snippets/cloudflare-realip.conf
rm -f /etc/nginx/sites-enabled/default
render() { sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__ALT_DOMAIN__/${ALT_DOMAIN:-$DOMAIN}/g" "$1"; }
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  render "$DEPLOY/nginx/quickcome-bootstrap.conf.template" > /etc/nginx/sites-available/quickcome.conf
  ln -sf /etc/nginx/sites-available/quickcome.conf /etc/nginx/sites-enabled/quickcome.conf
  nginx -t && systemctl reload nginx

  echo "==> 7/8 申请 Let's Encrypt 证书（DNS 必须已指向本机；Cloudflare 暂时设为'仅 DNS'）"
  DOMAINS=(-d "$DOMAIN" -d "www.$DOMAIN")
  [ -n "$ALT_DOMAIN" ] && DOMAINS+=(-d "$ALT_DOMAIN" -d "www.$ALT_DOMAIN")
  certbot certonly --webroot -w /var/www/letsencrypt "${DOMAINS[@]}" \
    --cert-name "$DOMAIN" --email "$ADMIN_EMAIL" --agree-tos --non-interactive
fi
render "$DEPLOY/nginx/quickcome.conf.template" > /etc/nginx/sites-available/quickcome.conf
ln -sf /etc/nginx/sites-available/quickcome.conf /etc/nginx/sites-enabled/quickcome.conf
# 证书续期后自动重新加载 Nginx
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
# 还没有发布过网站时，先放一个占位页，保证 Nginx 能正常启动
if [ ! -e /var/www/quickcome/current ]; then
  install -d /var/www/quickcome/releases/placeholder
  echo '<!doctype html><title>Quick Come</title><p>Coming soon.</p>' > /var/www/quickcome/releases/placeholder/index.html
  cp /var/www/quickcome/releases/placeholder/index.html /var/www/quickcome/releases/placeholder/404.html
  ln -sfn /var/www/quickcome/releases/placeholder /var/www/quickcome/current
fi
nginx -t && systemctl reload nginx

echo "==> 8/8 systemd 服务与备份定时任务"
install -m 644 "$DEPLOY/systemd/quickcome-lead-api.service" /etc/systemd/system/
install -m 644 "$DEPLOY/systemd/quickcome-backup.service" /etc/systemd/system/
install -m 644 "$DEPLOY/systemd/quickcome-backup.timer" /etc/systemd/system/
install -m 755 "$HERE/backup-leads.sh" /usr/local/sbin/quickcome-backup-leads.sh
install -m 755 "$HERE/update-cloudflare-ips.sh" /usr/local/sbin/quickcome-update-cloudflare-ips.sh
systemctl daemon-reload
systemctl enable quickcome-lead-api.service
systemctl enable --now quickcome-backup.timer

echo "完成。下一步：编辑 /etc/quickcome/lead-api.env，然后在本地执行 deploy.sh 发布。"
