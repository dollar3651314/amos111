#!/usr/bin/env bash
# 部署后验证（可以在任何能访问外网的机器上执行）：
#   bash deploy/scripts/verify.sh https://quickcomepay.com
set -uo pipefail
BASE="${1:?需要站点地址，例如 https://quickcomepay.com}"
HOST="${BASE#https://}"; HOST="${HOST%%/*}"
fail=0
check() { if eval "$2"; then echo "  ✅ $1"; else echo "  ❌ $1"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

echo "验证 $BASE"
for p in / /solutions/ /how-it-works/ /security/ /about/ /contact/ /privacy/ /terms/; do
  check "EN $p 返回 200" "[ \"\$(code '$BASE$p')\" = 200 ]"
  check "ZH /zh$p 返回 200" "[ \"\$(code '$BASE/zh$p')\" = 200 ]"
done
check "不存在的页面返回 404" "[ \"\$(code '$BASE/no-such-page/')\" = 404 ]"
check "sitemap.xml 可访问" "[ \"\$(code '$BASE/sitemap.xml')\" = 200 ]"
check "robots.txt 可访问" "[ \"\$(code '$BASE/robots.txt')\" = 200 ]"
check "/api/health 正常" "curl -fsS --max-time 10 '$BASE/api/health' | grep -q '\"ok\":true'"
check "HTTP 跳转 HTTPS（301）" "[ \"\$(code 'http://$HOST/')\" = 301 ]"
check "响应头包含 HSTS" "curl -sI --max-time 10 '$BASE/' | grep -qi '^strict-transport-security'"
check "响应头包含 CSP" "curl -sI --max-time 10 '$BASE/' | grep -qi '^content-security-policy'"
check "证书有效且剩余天数 > 14 天" "echo | openssl s_client -servername '$HOST' -connect '$HOST:443' 2>/dev/null | openssl x509 -noout -checkend 1209600 >/dev/null"
exit $fail
