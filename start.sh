#!/usr/bin/env bash
# GateDesk 运维端（服务端）启动脚本（macOS）
#
# 职责（对应设计文档 6.1，作为「一套服务端」部署在运维机）：
#   1. 确保本地 HTTP API 已配置 api-token（无则生成并写入 GateDesk2.toml [options]）。
#   2. 启动 GateDesk（GateDesk.app 与脚本同级目录，或 target/ 下）。
#   3. 启动/复用 node 服务端 server.js。
#   4. 打印 用户端(发给用户机) 与 运维端(本机) 两个带一次性票据的地址。
#   5. 打开运维端后台  http://<ip>:3000/admin?ticket=<一次性票据>
#
# 用法:
#   start.sh [admin|employee|both]    默认 admin（运维端）
#
# 说明:
#   - 服务端只此一套（server.js）；用户机用 start-client.sh（写 token + 启动受控端 GateDesk）。
#   - api-token 在 GateDesk 启动时缓存，首次生成后若 GateDesk 已运行需重启一次才生效。
#   - api-token 不再进页面 URL：start 脚本向服务端要一次性票据（POST /api/launch），
#     页面用票据换 HttpOnly 会话，token 只在内存中使用。
set -euo pipefail

MODE="${1:-admin}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/Library/Preferences/com.carriez.GateDesk/GateDesk2.toml"
PORT="${PORT:-3000}"
SERVER_URL="http://localhost:${PORT}"
BROWSER="${BROWSER:-open}"

# 对外局域网地址（发给用户机的链接用）；SERVER_URL 仍指本机 localhost 做健康检查。
# 可 export HOST_IP=... 覆盖。
detect_ip() {
  local ip=""
  for i in en0 en1 en2; do ip="$(ipconfig getifaddr "$i" 2>/dev/null)"; [ -n "$ip" ] && { echo "$ip"; return 0; }; done
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; [ -n "$ip" ] && { echo "$ip"; return 0; }
  ip="$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -v '^127' | head -1)"; [ -n "$ip" ] && { echo "$ip"; return 0; }
  echo "127.0.0.1"
}
HOST_IP="${HOST_IP:-$(detect_ip)}"

# GateDesk.app 候选位置（脚本同级优先，其次 release/debug
APP=""
for cand in \
  "$DIR/GateDesk.app" \
  "$DIR/GateDesk/target/release/GateDesk.app" \
  "$DIR/GateDesk/target/debug/GateDesk.app"; do
  if [ -d "$cand" ]; then APP="$cand"; break; fi
done

# ---- 1. api-token ---------------------------------------------------------
mkdir -p "$(dirname "$CFG")"
NEW_TOKEN=0
token="$(sed -n "s/^api-token *= *'\([^']*\)'.*/\1/p" "$CFG" 2>/dev/null | head -1 || true)"
if [ -z "$token" ]; then
  NEW_TOKEN=1
  token="$(openssl rand -hex 16)"
  if grep -q '^\[options\]' "$CFG"; then
    # 在 [options] 表内追加，绝不新增重复 [options] 表头（会导致 TOML 解析失败）。
    # 若表后有其他节，插到其后；[options] 是最后一节则追加到文件末尾。
    tmp="$(mktemp)"
    awk -v t="$token" '
      /^\[options\]/ { print; inopts=1; next }
      /^\[/ && inopts && !done { print "api-token = \x27" t "\x27"; done=1; inopts=0 }
      { print }
      END { if (inopts && !done) print "api-token = \x27" t "\x27" }
    ' "$CFG" > "$tmp" && mv "$tmp" "$CFG"
  else
    printf '\n[options]\napi-token = '"'%s'"'\n' "$token" >> "$CFG"
  fi
  echo "已生成 api-token 并写入：$CFG"
  echo "若 GateDesk 已在运行，请先退出并重新启动一次，token 才会生效；否则本地 API 返回 401。"
fi

# ---- 2. GateDesk 客户端 ----------------------------------------------------
if [ -n "$APP" ]; then
  if ! pgrep -q -f "$APP/Contents/MacOS/gatedesk"; then
    echo "启动 GateDesk：$APP"
    "$BROWSER" "$APP"
  else
    echo "GateDesk 已在运行，跳过启动。"
  fi
else
  echo "未找到 GateDesk.app（先运行 res/macos-app/make-gatedesk-app.sh），跳过启动客户端。"
fi

# ---- 3. node 服务端 --------------------------------------------------------
if curl -fsS "$SERVER_URL/api/health" >/dev/null 2>&1; then
  echo "服务端已在运行：$SERVER_URL"
  if [ "$NEW_TOKEN" = "1" ]; then
    echo "注意：本次新生成/变更了 api-token；若服务端不是用它启动的，请重启服务端后再继续（token 由启动时缓存）。"
  fi
else
  echo "启动服务端：node $DIR/server.js （后台）"
  (cd "$DIR" && nohup env API_TOKEN="$token" node server.js >/tmp/gatedesk-server.log 2>&1 &)
  sleep 1
fi

# ---- 4. 向服务端要一次性票据，打开运维端后台 -------------------------------
# 票据单次有效、5 分钟过期；token 不再出现在 URL / 浏览器历史里。
mint_ticket() {
  curl -fsS -X POST "$SERVER_URL/api/launch" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["ticket"])' 2>/dev/null
}
ticket_admin="$(mint_ticket)"
ticket_emp="$(mint_ticket)"
if [ -z "$ticket_admin" ] || [ -z "$ticket_emp" ]; then
  echo "错误：无法从服务端获取启动票据。确认 server.js 已启动且带 API_TOKEN（直接 node 运行时兜底读配置）。" >&2
  exit 1
fi

case "$MODE" in
  employee) "$BROWSER" "http://${HOST_IP}:${PORT}/employee?ticket=${ticket_emp}";;
  *)        "$BROWSER" "http://${HOST_IP}:${PORT}/admin?ticket=${ticket_admin}";;   # 默认只开运维端
esac
echo "用户端（两种方式二选一）："
echo "  a) 在用户机运行 start-client.sh <token> <运维机IP>（推荐，自动签发用户页票据）"
echo "  b) 直接打开（5 分钟内有效，一次性）：http://${HOST_IP}:${PORT}/employee?ticket=${ticket_emp}"
echo "运维端后台："
echo "  http://${HOST_IP}:${PORT}/admin?ticket=${ticket_admin}"
