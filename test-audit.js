#!/usr/bin/env node
// 审计闭环自测（GateDesk 桌面端 -> GateDeskWeb 审计服务）
//
// 链路：桌面端 audit.rs 把操作级事件 POST 到 [options] audit-server-url
//       （默认 http://<运维机>:3000/api/audit）——> 本服务接收并缓存
//       ——> GET /api/audit 查询 / /audit 页面查看。
//
// 本脚本自带服务端：以独立端口启动 server.js，按桌面端真实请求形态（单条 JSON 对象、
// Content-Type: application/json）上报，然后断言查询结果，最后关闭服务端。
//
// 用法：npm run audit:selftest        （可用 TEST_PORT 覆盖端口，默认 3210）
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.TEST_PORT || 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const DEVICE = `selftest-${Date.now()}`;

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function waitHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '(未尝试)';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务端未在 ${timeoutMs}ms 内就绪：${lastErr}`);
}

async function postAudit(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = await fetch(`${BASE}/api/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function getAudit(query = '') {
  const res = await fetch(`${BASE}/api/audit${query}`);
  return { status: res.status, json: await res.json().catch(() => null) };
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server:err] ${d}`));

  try {
    await waitHealth();
    console.log(`\n审计闭环自测 — 服务端 ${BASE}，测试设备 ${DEVICE}\n`);

    // 1) 桌面端真实上报形态：单个 JSON 对象 + application/json
    //    （src/audit.rs: post_request_sync(url, event.to_string(), "")）
    const desktopEvent = JSON.stringify({
      action: 'voice.on',
      actor: 'operator',
      device_id: DEVICE,
      session_id: 7,
      ts: Date.now(),
      result: 'ok',
      extra: { method: 'http-api' },
    });
    let r = await postAudit(desktopEvent);
    check('POST 单对象（桌面端形态）→ 200 且 count=1', r.status === 200 && r.json && r.json.count === 1, JSON.stringify(r));

    // 2) 批量数组
    r = await postAudit([
      { action: 'record.start', actor: 'operator', device_id: DEVICE, session_id: 7, result: 'ok' },
      { action: 'record.stop', actor: 'operator', device_id: DEVICE, session_id: 7, result: 'ok' },
    ]);
    check('POST 数组 → 200 且 count=2', r.status === 200 && r.json && r.json.count === 2, JSON.stringify(r));

    // 3) 空载荷不得写入伪事件（action=unknown）
    r = await postAudit({});
    check('POST 空对象 → 400', r.status === 400, JSON.stringify(r));
    r = await postAudit('');
    check('POST 空串 → 400', r.status === 400, JSON.stringify(r));

    // 4) 查询与过滤
    let q = await getAudit(`?deviceId=${DEVICE}`);
    check('GET ?deviceId 返回 3 条', q.json && q.json.total === 3, JSON.stringify(q.json && q.json.total));
    check(
      '事件字段完整（action/actor/device_id/session_id/ts/result）',
      !!q.json && q.json.events.every((e) => e.action && e.actor && e.device_id && e.ts != null && 'result' in e),
      JSON.stringify((q.json && q.json.events) || []),
    );
    check(
      '无 action=unknown 伪事件',
      !!q.json && q.json.events.every((e) => e.action !== 'unknown'),
      JSON.stringify((q.json && q.json.events) || []),
    );

    q = await getAudit('?action=record.start');
    check('GET ?action=record.start 命中 1 条', q.json && q.json.total === 1 && q.json.events[0].action === 'record.start', JSON.stringify(q.json && q.json.total));

    // 5) limit 生效
    q = await getAudit('?limit=1');
    check('GET ?limit=1 只返回 1 条', q.json && q.json.events.length === 1, JSON.stringify(q.json && q.json.events.length));

    // 6) 看板页面可达
    const page = await fetch(`${BASE}/audit`);
    check('GET /audit 看板页面 → 200', page.status === 200, `HTTP ${page.status}`);

    // 7) 清空
    const c = await fetch(`${BASE}/api/audit/clear`, { method: 'POST' });
    check('POST /api/audit/clear → 200', c.status === 200, `HTTP ${c.status}`);
    q = await getAudit();
    check('清空后 total=0', q.json && q.json.total === 0, JSON.stringify(q.json && q.json.total));
  } catch (e) {
    failures++;
    console.error(`  FAIL  异常：${e.message}`);
  } finally {
    child.kill();
  }

  console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
