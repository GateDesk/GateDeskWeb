// GateDesk 服务端 —— 设备中心状态机（设计文档 1.1，2026-09-04 迭代）
//
// 角色：用户端 = 客户（受控）；运维端 = 公司内部运维人员（控制）。
// 模型：以「设备」为中心。用户端 GateDesk 启动后网页自动读本机 ID 并上报（上线）；
//       用户点「请求协助」→ 设备进入 requested；运维点「开始协助」→ assisting；
//       结束后回到 online。全程无需手填 GateDesk ID。
// 内存态 PoC：不含持久化 / 真实认证 / 审计 / 限流；角色由前端声明，服务端仅做弱校验。
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// API token：仅供本服务保留的注入值。页面（employee / admin）从 URL 取本机 token，
// 直连各机 loopback 127.0.0.1:21120 调用 GateDesk 本地 API；本服务只做设备中心与审计，
// 不再代发本地 API。API_TOKEN 仅接受启动脚本注入（start.sh 带 token 启动 server），
// 不从配置文件读取——避免服务端自行去翻 GateDesk 配置文件里的 token。
const API_TOKEN = process.env.API_TOKEN || '';

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 设备中心状态机
//   online ──(request/create 用户点「请求协助」)──▶ requested
//   requested ──(request/start 运维点「开始协助」)──▶ assisting
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
  return {
    type: 'session-state',
    state: device.state,
    deviceId: device.id,
  };
}

function broadcastState(device) {
  broadcast(device.id, statePayload(device));
}

function joinRoom(deviceId, ws) {
  if (!wsRooms.has(deviceId)) wsRooms.set(deviceId, new Set());
  wsRooms.get(deviceId).add(ws);
  updateClientOnline(deviceId);
}

function leaveRoom(deviceId, ws) {
  const room = wsRooms.get(deviceId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) wsRooms.delete(deviceId);
  updateClientOnline(deviceId);
}

// 设备是否有在线的「客户端（用户角色）」连接——即本机 employee 页是否开着。
// admin 借它区分「本机作为受控端」与「只有运维端」，以决定是否显示/可否与自身 ID 聊天。
function updateClientOnline(deviceId) {
  const room = wsRooms.get(deviceId);
  const d = devices.get(deviceId);
  if (!d) return;
  d.clientOnline = !!(room && [...room].some((s) => s.role === 'user' && s.readyState === 1));
}

// 受控端心跳间隔 5s；超过该阈值无心跳视为离线（列表据此显示在线/离线）。
const STALE_MS = 15000;

function toPublic(device) {
  return {
    id: device.id,
    state: device.state,
    lastSeen: device.lastSeen,
    clientOnline: !!device.clientOnline,
    online: Date.now() - device.lastSeen < STALE_MS, // 页面/心跳存活
    gdOnline: !!device.gdOnline,                      // GateDesk 是否已登入 rendezvous
    inSession: !!device.inSession,                    // GateDesk 是否在会话中
  };
}

// ---------------------------------------------------------------------------
// 审计（PoC /api/audit 接收端）
//   桌面端操作级事件经 [options] audit-server-url 转发到本端点；服务端自身也会
//   记录会话编排动作（assist.start / assist.end / ...）作为补充。内存态 + 封顶，
//   仅用于验证桌面端审计链路，不构成产品交付。
// ---------------------------------------------------------------------------
const auditLog = []; // {action, actor, device_id, session_id, ts, result, extra, receivedAt}
const AUDIT_LOG_CAP = 5000;

// ---------------------------------------------------------------------------
// 出站事件通知的接收端（接口文档 §6.10）
//   被控端在「有对端等批准 / 有对端申请」时主动 POST 到 /api/event，服务端把它
//   推给该设备房间里的浏览器，页面收到就立即去查本机 GET /sessions。
//
//   与上面审计的区别是刻意的：审计是**记录**（要留、要对账），事件是**提示**
//   （丢了不影响正确性，页面本来就有兜底轮询）。所以这里既不进 auditLog、也不
//   落盘 —— 下面这个小环只为排查与自测方便，重启即空。
// ---------------------------------------------------------------------------
const eventLog = []; // {event, device_id, session_id, peer_id, extra, receivedAt}
const EVENT_LOG_CAP = 200;

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

// 登录：声明角色。user=客户；operator=运维。（PoC 弱校验，仅用于前端文案/布局区分）
app.post('/api/auth/login', (req, res) => {
  const role = req.body && req.body.role;
  if (!['user', 'operator'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'role 必须是 user / operator' });
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
    device = { id: String(id), password: '', state: 'online', lastSeen: Date.now(), messages: [], sessionId: null, clientOnline: false };
    devices.set(device.id, device);
  }
  device.password = String(password || '');
  device.lastSeen = Date.now();
  if (device.state === 'ended') device.state = 'online';
  broadcastState(device);
  audit({ action: 'device.register', actor: 'device', device_id: device.id, result: 'ok' });
  res.json({ ok: true, device: toPublic(device) });
});

// 受控端心跳：受控页每 5s 上报一次，维持 lastSeen（页面存活）并带本机 GateDesk /status 快照。
app.post('/api/device/heartbeat', (req, res) => {
  const device = getDevice((req.body || {}).id);
  if (!device) return res.status(404).json({ ok: false, error: '设备不存在或已下线' });
  device.lastSeen = Date.now();
  device.gdOnline = !!(req.body || {}).online;
  device.inSession = !!(req.body || {}).inSession;
  res.json({ ok: true });
});

// 运维端列出全部设备（含状态：online/requested/assisting）。
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

// 桌面端出站事件通知（接口文档 §6.10）：受控端 POST 一条，服务端广播给页面。
// 成功响应只看 2xx，body 里没有平台要给桌面端的话 —— 桌面端不重试、不看结果。
app.post('/api/event', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: '事件载荷必须是单个对象' });
  }
  const deviceId = String(body.device_id || '');
  const event = String(body.event || '');
  if (!deviceId || !event) {
    return res.status(400).json({ ok: false, error: '缺少 device_id 或 event' });
  }
  const rec = {
    event: event.slice(0, 64),
    device_id: deviceId.slice(0, 128),
    session_id: Number(body.session_id) || 0,
    peer_id: String(body.peer_id || '').slice(0, 128),
    extra: (body.extra && typeof body.extra === 'object') ? body.extra : {},
    receivedAt: Date.now(),
  };
  eventLog.push(rec);
  if (eventLog.length > EVENT_LOG_CAP) eventLog.splice(0, eventLog.length - EVENT_LOG_CAP);
  // 只广播，不替页面做决定：那个申请可能已经被现场的人点了，或已经超时。
  broadcast(rec.device_id, {
    type: 'event',
    event: rec.event,
    deviceId: rec.device_id,
    sessionId: rec.session_id,
    peerId: rec.peer_id,
    extra: rec.extra,
    at: rec.receivedAt,
  });
  console.log(`[event] ${rec.event} device=${rec.device_id} session=${rec.session_id} peer=${rec.peer_id}`);
  res.json({ ok: true });
});

// 查询最近收到的事件（排查 / 自测用）。
app.get('/api/event', (req, res) => {
  const deviceId = String(req.query.deviceId || '');
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), EVENT_LOG_CAP);
  const list = deviceId ? eventLog.filter((e) => e.device_id === deviceId) : eventLog;
  res.json({ ok: true, total: list.length, events: list.slice(-limit) });
});

// ── 本机 GateDesk 本地 API 代理（admin 运维页用）────────────────────────────
// admin 页把本机 token 随请求带来（?token=），服务端校验其与自身 API_TOKEN（env 注入）
// 一致才代发到 127.0.0.1:21120——别人拿不到 token 则 401，代理不再是无鉴权开口。
// 用内置 http 模块而不是 fetch：全局 fetch 要 Node 18+，而本机 `node` 可能是 12
// （实测 /usr/local/bin/node v12.18.2），那时 fetch 未定义，代理会把每个请求都变成
// 502「本机 GateDesk 不可达」—— admin 页的本机功能（/id、/status、/connect、§6.7）一起失效。
function localApiRequest(sub, method, body) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(
      { host: '127.0.0.1', port: 21120, path: sub, method, headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 502, raw }));
      }
    );
    req.on('error', reject);
    // 会话类接口自身有 2 秒上界（§6.7），这里给足余量再放弃，避免请求悬挂。
    req.setTimeout(10000, () => req.destroy(new Error('本机 GateDesk 响应超时')));
    req.end(body);
  });
}

app.all('/api/local/*', async (req, res) => {
  const provided = new URL(req.url, 'http://x').searchParams.get('token') || '';
  if (!API_TOKEN || provided !== API_TOKEN) {
    return res.status(401).json({ ok: false, error: 'token 无效' });
  }
  const sub = req.originalUrl.replace(/^\/api\/local/, ''); // 含原 ?token=，21120 亦按此校验
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {});
  try {
    const r = await localApiRequest(sub, req.method, body);
    let data;
    try { data = JSON.parse(r.raw); } catch { data = r.raw; }
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: '本机 GateDesk 不可达: ' + e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/employee', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'audit.html')));

// ---------------------------------------------------------------------------
// WebSocket：/ws?deviceId=...&role=user|operator
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

  sendJson(ws, { type: 'history', messages: device.messages.filter((m) => m.role !== role) });
  sendJson(ws, statePayload(device));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg) return;
    if (msg.type !== 'chat') return;
    const text = String(msg.text || '').trim().slice(0, 1000);
    if (!text) return;
    const isOperator = role === 'operator';
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
    // 只投递给对端角色（运维↔客户），同角色不互通，避免 admin 自己和自己聊天。
    if (room) for (const s of room) if (s.readyState === 1 && s.role !== role) s.send(out);
  });

  ws.on('close', () => leaveRoom(deviceId, ws));
});

server.listen(PORT, () => {
  console.log(`GateDesk running at http://localhost:${PORT}`);
  console.log(`User page:      http://localhost:${PORT}/employee`);
  console.log(`Operator page:  http://localhost:${PORT}/admin`);
  console.log(`Audit console:  http://localhost:${PORT}/audit`);
});



