// GateDesk 服务端 —— 设备中心状态机（设计文档 1.1，2026-09-04 迭代）
//
// 角色：用户端 = 客户（受控）；运维端 = 公司内部运维人员（控制）；超级管理员 = 可强制控制的运维。
// 模型：以「设备」为中心。用户端 GateDesk 启动后网页自动读本机 ID 并上报（上线）；
//       用户点「请求协助」→ 设备进入 requested；运维点「开始协助」或超管「强制控制」→ assisting；
//       结束后回到 online。全程无需手填 GateDesk ID。
// 内存态 PoC：不含持久化 / 真实认证 / 审计 / 限流；「超级管理员」角色由前端声明，服务端仅做弱校验。
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// API token：页面用它调用本机 GateDesk 本地 API（127.0.0.1:21120）。优先取环境变量
// （start.sh 启动时传入），否则兜底从 GateDesk 配置读取，便于直接 `node server.js`。
function readTokenFromConfig() {
  try {
    const fs = require('fs');
    const toml = fs.readFileSync(
      path.join(process.env.HOME || '', 'Library', 'Preferences', 'com.carriez.GateDesk', 'GateDesk2.toml'),
      'utf8',
    );
    const m = toml.match(/^api-token\s*=\s*'([^']*)'/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}
const API_TOKEN = process.env.API_TOKEN || readTokenFromConfig();

// 一次性启动票据 + 会话：start.sh / start-client.sh 经 POST /api/launch 取票据放进
// 页面 URL，页面用它换 HttpOnly 会话 cookie，token 不再以明文出现在 URL / 历史里。
const tickets = new Map();  // ticket -> { expiresAt }
const sessions = new Map(); // sid -> { token, expiresAt }
const TICKET_TTL = 5 * 60 * 1000;
const SESSION_TTL = 12 * 60 * 60 * 1000;

function parseCookies(req) {
  const out = {};
  for (const part of ((req.headers && req.headers.cookie) || '').split(';')) {
    const i = part.indexOf('=');
    if (i >= 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionByReq(req) {
  const sid = parseCookies(req).gd_session;
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(sid); return null; }
  return s;
}

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 设备中心状态机
//   online ──(request/create 用户点「请求协助」)──▶ requested
//   requested ──(request/start 运维点「开始协助」)──▶ assisting
//   online ──(device/force-control 超管「强制控制」)──▶ assisting
//   assisting ──(request/end 任一端结束)──▶ online
// 状态只由服务端转换，客户端仅提交意图。
// ---------------------------------------------------------------------------
const devices = new Map(); // deviceId -> { id, password, state, lastSeen, messages[] }
const wsRooms = new Map(); // deviceId -> Set<ws>

function getDevice(id) {
  const d = devices.get(id || '');
  return d && d.state !== 'ended' ? d : null;
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(deviceId, obj) {
  const room = wsRooms.get(deviceId);
  if (!room) return;
  for (const ws of room) if (ws.readyState === 1) sendJson(ws, obj);
}

function statePayload(device) {
  return { type: 'session-state', state: device.state, deviceId: device.id };
}

function broadcastState(device) {
  broadcast(device.id, statePayload(device));
}

function joinRoom(deviceId, ws) {
  if (!wsRooms.has(deviceId)) wsRooms.set(deviceId, new Set());
  wsRooms.get(deviceId).add(ws);
}

function leaveRoom(deviceId, ws) {
  const room = wsRooms.get(deviceId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) wsRooms.delete(deviceId);
}

function toPublic(device) {
  return { id: device.id, state: device.state, lastSeen: device.lastSeen };
}

// ---------------------------------------------------------------------------
// 审计（PoC /api/audit 接收端）
//   桌面端操作级事件经 [options] audit-server-url 转发到本端点；服务端自身也会
//   记录会话编排动作（assist.start / assist.end / ...）作为补充。内存态 + 封顶，
//   仅用于验证桌面端审计链路，不构成产品交付。
// ---------------------------------------------------------------------------
const auditLog = []; // {action, actor, device_id, session_id, ts, result, extra, receivedAt}
const AUDIT_LOG_CAP = 5000;

function audit(ev) {
  const rec = {
    action: String((ev && ev.action) || 'unknown').slice(0, 64),
    actor: String((ev && ev.actor) || '').slice(0, 64),
    device_id: String((ev && ev.device_id) || '').slice(0, 128),
    session_id: Number(ev && ev.session_id) || 0,
    ts: Number(ev && ev.ts) || Date.now(),
    result: String((ev && ev.result) || '').slice(0, 64),
    extra: (ev && ev.extra) || {},
    receivedAt: Date.now(),
  };
  auditLog.push(rec);
  if (auditLog.length > AUDIT_LOG_CAP) auditLog.splice(0, auditLog.length - AUDIT_LOG_CAP);
  console.log(`[audit] ${rec.action} actor=${rec.actor} device=${rec.device_id} session=${rec.session_id} result=${rec.result}`);
}

function parseAuditBody(body) {
  let list;
  if (Array.isArray(body)) list = body;
  else if (body && typeof body === 'object') list = [body];
  // 兼容桌面端逐行 JSON 上报（body 可能是 JSON Lines 字符串）。
  else if (typeof body === 'string' && body.trim()) {
    list = [];
    for (const line of body.split(/\n+/)) {
      const l = line.trim();
      if (!l) continue;
      try { list.push(JSON.parse(l)); } catch { /* 跳过坏行 */ }
    }
  } else list = [];
  // 丢弃没有 action 的条目（例如 express.json 把空载荷解析成 {}），否则空请求会
  // 变成一条 action=unknown 的伪事件，污染审计流水。
  return list.filter((ev) => ev && typeof ev === 'object' && String(ev.action || '').trim());
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'GateDesk API', time: new Date().toISOString() });
});

// 启动脚本获取一次性票据（未鉴权；token 只用于各机 loopback 21120，不跨机直接可达）。
app.post('/api/launch', (req, res) => {
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { expiresAt: Date.now() + TICKET_TTL });
  res.json({ ok: true, ticket });
});

// 页面首次加载：用一次性票据换 HttpOnly 会话 cookie + 本机 API token。
app.post('/api/auth/exchange', (req, res) => {
  const ticket = String((req.body || {}).ticket || '');
  const t = tickets.get(ticket);
  if (!t || Date.now() > t.expiresAt) {
    tickets.delete(ticket);
    return res.status(401).json({ ok: false, error: '票据无效或已过期' });
  }
  tickets.delete(ticket); // 单次有效
  if (!API_TOKEN) {
    return res.status(500).json({ ok: false, error: '服务端未配置 API_TOKEN' });
  }
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { token: API_TOKEN, expiresAt: Date.now() + SESSION_TTL });
  res.setHeader(
    'Set-Cookie',
    `gd_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
  );
  res.json({ ok: true, token: API_TOKEN });
});

// 刷新 / 后续请求：凭会话 cookie 取本机 API token。
app.get('/api/me', (req, res) => {
  const s = sessionByReq(req);
  if (!s) return res.status(401).json({ ok: false, error: '未登录或会话已过期' });
  res.json({ ok: true, token: s.token });
});

// 登录：声明角色。user=客户；operator=运维；superadmin=超级管理员（可强制控制）。
app.post('/api/auth/login', (req, res) => {
  const role = req.body && req.body.role;
  if (!['user', 'operator', 'superadmin'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'role 必须是 user / operator / superadmin' });
  }
  res.json({ ok: true, role });
});

// 用户端自动上线：上报本机 ID 与连接密码。幂等；重复上报仅刷新密码与在线时间，不打断进行中的协助。
app.post('/api/device/register', (req, res) => {
  const { id, password } = req.body || {};
  if (!id || !/^[A-Za-z0-9-]{1,128}$/.test(String(id))) {
    return res.status(400).json({ ok: false, error: 'id 非法' });
  }
  let device = devices.get(String(id));
  if (!device) {
    device = { id: String(id), password: '', state: 'online', lastSeen: Date.now(), messages: [], sessionId: null };
    devices.set(device.id, device);
  }
  device.password = String(password || '');
  device.lastSeen = Date.now();
  if (device.state === 'ended') device.state = 'online';
  broadcastState(device);
  audit({ action: 'device.register', actor: 'device', device_id: device.id, result: 'ok' });
  res.json({ ok: true, device: toPublic(device) });
});

// 运维端/超管列出全部设备（含状态：online/requested/assisting）。
app.get('/api/devices', (req, res) => {
  const list = [...devices.values()]
    .sort((a, b) => a.lastSeen - b.lastSeen)
    .map(toPublic);
  res.json({ ok: true, devices: list });
});

// 用户端点「请求协助」：online → requested。
app.post('/api/request/create', (req, res) => {
  const device = getDevice((req.body || {}).deviceId);
  if (!device) return res.status(404).json({ ok: false, error: '设备不存在或已下线' });
  if (device.state === 'requested') return res.json({ ok: true, device: toPublic(device) });
  if (device.state === 'assisting') return res.status(409).json({ ok: false, error: '协助已在进行中' });
  device.state = 'requested';
  broadcastState(device);
  audit({ action: 'auth.request', actor: 'customer', device_id: device.id, result: 'ok' });
  res.json({ ok: true, device: toPublic(device) });
});

// 运维端点「开始协助」：requested → assisting，下发受控端连接凭据。
app.post('/api/request/start', (req, res) => {
  const device = getDevice((req.body || {}).deviceId);
  if (!device) return res.status(404).json({ ok: false, error: '设备不存在或已下线' });
  if (device.state !== 'requested') return res.status(409).json({ ok: false, error: '设备尚未请求协助或已在进行中' });
  device.state = 'assisting';
  device.sessionId = crypto.randomUUID();
  broadcast(device.id, { type: 'control-started', deviceId: device.id });
  broadcastState(device);
  audit({ action: 'connect.start', actor: 'operator', device_id: device.id, session_id: device.sessionId, result: 'ok', extra: { via: 'request/start' } });
  res.json({ ok: true, id: device.id, password: device.password || '', sessionId: device.sessionId });
});

// 超管「强制控制」：任意 online 设备 → assisting（无需用户点「请求协助」）。
app.post('/api/device/force-control', (req, res) => {
  const { deviceId, role } = req.body || {};
  if (role !== 'superadmin') return res.status(403).json({ ok: false, error: '仅超级管理员可强制控制' });
  const device = getDevice(deviceId);
  if (!device) return res.status(404).json({ ok: false, error: '设备不存在或已下线' });
  if (device.state === 'assisting') return res.status(409).json({ ok: false, error: '协助已在进行中' });
  device.state = 'assisting';
  device.sessionId = crypto.randomUUID();
  broadcast(device.id, { type: 'control-started', deviceId: device.id });
  broadcastState(device);
  audit({ action: 'connect.start', actor: 'superadmin', device_id: device.id, session_id: device.sessionId, result: 'ok', extra: { via: 'force-control' } });
  res.json({ ok: true, id: device.id, password: device.password || '', sessionId: device.sessionId });
});

// 任一端结束：assisting/requested → online，通知对端。
app.post('/api/request/end', (req, res) => {
  const { deviceId, by } = req.body || {};
  const device = getDevice(deviceId);
  if (!device) return res.status(404).json({ ok: false, error: '设备不存在或已下线' });
  if (device.state === 'online') return res.json({ ok: true, device: toPublic(device) });
  const sid = device.sessionId || 0;
  device.state = 'online';
  device.sessionId = null;
  broadcast(device.id, { type: 'peer-ended', deviceId: device.id, by: by || 'operator' });
  broadcast(device.id, { type: 'control-ended', deviceId: device.id });
  broadcastState(device);
  audit({ action: 'connect.close', actor: by || 'operator', device_id: device.id, session_id: sid, result: 'ok' });
  res.json({ ok: true, device: toPublic(device) });
});

// 审计查询（辅助验证用）：可选 ?action=&deviceId=&limit= 过滤。
app.get('/api/audit', (req, res) => {
  const action = String(req.query.action || '');
  const deviceId = String(req.query.deviceId || '');
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '200'), 10) || 200, 1), 5000);
  let list = auditLog;
  if (action) list = list.filter((e) => e.action === action);
  if (deviceId) list = list.filter((e) => e.device_id === deviceId);
  res.json({ ok: true, total: list.length, events: list.slice(-limit) });
});

// 桌面端 / 页面上报审计事件（单条对象 / 数组 / JSON Lines 均可）。
app.post('/api/audit', (req, res) => {
  const events = parseAuditBody(req.body);
  if (events.length === 0) return res.status(400).json({ ok: false, error: '空或无法解析的审计载荷' });
  for (const ev of events) audit(ev);
  res.json({ ok: true, count: events.length });
});

// 清空审计缓冲（闭环自测 / 演示用）。
app.post('/api/audit/clear', (req, res) => {
  const cleared = auditLog.length;
  auditLog.length = 0;
  res.json({ ok: true, cleared });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/employee', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'audit.html')));

// ---------------------------------------------------------------------------
// WebSocket：/ws?deviceId=...&role=user|operator|superadmin
// 同一设备的 user 与 operator 同处一个房间，聊天与状态在此中继。
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const deviceId = url.searchParams.get('deviceId') || '';
  const role = url.searchParams.get('role') || 'user';
  const device = getDevice(deviceId);
  if (!device) {
    ws.close(1008, 'bad device');
    return;
  }

  ws.role = role;
  ws.deviceId = deviceId;
  joinRoom(deviceId, ws);

  sendJson(ws, { type: 'history', messages: device.messages });
  sendJson(ws, statePayload(device));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || msg.type !== 'chat') return;
    const text = String(msg.text || '').trim().slice(0, 1000);
    if (!text) return;
    const isOperator = role === 'operator' || role === 'superadmin';
    const entry = {
      from: String(msg.from || (isOperator ? '运维' : '客户')).slice(0, 50),
      role: isOperator ? 'operator' : 'user',
      text,
      at: Date.now(),
    };
    device.messages.push(entry);
    if (device.messages.length > 500) device.messages.splice(0, device.messages.length - 500);
    const out = JSON.stringify({ type: 'chat', message: entry });
    const room = wsRooms.get(deviceId);
    if (room) for (const s of room) if (s.readyState === 1) s.send(out);
  });

  ws.on('close', () => leaveRoom(deviceId, ws));
});

server.listen(PORT, () => {
  console.log(`GateDesk running at http://localhost:${PORT}`);
  console.log(`User page:      http://localhost:${PORT}/employee`);
  console.log(`Operator page:  http://localhost:${PORT}/admin`);
  console.log(`Audit console:  http://localhost:${PORT}/audit`);
});


