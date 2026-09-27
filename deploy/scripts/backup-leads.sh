#!/usr/bin/env bash
# 每日加密备份线索文件，保留 30 天。由 quickcome-backup.timer 触发。
# 解密：openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/etc/quickcome/backup.key -in <备份文件> -out leads.jsonl
set -euo pipefail
SRC=/var/lib/quickcome/leads.jsonl
DST=/var/backups/quickcome
KEY=/etc/quickcome/backup.key
[ -f "$SRC" ] || { echo "没有线索文件，跳过"; exit 0; }
umask 077
out="$DST/leads-$(date -u +%Y%m%d).jsonl.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY" -in "$SRC" -out "$out"
find "$DST" -name 'leads-*.jsonl.enc' -mtime +30 -delete
echo "备份完成：$out"
