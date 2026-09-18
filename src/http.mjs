// HTTP 层：薄路由 + JSON 编解码，领域规则全部在 service.mjs。
import { createServer } from 'node:http';
import { DomainError } from './service.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function send(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  }
}

function compile(path) {
  const keys = [];
  const pattern = path.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${pattern}$`), keys };
}

export function createApp({ service }) {
  const routes = [
    ['GET', '/health', () => ({ status: 'ok' })],
    // 作品与库存
    ['POST', '/works', (b) => service.registerWork(b)],
    ['GET', '/works/:code', (_b, p) => service.workView(p.code)],
    ['GET', '/works/:code/units', (_b, p) => ({ items: service.listUnits(p.code) })],
    ['POST', '/works/:code/adjustments', (b, p) => service.adjust({ ...b, workCode: p.code })],
    ['GET', '/works/:code/adjustments', (_b, p) => ({ items: service.adjustments(p.code) })],
    ['POST', '/works/:code/display', (b, p) => service.moveDisplay({ ...b, workCode: p.code })],
    // 渠道锁定
    ['POST', '/locks', (b) => service.lock(b)],
    ['GET', '/locks', (_b, _p, q) => ({ items: service.listLocks({ status: q.get('status') || undefined }) })],
    ['GET', '/locks/:lockId', (_b, p) => service.getLock(p.lockId)],
    ['POST', '/locks/:lockId/release', (_b, p) => service.releaseLock(p.lockId)],
    ['GET', '/releases', () => ({ items: service.releases() })],
    // 订单与发货回执
    ['POST', '/orders', (b) => service.createOrder(b)],
    ['GET', '/orders/:orderId', (_b, p) => service.getOrder(p.orderId)],
    ['POST', '/orders/:orderId/confirm', (_b, p) => service.confirmOrder(p.orderId)],
    ['POST', '/orders/:orderId/cancel', (b, p) => service.cancelOrder(p.orderId, b)],
    ['POST', '/shipments', (b) => service.receiveShipment(b)],
    ['GET', '/orders/:orderId/shipments', (_b, p) => ({ items: service.orderShipments(p.orderId) })],
    // 对账与运维
    ['GET', '/notifications', (_b, _p, q) => service.notifications({ type: q.get('type') || undefined })],
    ['GET', '/admin/pending-shipments', () => ({ items: service.pendingShipments() })],
    ['POST', '/admin/sweep', () => ({ items: service.sweepNow() })],
  ].map(([method, path, handler]) => ({ method, handler, ...compile(path) }));

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
      if (!route) throw new DomainError(404, 'NOT_FOUND', '接口不存在');
      const match = url.pathname.match(route.regex);
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await route.handler(body, params, url.searchParams);
      send(res, 200, result ?? {});
    } catch (err) {
      if (err instanceof DomainError) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        send(res, 500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
      }
    } finally {
      service.persistIfDirty?.();
    }
  });
}
