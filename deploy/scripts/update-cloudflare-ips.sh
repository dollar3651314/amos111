#!/usr/bin/env bash
# 从 Cloudflare 官方地址拉取 IP 段，生成 Nginx 真实 IP 配置。
# 加 --lock-firewall 参数时，同时把 80 和 443 端口限制为只允许 Cloudflare 访问。
# 仅在 DNS 已切换到 Cloudflare 代理（橙色云朵）之后执行。
set -euo pipefail
v4="$(curl -fsS https://www.cloudflare.com/ips-v4)"
v6="$(curl -fsS https://www.cloudflare.com/ips-v6)"
[ -n "$v4" ] && [ -n "$v6" ] || { echo "拉取 Cloudflare IP 段失败"; exit 1; }
{
  echo "# 由 update-cloudflare-ips.sh 于 $(date -u +%F) 生成"
  for ip in $v4 $v6; do echo "set_real_ip_from $ip;"; done
  echo "real_ip_header CF-Connecting-IP;"
} > /etc/nginx/snippets/cloudflare-realip.conf
nginx -t && systemctl reload nginx
echo "Nginx 真实 IP 配置已更新"

if [ "${1:-}" = "--lock-firewall" ]; then
  ufw delete allow 80/tcp || true
  ufw delete allow 443/tcp || true
  for ip in $v4 $v6; do
    ufw allow proto tcp from "$ip" to any port 80,443 comment cloudflare >/dev/null
  done
  echo "防火墙已限制：80、443 只允许 Cloudflare 访问"
fi
