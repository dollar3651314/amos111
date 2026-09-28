#!/usr/bin/env bash
# 测试环境（staging）的自动检查（v5 · agents v0.6 C34）。由 GitHub Actions 执行（.github/workflows/staging-check.yml）。
#   VERCEL_BYPASS_TOKEN=... bash e2e/smoke-staging.sh https://amos111-git-staging-xxx.vercel.app [期望的提交前 7 位]
# 令牌只从环境变量读取（GitHub Secrets），脚本不会输出令牌。
set -uo pipefail
BASE="${1:?需要测试环境地址}"
WANT="${2:-}"
: "${VERCEL_BYPASS_TOKEN:?需要环境变量 VERCEL_BYPASS_TOKEN}"
H=(-H "x-vercel-protection-bypass: $VERCEL_BYPASS_TOKEN")
fail=0
check() { if eval "$2"; then echo "  ✅ $1"; else echo "  ❌ $1"; fail=1; fi; }
# 测试环境所在网络偶尔会断开连接：每个请求最多重试 2 次（只重试连接失败，不重试 HTTP 错误）
req() { curl -s --retry 2 --retry-connrefused --retry-all-errors --max-time 15 "${H[@]}" "$@"; }
code() { req -o /dev/null -w '%{http_code}' "$@"; }

if [ -n "$WANT" ]; then
  echo "等待测试环境部署提交 $WANT ……"
  for i in $(seq 1 60); do
    got=$(req "$BASE/api/health/" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
    [ "$got" = "$WANT" ] && break
    sleep 10
  done
  check "测试环境已部署提交 $WANT（当前：${got:-未知}）" "[ \"$got\" = \"$WANT\" ]"
fi

echo "测试环境检查 $BASE"
health=$(req "$BASE/api/health/")
echo "  健康检查的返回（只有是 / 否，不含配置值）：$health"
check "健康检查：ok 为 true" "echo '$health' | grep -q '\"ok\":true'"
check "健康检查：env 是 staging（不是生产）" "echo '$health' | grep -q '\"env\":\"staging\"'"
for p in / /solutions/ /how-it-works/ /security/ /about/ /contact/ /privacy/ /terms/ /onboarding/ /admin/; do
  check "EN $p 返回 200" "[ \"\$(code '$BASE$p')\" = 200 ]"
done
for p in / /contact/ /onboarding/; do check "ZH /zh$p 返回 200" "[ \"\$(code '$BASE/zh$p')\" = 200 ]"; done
home=$(req "$BASE/")
check "页面有测试环境标识" "echo \"\$home\" | grep -q 'data-staging-banner'"
check "页面没有原型标识" "! echo \"\$home\" | grep -q 'data-prototype-banner'"
check "页面 noindex" "echo \"\$home\" | grep -q 'noindex'"
check "开户页是真实模式（不是原型）" "req '$BASE/onboarding/' | grep -q '&quot;prototype&quot;:false'"
check "响应头包含 CSP" "req -I '$BASE/' | grep -qi '^content-security-policy'"
check "未登录访问后台数据返回 401" "[ \"\$(code '$BASE/api/kyb/?g=admin&a=apps')\" = 401 ]"
check "无效的开户链接返回 404" "[ \"\$(code -H 'x-kyb-token: invalid' '$BASE/api/kyb/?g=onboarding&a=state')\" = 404 ]"
check "跨站请求返回 403" "[ \"\$(code -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{}' '$BASE/api/kyb/?g=admin&a=invite')\" = 403 ]"
check "未知接口分组返回 404" "[ \"\$(code '$BASE/api/kyb/?g=nope&a=me')\" = 404 ]"
check "不存在的接口地址返回 404（BUG-K7 这类问题）" "[ \"\$(code '$BASE/api/admin/me/')\" = 404 ]"
check "官网表单的非法提交被拒绝（400）" "[ \"\$(code -X POST -H 'content-type: application/json' -d '{}' '$BASE/api/leads/')\" = 400 ]"
exit $fail
