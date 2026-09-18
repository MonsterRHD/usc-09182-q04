// 直播运营联调场景：两场直播并发抢同一批作品、锁定过期、回执乱序，
// 全程核对库存、订单状态与通知次数，最后验证重启后锁定与待发队列可恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryService } from '../src/service.mjs';
import { JsonFileStore } from '../src/store.mjs';
import { createApp } from '../src/http.mjs';

async function api(method, port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function serve(service) {
  const server = createApp({ service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

test('联调：并发抢货 + 锁定过期 + 回执乱序 + 断网补传 + 重启恢复', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ich-it-'));
  let now = 1_000_000;
  const service = new InventoryService({ store: new JsonFileStore(dir), now: () => now });
  const { server, port } = await serve(service);
  t.after(() => server.close());

  // 1. 作坊入库 8 件爆款年画，展示馆占用 2 件 -> 线上可售 6
  let r = await api('POST', port, '/works', { code: 'NIANHUA-01', quantity: 8, displayQty: 2, location: '展示馆' });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, 6);

  // 2. 淘宝场先锁 4 件（优先级 40）
  r = await api('POST', port, '/locks', { workCode: 'NIANHUA-01', channel: 'taobao', quantity: 4, requestId: 'req-tb-1' });
  assert.equal(r.status, 200);
  const taobaoLock = r.body.lock;
  assert.equal(taobaoLock.status, 'active');

  // 3. 抖音场并发抢 4 件（优先级 60）：在库只剩 2，抢占淘宝锁
  r = await api('POST', port, '/locks', { workCode: 'NIANHUA-01', channel: 'douyin', quantity: 4, requestId: 'req-dy-1' });
  assert.equal(r.status, 200);
  const douyinLock = r.body.lock;
  r = await api('GET', port, `/locks/${taobaoLock.lockId}`);
  assert.equal(r.body.status, 'preempted');
  r = await api('GET', port, '/releases');
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].reason, 'preempted');

  // 4. 抖音场用锁下单；随后模拟断网补传同一幂等键 -> 同一订单，不超卖
  r = await api('POST', port, '/orders', { workCode: 'NIANHUA-01', channel: 'douyin', quantity: 4, lockId: douyinLock.lockId, idempotencyKey: 'dy-order-1' });
  assert.equal(r.status, 200);
  const orderId = r.body.order.orderId;
  assert.equal(r.body.order.status, 'confirmed');
  r = await api('POST', port, '/orders', { workCode: 'NIANHUA-01', channel: 'douyin', quantity: 4, lockId: douyinLock.lockId, idempotencyKey: 'dy-order-1' });
  assert.equal(r.body.duplicated, true);
  assert.equal(r.body.order.orderId, orderId);
  r = await api('GET', port, '/works/NIANHUA-01');
  assert.equal(r.body.available, 2); // 补传未重复扣减

  // 5. 快手场短锁 2 件后下播未消费 -> 到期自动释放，库存回补
  r = await api('POST', port, '/locks', { workCode: 'NIANHUA-01', channel: 'kuaishou', quantity: 2, ttlMs: 5_000, requestId: 'req-ks-1' });
  const ksLock = r.body.lock;
  r = await api('GET', port, '/works/NIANHUA-01');
  assert.equal(r.body.available, 0);
  now += 6_000;
  r = await api('POST', port, '/admin/sweep');
  assert.deepEqual(r.body.items.map((l) => l.lockId), [ksLock.lockId]);
  r = await api('GET', port, '/works/NIANHUA-01');
  assert.equal(r.body.available, 2);

  // 6. 回执乱序 + 重复回调 + 超发防护
  r = await api('POST', port, '/shipments', { orderId, receiptId: 'rc-2', quantity: 2 });
  assert.equal(r.body.order.status, 'partially_shipped');
  r = await api('POST', port, '/shipments', { orderId, receiptId: 'rc-1', quantity: 2 });
  assert.equal(r.body.order.status, 'shipped');
  r = await api('POST', port, '/shipments', { orderId, receiptId: 'rc-1', quantity: 2 });
  assert.equal(r.body.duplicated, true);
  assert.equal(r.body.order.shippedQty, 4); // 重复回调未重复计数
  r = await api('POST', port, '/shipments', { orderId, receiptId: 'rc-3', quantity: 1 });
  assert.equal(r.status, 409); // 超发拒绝
  assert.equal(r.body.error.code, 'OVERSHIP');

  // 7. 联调核对：库存、订单状态、通知次数
  r = await api('GET', port, `/orders/${orderId}`);
  assert.equal(r.body.status, 'shipped');
  assert.equal(r.body.shippedQty, 4);
  assert.equal(r.body.remaining, 0);
  r = await api('GET', port, '/works/NIANHUA-01');
  assert.deepEqual(
    { total: r.body.total, display: r.body.display, inStock: r.body.inStock, shipped: r.body.shipped, lost: r.body.lost },
    { total: 8, display: 2, inStock: 2, shipped: 4, lost: 0 },
  );
  r = await api('GET', port, '/notifications');
  assert.equal(r.body.total, 5);
  assert.deepEqual(r.body.byType, {
    'lock.preempted': 1,
    'order.confirmed': 1,
    'lock.expired': 1,
    'order.partially_shipped': 1,
    'order.shipped': 1,
  });

  // 8. 释放出的 2 件被淘宝场买走但尚未发货 -> 构成待发队列
  r = await api('POST', port, '/orders', { workCode: 'NIANHUA-01', channel: 'taobao', quantity: 2, idempotencyKey: 'tb-order-1' });
  assert.equal(r.body.order.status, 'confirmed');
  const pendingOrderId = r.body.order.orderId;

  // 9. 应用重启：同一数据目录恢复，未过期锁定与待发队列都在
  server.close();
  const service2 = new InventoryService({ store: new JsonFileStore(dir), now: () => now });
  service2.recover();
  const reopened = await serve(service2);
  t.after(() => reopened.server.close());
  const port2 = reopened.port;

  r = await api('GET', port2, '/admin/pending-shipments');
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].orderId, pendingOrderId);
  assert.equal(r.body.items[0].remaining, 2);
  r = await api('GET', port2, `/locks/${douyinLock.lockId}`);
  assert.equal(r.body.status, 'consumed'); // 锁定状态随恢复保留
  r = await api('GET', port2, '/works/NIANHUA-01');
  assert.equal(r.body.allocated, 2);
  assert.equal(r.body.shipped, 4);

  // 10. 恢复后继续发货，队列清空，全程无超卖
  r = await api('POST', port2, '/shipments', { orderId: pendingOrderId, receiptId: 'rc-9', quantity: 2 });
  assert.equal(r.body.order.status, 'shipped');
  r = await api('GET', port2, '/admin/pending-shipments');
  assert.equal(r.body.items.length, 0);
  r = await api('GET', port2, '/works/NIANHUA-01');
  assert.deepEqual(
    { total: r.body.total, display: r.body.display, inStock: r.body.inStock, shipped: r.body.shipped },
    { total: 8, display: 2, inStock: 0, shipped: 6 },
  );
});
