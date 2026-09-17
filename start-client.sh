#!/usr/bin/env bash
# GateDesk 客户端（用户端/受控端）启动脚本（macOS）
#
# 在【用户机】上运行：
#   1. 把运维端给的 api-token 写入本机 GateDesk 配置（GateDesk2.toml [options]）
#   2. 启动本机 GateDesk（GateDesk.app 与脚本同级目录，或 target/ 下）
#   3. 打开用户页 http://<ip>:3000/employee?token=<token>（页面用它调本机 21120，服务端由此获得本机 GateDesk ID）
#
# 用法:
#   start-client.sh <api-token> [server-ip]
#     api-token : 运维端 start.sh 生成并打印的 token（两机共享同一值，带外传递）
#     server-ip : 运维机局域网 IP（默认 127.0.0.1，单机调试时用）
#
# 注意：api-token 由 GateDesk 启动时缓存，若 GateDesk 已在运行而本次写入/变更了 token，
#       需先退出 GateDesk 再重跑，否则本地 API 返回 401。token 同时用于本机本地 API 与页面 URL。
set -euo pipefail

TOKEN="${1:-}"
SERVER_IP="${2:-127.0.0.1}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/Library/Preferences/com.carriez.GateDesk/GateDesk2.toml"
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

# 审计上报地址：本机（受控端）桌面端操作级事件转发到运维机审计服务端 /api/audit（企业审计 PoC）。
# 与 api-token 同理，GateDesk 启动时读取，写入后若已运行需重启一次生效。
AUDIT_URL="http://${SERVER_IP}:${PORT}/api/audit"
if grep -q '^[[:space:]]*audit-server-url[[:space:]]*=' "$CFG" 2>/dev/null; then
  tmp="$(mktemp)"
  sed "s|^\([[:space:]]*audit-server-url[[:space:]]*=.*\)$|audit-server-url = '${AUDIT_URL}'|" "$CFG" > "$tmp" && mv "$tmp" "$CFG"
elif grep -q '^\[options\]' "$CFG" 2>/dev/null; then
  tmp="$(mktemp)"
  awk -v u="$AUDIT_URL" '
    /^\[options\]/ { print; inopts=1; next }
    /^\[/ && inopts { print "audit-server-url = \x27" u "\x27"; inopts=0 }
    { print }
    END { if (inopts) print "audit-server-url = \x27" u "\x27" }
  ' "$CFG" > "$tmp" && mv "$tmp" "$CFG"
else
  printf '\n[options]\naudit-server-url = '"'"'%s'"'"'\n' "$AUDIT_URL" >> "$CFG"
fi
echo "已写入 audit-server-url（审计转发地址）：$AUDIT_URL"

# CORS 放行来源：本机 employee 页从 http://<SERVER_IP>:PORT 加载并调用本机 21120，
# 与本地 API 的收紧策略（§4.3）配套，把该来源写入 [options] api-cors-origin。
CORS_URL="http://${SERVER_IP}:${PORT}"
if [ -z "$(sed -n "s/^api-cors-origin *= *'\([^']*\)'.*/\1/p" "$CFG" 2>/dev/null | head -1 || true)" ]; then
  if grep -q '^\[options\]' "$CFG" 2>/dev/null; then
    tmp="$(mktemp)"
    awk -v u="$CORS_URL" '
      /^\[options\]/ { print; inopts=1; next }
      /^\[/ && inopts && !done { print "api-cors-origin = \x27" u "\x27"; done=1; inopts=0 }
      { print }
      END { if (inopts && !done) print "api-cors-origin = \x27" u "\x27" }
    ' "$CFG" > "$tmp" && mv "$tmp" "$CFG"
  else
    printf '\n[options]\napi-cors-origin = '"'"'%s'"'"'\n' "$CORS_URL" >> "$CFG"
  fi
  echo "已写入 api-cors-origin（CORS 放行）：$CORS_URL"
fi

# 配置文件含 api-token / audit-server-url / api-cors-origin 等敏感项：收紧为仅属主可读写（类 Unix）。
chmod 0600 "$CFG"

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
# token 直接进 URL，页面用它调本机（受控端）21120 读取本机 ID 并上报。
SERVER_BASE="http://${SERVER_IP}:${PORT}"
URL="${SERVER_BASE}/employee?token=${TOKEN}"
echo "打开用户页：$URL"
"$BROWSER" "$URL"



