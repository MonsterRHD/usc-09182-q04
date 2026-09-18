import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.mjs';

async function startServer(path) {
  process.env.EVENT_LOG = path;
  const { server } = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const api = async (method, urlPath, body) => {
    const opts = { method, headers: { 'content-type': 'application/json' } };
    if (method !== 'GET' && body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, opts);
    return { status: res.status, json: await res.json() };
  };
  return {
    api,
    close: () => new Promise((resolve) => {
      // undici/fetch 默认 keep-alive，不强制断开会让 server.close 一直等待
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

test('HTTP 联调：并发抢货、过期释放、回执去重与重启恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huopan-http-'));
  const path = join(dir, 'events.jsonl');
  let srv;
  try {
    srv = await startServer(path);
    const { api } = srv;

    let r = await api('POST', '/channels', { channel: 'live-A', priority: 1 });
    assert.equal(r.status, 200);
    await api('POST', '/channels', { channel: 'live-B', priority: 2 });
    await api('POST', '/artworks', { code: 'NH-09', name: '浚县泥泥狗', qty: 3 });

    // 两场直播并发抢同一批：同时发 2 件和 3 件的锁，只有一个能成功
    const [lockA, lockB] = await Promise.all([
      api('POST', '/locks', { channel: 'live-A', code: 'NH-09', qty: 2, orderId: 'HA', ttlMs: 1000 }),
      api('POST', '/locks', { channel: 'live-B', code: 'NH-09', qty: 3, orderId: 'HB', ttlMs: 60000 }),
    ]);
    assert.equal(lockA.status, 200);
    assert.equal(lockB.json.error.code, 'INSUFFICIENT_STOCK');
    assert.equal(lockB.json.error.details.available, 1);

    // 过期回收
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const sweep = await api('POST', '/locks/sweep', {});
    assert.equal(sweep.json.data.expiredLocks.length, 1);

    // B 锁 3 件下单并发 1 件
    r = await api('POST', '/locks', { channel: 'live-B', code: 'NH-09', qty: 3, orderId: 'HB', ttlMs: 60000 });
    assert.equal(r.status, 200);
    const pieceId = r.json.data.lock.pieceIds[0];
    await api('POST', '/orders', { orderId: 'HB', channel: 'live-B' });
    const ship = await api('POST', '/orders/HB/shipments', { pieceIds: [pieceId], trackingNo: 'SF-1', operator: '仓管小王' });
    assert.equal(ship.status, 200);
    assert.equal(ship.json.data.orderStatus, 'confirmed'); // 部分发货

    // 重复回执：两次同 eventId，只第一次生效
    const receiptBody = { channel: 'live-B', eventId: 'CB-1', orderId: 'HB', status: 'in_transit', pieceIds: [pieceId] };
    const rc1 = await api('POST', '/receipts', receiptBody);
    const rc2 = await api('POST', '/receipts', receiptBody);
    assert.equal(rc1.json.data.applied, true);
    assert.equal(rc2.json.data.duplicate, true);

    const order = await api('GET', '/orders/HB');
    assert.equal(order.json.data.callbackAttempts, 2); // 回调次数可核对
    assert.equal(order.json.data.shippedPieceIds.length, 1);
    assert.equal(order.json.data.pendingShipmentPieceIds.length, 2); // 待发队列可核对

    // 库存调整缺操作者被拒
    const badAdj = await api('POST', '/adjustments', { code: 'NH-09', pieceIds: ['NH-09-0002'], reason: '开裂' });
    assert.equal(badAdj.status, 400);
    await srv.close();

    // 应用恢复运行：锁、待发队列、通知都从事件日志还原
    srv = await startServer(path);
    const inv = await srv.api('GET', '/inventory/NH-09');
    assert.equal(inv.json.data.counts.shipped, 1);
    assert.equal(inv.json.data.counts.reserved, 2);
    const pending = await srv.api('GET', '/pending-shipments');
    assert.equal(pending.json.data.length, 2);
    const locks = await srv.api('GET', '/locks', {});
    // 下单后锁已被订单消费，恢复后不存在悬挂的活跃锁
    assert.equal(locks.json.data.length, 0);
    const notes = await srv.api('GET', '/notifications?orderId=HB');
    const kinds = notes.json.data.map((n) => n.kind);
    assert.ok(kinds.includes('shipment.dispatched'));
    assert.equal(kinds.filter((k) => k === 'receipt.recorded').length, 1); // 重复回执不重复通知
  } finally {
    await srv?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
