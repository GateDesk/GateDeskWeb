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
// REST
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'GateDesk API', time: new Date().toISOString() });
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
    device = { id: String(id), password: '', state: 'online', lastSeen: Date.now(), messages: [] };
    devices.set(device.id, device);
  }
  device.password = String(password || '');
  device.lastSeen = Date.now();
  if (device.state === 'ended') device.state = 'online';
  broadcastState(device);
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
  res.json({ ok: true, device: toPublic(device) });
});

// 运维端点「开始协助」：requested → assisting，下发受控端连接凭据。
app.post('/api/request/start', (req, res) => {
  const device = getDevice((req.body || {}).deviceId);
  if (!device) return res.status(404).json({ ok: false, error: '设备不存在或已下线' });
  if (device.state !== 'requested') return res.status(409).json({ ok: false, error: '设备尚未请求协助或已在进行中' });
  device.state = 'assisting';
  broadcast(device.id, { type: 'control-started', deviceId: device.id });
  broadcastState(device);
  res.json({ ok: true, id: device.id, password: device.password || '' });
});

// 超管「强制控制」：任意 online 设备 → assisting（无需用户点「请求协助」）。
app.post('/api/device/force-control', (req, res) => {
  const { deviceId, role } = req.body || {};
  if (role !== 'superadmin') return res.status(403).json({ ok: false, error: '仅超级管理员可强制控制' });
  const device = getDevice(deviceId);
  if (!device) return res.status(404).json({ ok: false, error: '设备不存在或已下线' });
  if (device.state === 'assisting') return res.status(409).json({ ok: false, error: '协助已在进行中' });
  device.state = 'assisting';
  broadcast(device.id, { type: 'control-started', deviceId: device.id });
  broadcastState(device);
  res.json({ ok: true, id: device.id, password: device.password || '' });
});

// 任一端结束：assisting/requested → online，通知对端。
app.post('/api/request/end', (req, res) => {
  const { deviceId, by } = req.body || {};
  const device = getDevice(deviceId);
  if (!device) return res.status(404).json({ ok: false, error: '设备不存在或已下线' });
  if (device.state === 'online') return res.json({ ok: true, device: toPublic(device) });
  device.state = 'online';
  broadcast(device.id, { type: 'peer-ended', deviceId: device.id, by: by || 'operator' });
  broadcast(device.id, { type: 'control-ended', deviceId: device.id });
  broadcastState(device);
  res.json({ ok: true, device: toPublic(device) });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/employee', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

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
});
