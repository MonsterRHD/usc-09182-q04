// 非遗直播货盘协同服务 HTTP 入口。
// 所有写操作都是携带幂等令牌的命令；状态只来自事件日志（EVENT_LOG，默认 data/events.jsonl）。
import { createServer } from 'node:http';
import { EventStore } from './domain/EventStore.mjs';
import { InventoryApp } from './domain/InventoryApp.mjs';
import { DomainError } from './domain/errors.mjs';

export function createApp({ store, clock } = {}) {
  const app = new InventoryApp(store ?? new EventStore(process.env.EVENT_LOG || 'data/events.jsonl'), { clock });

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new DomainError(413, 'PAYLOAD_TOO_LARGE', '请求体过大')); req.destroy(); return; }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new DomainError(400, 'BAD_REQUEST', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });

  const routes = [
    ['POST', /^\/channels$/, (b) => app.registerChannel(b)],
    ['POST', /^\/artworks$/, (b) => app.registerArtwork(b)],
    ['GET', /^\/inventory\/([^/]+)$/, (b, m) => app.inventoryView(m[1])],
    ['POST', /^\/artworks\/([^/]+)\/display-holds$/, (b, m) => app.holdForDisplay({ ...b, code: m[1] })],
    ['POST', /^\/display-holds\/([^/]+)\/release$/, (b, m) => app.releaseDisplay({ holdId: m[1] })],
    ['POST', /^\/adjustments$/, (b) => app.adjustInventory(b)],
    ['GET', /^\/adjustments$/, () => app.listAdjustments()],
    ['POST', /^\/locks$/, (b) => app.requestLock(b)],
    ['POST', /^\/locks\/sweep$/, () => app.sweepExpiredLocks()],
    ['POST', /^\/locks\/([^/]+)\/release$/, (b, m) => app.releaseLock({ ...b, lockId: m[1] })],
    ['GET', /^\/locks$/, (b, _m, url) => app.listLocks({ channel: url.searchParams.get('channel') ?? undefined })],
    ['GET', /^\/queue$/, () => app.listQueue()],
    ['POST', /^\/orders$/, (b) => app.confirmOrder(b)],
    ['GET', /^\/orders\/([^/]+)$/, (b, m) => app.orderView(m[1])],
    ['POST', /^\/orders\/([^/]+)\/ready$/, (b, m) => app.markReady({ ...b, orderId: m[1] })],
    ['POST', /^\/orders\/([^/]+)\/cancel$/, (b, m) => app.cancelOrder({ ...b, orderId: m[1] })],
    ['POST', /^\/orders\/([^/]+)\/shipments$/, (b, m) => app.dispatchShipment({ ...b, orderId: m[1] })],
    ['GET', /^\/pending-shipments$/, () => app.pendingShipments()],
    ['POST', /^\/receipts$/, (b) => app.recordReceipt(b)],
    ['GET', /^\/notifications$/, (b, _m, url) => app.listNotifications({
      channel: url.searchParams.get('channel') ?? undefined,
      orderId: url.searchParams.get('orderId') ?? undefined,
    })],
  ];

  const server = createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        send(200, { status: 'ok' });
        return;
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const m = url.pathname.match(pattern);
        if (!m) continue;
        const result = await handler(body, m, url);
        send(200, { ok: true, ...(result !== undefined ? { data: result } : {}) });
        return;
      }
      send(404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
    } catch (err) {
      if (err instanceof DomainError) {
        send(err.status, { ok: false, error: { code: err.code, message: err.message, details: err.details } });
        return;
      }
      send(500, { ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
  });

  return { server, app };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, app } = createApp();
  const port = process.env.PORT || 3000;
  // 周期性回收过期锁，使过期释放与通知无需等待下一条命令触发。
  const reaper = setInterval(() => app.sweepExpiredLocks(), process.env.SWEEP_INTERVAL_MS || 1000);
  reaper.unref();
  server.listen(port, () => {
    console.log(`非遗直播货盘协同服务已启动: http://localhost:${port}`);
  });
}
