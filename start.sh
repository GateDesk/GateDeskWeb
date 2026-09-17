#!/usr/bin/env bash
# GateDesk 运维机启动脚本（macOS）
# 1) 确保本机 GateDesk 配置里有 api-token（无则生成）；后台页靠它调用本机 21120，故必须保留。
# 2) 启动 GateDesk、启动 server.js（带 token）。
# 3) 打开后台 /admin?token=...（页面用它调本机 21120，远程控制可用）。
# 注：token 进 URL，页面直连本机 21120。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/Library/Preferences/com.carriez.GateDesk/GateDesk2.toml"
PORT="${PORT:-3000}"
SERVER_URL="http://localhost:${PORT}"
BROWSER="${BROWSER:-open}"

# 确保 [options] 表里有 key = 'value'；有 [options] 时插表头后，没有则追加新表
ensure_option() {
  local key="$1" val="$2"
  if grep -q "^${key}[[:space:]]*=" "$CFG" 2>/dev/null; then return; fi
  mkdir -p "$(dirname "$CFG")"
  if grep -q '^\[options\]' "$CFG" 2>/dev/null; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" '
      /^\[options\]/ { print; print k " = \x27" v "\x27"; next }
      { print }' "$CFG" > "$tmp" && mv "$tmp" "$CFG"
  else
    printf '\n[options]\n%s = '"'"'%s'"'"'\n' "$key" "$val" >> "$CFG"
  fi
}

# token：无则生成；CORS：放行后台页来源（页面要跨源调本机 21120）
NEW_TOKEN=0
token="$(sed -n "s/^api-token *= *'\([^']*\)'.*/\1/p" "$CFG" 2>/dev/null | head -1 || true)"
if [ -z "$token" ]; then
  NEW_TOKEN=1
  token="$(openssl rand -hex 16)"
  ensure_option "api-token" "$token"
  echo "已生成 api-token；若 GateDesk 正在运行需重启一次才生效"
fi
ensure_option "api-cors-origin" "$SERVER_URL"

# 启动 GateDesk
APP=""
for cand in "$DIR/GateDesk.app" "$DIR/GateDesk/target/release/GateDesk.app" "$DIR/GateDesk/target/debug/GateDesk.app"; do
  [ -d "$cand" ] && { APP="$cand"; break; }
done
if [ -n "$APP" ]; then
  if ! pgrep -q -f "$APP/Contents/MacOS/gatedesk"; then
    echo "启动 GateDesk：$APP"
    "$BROWSER" "$APP"
  else
    echo "GateDesk 已在运行"
  fi
else
  echo "未找到 GateDesk.app（先运行 res/macos-app/make-gatedesk-app.sh）"
fi

# 启动 server.js（带 token 启动，启动时缓存）
if curl -fsS "$SERVER_URL/api/health" >/dev/null 2>&1; then
  echo "服务端已在运行：$SERVER_URL"
  [ "$NEW_TOKEN" = "1" ] && echo "注意：api-token 刚变更，请重启服务端让它用新 token 启动"
else
  echo "启动服务端：server.js"
  (cd "$DIR" && nohup env API_TOKEN="$token" node server.js >/tmp/gatedesk-server.log 2>&1 &)
  sleep 1
fi

# 打开运维端后台（token 直接进 URL，页面用它调本机 21120）
"$BROWSER" "$SERVER_URL/admin?token=${token}"