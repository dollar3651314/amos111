#!/usr/bin/env bash
# 线上冒烟测试（v2 · Vercel）：在任何能访问外网的机器上执行。
#   bash e2e/smoke-prod.sh https://quickcomepay.com              # 基本检查
#   bash e2e/smoke-prod.sh https://quickcomepay.com --ratelimit  # 另外验证限流（会占用本机 IP 10 分钟的提交额度；只发非法请求，不产生线索）
set -uo pipefail
BASE="${1:?需要站点地址，例如 https://quickcomepay.com}"
HOST="${BASE#https://}"; HOST="${HOST%%/*}"
fail=0
check() { if eval "$2"; then echo "  ✅ $1"; else echo "  ❌ $1"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

echo "冒烟测试 $BASE"
for p in / /solutions/ /how-it-works/ /security/ /about/ /contact/ /privacy/ /terms/; do
  check "EN $p 返回 200" "[ \"\$(code '$BASE$p')\" = 200 ]"
  check "ZH /zh$p 返回 200" "[ \"\$(code '$BASE/zh$p')\" = 200 ]"
done
check "不存在的页面返回 404" "[ \"\$(code '$BASE/no-such-page/')\" = 404 ]"
check "sitemap.xml、robots.txt 可访问" "[ \"\$(code '$BASE/sitemap.xml')\" = 200 ] && [ \"\$(code '$BASE/robots.txt')\" = 200 ]"
check "/api/health：存储和邮件都已配置" "curl -fsS --max-time 10 '$BASE/api/health' | grep -q '\"ok\":true'"
check "HTTP 自动跳转 HTTPS（301 或 308）" "[[ \"\$(code 'http://$HOST/')\" =~ ^30[18]$ ]]"
check "响应头包含 HSTS 和 CSP" "h=\$(curl -sI --max-time 10 '$BASE/'); echo \"\$h\" | grep -qi '^strict-transport-security' && echo \"\$h\" | grep -qi '^content-security-policy'"
check "生产环境没有原型标识" "! curl -s --max-time 10 '$BASE/' | grep -q 'data-prototype-banner'"
check "非法提交被服务端拒绝（400）" "[ \"\$(code -X POST -H 'content-type: application/json' -d '{}' '$BASE/api/leads')\" = 400 ]"
check "证书有效且剩余天数 > 14 天" "echo | openssl s_client -servername '$HOST' -connect '$HOST:443' 2>/dev/null | openssl x509 -noout -checkend 1209600 >/dev/null"

if [ "${2:-}" = "--ratelimit" ]; then
  # 上面已经发过 1 次非法请求；再发 4 次，凑满 5 次，第 6 次应该返回 429
  for i in 1 2 3 4; do code -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/leads" >/dev/null; done
  check "限流：同一 IP 第 6 次提交返回 429" "[ \"\$(code -X POST -H 'content-type: application/json' -d '{}' '$BASE/api/leads')\" = 429 ]"
fi
exit $fail
