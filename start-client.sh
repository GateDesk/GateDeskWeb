#!/usr/bin/env bash
# GateDesk 客户端（用户端/受控端）启动脚本（macOS）
#
# 在【用户机】上运行：
#   1. 把运维端给的 api-token 写入本机 GateDesk 配置（GateDesk2.toml [options]）
#   2. 启动本机 GateDesk（GateDesk.app 与脚本同级目录，或 target/ 下）
#   3. 打开用户页 http://<运维机ip>:3000/employee?token=...（服务端由此获得本机 GateDesk ID）
#
# 用法:
#   start-client.sh <api-token> [server-ip]
#     api-token : 运维端 start.sh 生成并打印的 token（两机共享同一值）
#     server-ip : 运维机局域网 IP（默认 127.0.0.1，单机调试时用）
#
# 注意：api-token 由 GateDesk 启动时缓存，若 GateDesk 已在运行而本次写入/变更了 token，
#       需先退出 GateDesk 再重跑，否则本地 API 返回 401。
set -euo pipefail

TOKEN="${1:-}"
SERVER_IP="${2:-127.0.0.1}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/Library/Application Support/GateDesk/config/GateDesk2.toml"
PORT="${PORT:-3000}"
BROWSER="${BROWSER:-open}"

if [ -z "$TOKEN" ]; then
  echo "用法: start-client.sh <api-token> [server-ip]"
  echo "  api-token : 运维端 start.sh 生成并打印的 token"
  exit 1
fi

# ---- 1. 写入 api-token -----------------------------------------------------
mkdir -p "$(dirname "$CFG")"
if grep -q '^[[:space:]]*api-token[[:space:]]*=' "$CFG" 2>/dev/null; then
  # 已存在：原地替换该行
  tmp="$(mktemp)"
  sed "s|^\([[:space:]]*api-token[[:space:]]*=.*\)$|api-token = '${TOKEN}'|" "$CFG" > "$tmp" && mv "$tmp" "$CFG"
elif grep -q '^\[options\]' "$CFG" 2>/dev/null; then
  # 有 [options] 表但无 api-token：插到表头后（绝不新增重复表头）
  tmp="$(mktemp)"
  awk -v t="$TOKEN" '
    /^\[options\]/ { print; inopts=1; next }
    /^\[/ && inopts { print "api-token = \x27" t "\x27"; inopts=0 }
    { print }
    END { if (inopts) print "api-token = \x27" t "\x27" }
  ' "$CFG" > "$tmp" && mv "$tmp" "$CFG"
else
  # 无 [options]：追加新表
  printf '\n[options]\napi-token = '"'%s'"'\n' "$TOKEN" >> "$CFG"
fi
echo "已写入 api-token：$CFG"

# ---- 2. 启动客户端 GateDesk ------------------------------------------------
APP=""
for cand in \
  "$DIR/GateDesk.app" \
  "$DIR/GateDesk/target/debug/GateDesk.app" \
  "$DIR/GateDesk/target/release/GateDesk.app"; do
  if [ -d "$cand" ]; then APP="$cand"; break; fi
done
if [ -z "$APP" ]; then
  echo "未找到 GateDesk.app（放到脚本同级目录，或先 res/macos-app/make-gatedesk-app.sh 打包）"
else
  if ! pgrep -q -f "$APP/Contents/MacOS/gatedesk"; then
    echo "启动 GateDesk：$APP"
    "$BROWSER" "$APP"
  else
    echo "GateDesk 已在运行，跳过启动。"
  fi
fi

# ---- 3. 打开用户页（服务端由此获得本机 GateDesk ID）-------------------------
URL="http://${SERVER_IP}:${PORT}/employee?token=${TOKEN}"
echo "打开用户页：$URL"
"$BROWSER" "$URL"
