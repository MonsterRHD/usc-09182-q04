import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventStore } from '../src/domain/EventStore.mjs';
import { InventoryApp } from '../src/domain/InventoryApp.mjs';
import { DomainError } from '../src/domain/errors.mjs';

// 可控时钟：联调时主动推进时间，稳定复现锁过期与补传场景。
function makeHarness({ path } = {}) {
  let now = 1_000_000_000_000;
  const store = new EventStore(path ?? null);
  const app = new InventoryApp(store, { clock: () => now });
  return {
    app,
    store,
    now: () => now,
    tick: (ms) => { now += ms; },
    reopen: () => new InventoryApp(new EventStore(store.path), { clock: () => now }),
  };
}

const seed = (app) => {
  app.registerChannel({ channel: 'live-A', priority: 1 });
  app.registerChannel({ channel: 'live-B', priority: 2 });
  app.registerChannel({ channel: 'live-C', priority: 3 });
  app.registerArtwork({ code: 'NH-01', name: '泥咕咕-福虎', qty: 5 });
};

const expectError = (code, fn) => {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof DomainError);
    assert.equal(err.code, code);
    return true;
  });
};

test('两场直播并发抢同一批作品：先到先得，不超卖', () => {
  const { app } = makeHarness();
  seed(app);

  const a = app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 4, orderId: 'OA', ttlMs: 30_000 });
  assert.equal(a.status, 'locked');
  assert.equal(a.lock.pieceIds.length, 4);

  // B 再抢 2 件，只剩 1 件，明确告知剩余可售
  expectError('INSUFFICIENT_STOCK', () =>
    app.requestLock({ channel: 'live-B', code: 'NH-01', qty: 2, orderId: 'OB', ttlMs: 30_000 }));

  const inv = app.inventoryView('NH-01');
  assert.equal(inv.counts.locked, 4);
  assert.equal(inv.counts.available, 1);
  // 任一件都不会同时出现在两把锁里
  const allLocked = app.listLocks().flatMap((l) => l.pieceIds);
  assert.equal(new Set(allLocked).size, allLocked.length);
});

test('锁过期后自动释放并通知，排队请求按渠道优先级补分配', () => {
  const { app, tick } = makeHarness();
  seed(app);

  // C 先锁走全部 5 件
  app.requestLock({ channel: 'live-C', code: 'NH-01', qty: 5, orderId: 'OC', ttlMs: 10_000 });
  // A(优先级1) 与 B(优先级2) 各排队 5 件
  const qa = app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 5, orderId: 'OA', ttlMs: 60_000, wait: true });
  const qb = app.requestLock({ channel: 'live-B', code: 'NH-01', qty: 5, orderId: 'OB', ttlMs: 60_000, wait: true });
  assert.equal(qa.status, 'queued');
  assert.equal(qb.status, 'queued');

  // C 的锁过期：释放结果里应包含过期锁与补分配（A 优先于 B）
  tick(10_001);
  const sweep = app.sweepExpiredLocks();
  assert.equal(sweep.expiredLocks.length, 1);
  assert.equal(sweep.granted[0].channel, 'live-A');
  assert.equal(sweep.granted[0].orderId, 'OA');
  assert.equal(app.listQueue().length, 1); // B 仍在排队
  assert.equal(app.inventoryView('NH-01').counts.locked, 5);

  // 排队本身也会过期
  tick(60_000);
  const again = app.sweepExpiredLocks();
  assert.equal(again.expiredLocks.length, 1); // A 的锁过期
  assert.deepEqual(again.expiredQueue, [qb.queueId]);
});

test('展示馆撤展释放后排队队列获得补分配', () => {
  const { app } = makeHarness();
  seed(app);
  const hold = app.holdForDisplay({ code: 'NH-01', qty: 3, venue: '展示馆一号厅' });
  app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 2, orderId: 'OA', ttlMs: 60_000 });
  const q = app.requestLock({ channel: 'live-B', code: 'NH-01', qty: 2, orderId: 'OB', ttlMs: 60_000, wait: true });
  assert.equal(q.status, 'queued');

  const res = app.releaseDisplay({ holdId: hold.holdId, operator: '李卫雪' });
  assert.equal(res.granted.length, 1);
  assert.equal(res.granted[0].channel, 'live-B');
});

test('锁过期后不能再凭旧锁下单，必须重新锁定', () => {
  const { app, tick } = makeHarness();
  seed(app);
  app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 1, orderId: 'OA', ttlMs: 5_000 });
  tick(5_001);
  expectError('NO_ACTIVE_LOCK', () => app.confirmOrder({ orderId: 'OA', channel: 'live-A' }));

  // 重新锁定后下单成功
  app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 1, orderId: 'OA', ttlMs: 30_000 });
  const order = app.confirmOrder({ orderId: 'OA', channel: 'live-A' });
  assert.equal(order.order.status, 'confirmed');
});

test('预售订单：备货完成前进入待生产，不能发货；完成后可部分发货', () => {
  const { app } = makeHarness();
  seed(app);
  app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 3, orderId: 'P1', ttlMs: 60_000 });
  const created = app.confirmOrder({ orderId: 'P1', channel: 'live-A', type: 'presale' });
  assert.equal(created.order.ready, false);
  assert.equal(created.order.awaitingProductionPieceIds.length, 3);

  expectError('ORDER_NOT_READY', () =>
    app.dispatchShipment({ orderId: 'P1', pieceIds: ['NH-01-0001'], trackingNo: 'T1', operator: '仓管小王' }));

  expectError('BAD_REQUEST', () => app.markReady({ orderId: 'P1' })); // 必须有操作者
  app.markReady({ orderId: 'P1', operator: '作坊张师傅' });
  assert.equal(app.orderView('P1').pendingShipmentPieceIds.length, 3); // 进入待发队列

  const first = app.dispatchShipment({ orderId: 'P1', pieceIds: ['NH-01-0001', 'NH-01-0002'], trackingNo: 'T1', operator: '仓管小王' });
  assert.equal(first.orderStatus, 'confirmed'); // 部分发货，订单未完结
  assert.equal(app.pendingShipments().length, 1);

  // 同一件禁止重复发货
  expectError('ALREADY_SHIPPED', () =>
    app.dispatchShipment({ orderId: 'P1', pieceIds: ['NH-01-0001'], trackingNo: 'T2', operator: '仓管小王' }));

  app.dispatchShipment({ orderId: 'P1', pieceIds: ['NH-01-0003'], trackingNo: 'T2', operator: '仓管小王' });
  assert.equal(app.orderView('P1').status, 'completed');
  assert.equal(app.pendingShipments().length, 0);
});

test('取消订单只释放未发部分，已发货事实保留并可单件追踪', () => {
  const { app } = makeHarness();
  seed(app);
  app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 3, orderId: 'X1', ttlMs: 60_000 });
  app.confirmOrder({ orderId: 'X1', channel: 'live-A' });
  app.dispatchShipment({ orderId: 'X1', pieceIds: ['NH-01-0001'], trackingNo: 'T9', operator: '仓管小王' });

  expectError('BAD_REQUEST', () => app.cancelOrder({ orderId: 'X1', reason: '顾客申请退款' })); // 缺操作者
  const res = app.cancelOrder({ orderId: 'X1', reason: '顾客申请退款', operator: '客服小赵' });
  assert.deepEqual(res.piecesReleased.sort(), ['NH-01-0002', 'NH-01-0003']);
  assert.equal(res.shippedKept, 1);

  const view = app.orderView('X1');
  assert.deepEqual(view.shippedPieceIds, ['NH-01-0001']);
  const inv = app.inventoryView('NH-01');
  assert.equal(inv.counts.shipped, 1);
  assert.equal(inv.counts.available, 4); // 原本未锁定 2 件 + 取消释放 2 件
  assert.equal(inv.counts.reserved, 0);

  // 已发货的单件不能通过损耗抹去
  expectError('SHIPPED_NOT_ADJUSTABLE', () => app.adjustInventory({
    code: 'NH-01', pieceIds: ['NH-01-0001'], kind: 'loss', reason: '运输途中破损', operator: '作坊张师傅',
  }));
});

test('库存调整必须有理由和操作者；锁定/待发中的作品不能报损', () => {
  const { app } = makeHarness();
  seed(app);
  app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 1, orderId: 'L1', ttlMs: 60_000 });
  expectError('PIECE_COMMITTED', () => app.adjustInventory({
    code: 'NH-01', pieceIds: ['NH-01-0001'], kind: 'loss', reason: '烧制开裂', operator: '作坊张师傅',
  }));

  // 可售单件报损成功，审计记录保留理由与操作者
  const adj = app.adjustInventory({
    code: 'NH-01', pieceIds: ['NH-01-0002'], kind: 'loss', reason: '烧制开裂', operator: '作坊张师傅',
  });
  assert.equal(adj.adjustmentId.startsWith('A'), true);
  const inv = app.inventoryView('NH-01');
  assert.equal(inv.counts.lost, 1);
  assert.equal(inv.counts.available, 3);
  assert.equal(app.listAdjustments()[0].operator, '作坊张师傅');

  // 补货后续号不撞号，并触发排队补分配
  const q = app.requestLock({ channel: 'live-B', code: 'NH-01', qty: 4, orderId: 'B1', ttlMs: 60_000, wait: true });
  assert.equal(q.status, 'queued'); // 锁1 + 损1，只剩3
  const add = app.adjustInventory({ code: 'NH-01', kind: 'add', qty: 1, reason: '作坊加急补做', operator: '作坊张师傅' });
  assert.equal(add.pieceIds[0], 'NH-01-0006');
  assert.equal(add.granted.length, 1);
});

test('发货回执乱序可接受、重复回调只计数，通知每类只发一次', () => {
  const { app } = makeHarness();
  seed(app);
  app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 1, orderId: 'R1', ttlMs: 60_000 });
  app.confirmOrder({ orderId: 'R1', channel: 'live-A' });

  // 回执先于内部发货状态到达（乱序）：以作品归属为准正常记录
  const r1 = app.recordReceipt({ channel: 'live-A', eventId: 'EV-1', orderId: 'R1', status: 'in_transit', pieceIds: ['NH-01-0001'] });
  assert.equal(r1.applied, true);

  // 渠道重推同一回调：幂等命中、不产生新状态
  const r2 = app.recordReceipt({ channel: 'live-A', eventId: 'EV-1', orderId: 'R1', status: 'in_transit', pieceIds: ['NH-01-0001'] });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.applied, false);
  const r3 = app.recordReceipt({ channel: 'live-A', eventId: 'EV-1', orderId: 'R1', status: 'in_transit' });
  assert.equal(r3.duplicate, true);

  const view = app.orderView('R1');
  assert.equal(view.callbackAttempts, 3);       // 检查通知/回调次数
  assert.equal(view.receipts.length, 1);
  const kinds = app.listNotifications({ orderId: 'R1' }).map((n) => n.kind);
  assert.deepEqual(kinds, ['lock.granted', 'order.confirmed', 'receipt.recorded']); // 重复回执不再通知

  // 跨渠道伪造回执被拒绝
  const foreign = app.recordReceipt({ channel: 'live-B', eventId: 'EV-9', orderId: 'R1', status: 'signed' });
  assert.equal(foreign.applied, false);
  assert.equal(foreign.reason, 'CHANNEL_MISMATCH');
});

test('断网补传：同一客户端令牌/订单号重试不二次锁定、不超卖', () => {
  const { app } = makeHarness();
  seed(app);
  const payload = { channel: 'live-A', code: 'NH-01', qty: 2, orderId: 'D1', clientToken: 'tok-77', ttlMs: 60_000 };
  const first = app.requestLock(payload);
  const replay = app.requestLock(payload); // 主播端断网后原样补传
  assert.equal(replay.duplicate, true);
  assert.equal(replay.lock.lockId, first.lock.lockId);
  assert.deepEqual(replay.lock.pieceIds, first.lock.pieceIds);

  const c1 = app.confirmOrder({ orderId: 'D1', channel: 'live-A' });
  const c2 = app.confirmOrder({ orderId: 'D1', channel: 'live-A' });
  assert.equal(c1.duplicate, false);
  assert.equal(c2.duplicate, true);
  assert.equal(app.inventoryView('NH-01').counts.reserved, 2);
  assert.equal(app.inventoryView('NH-01').counts.available, 3);

  // 同订单补传内容不一致时明确报冲突，而不是静默覆盖
  expectError('ORDER_CONFLICT', () => app.confirmOrder({ orderId: 'D1', channel: 'live-B' }));
});

test('服务重启后锁定、待发队列与排队请求全部可恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'huopan-'));
  try {
    const path = join(dir, 'events.jsonl');
    const h1 = makeHarness({ path });
    seed(h1.app);
    // 一把未过期的锁 + 一个已下单待发 + 一个排队请求
    h1.app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 1, orderId: 'K1', ttlMs: 120_000 });
    h1.app.requestLock({ channel: 'live-B', code: 'NH-01', qty: 4, orderId: 'K2', ttlMs: 30_000 });
    h1.app.confirmOrder({ orderId: 'K2', channel: 'live-B' }); // 4 件待发
    h1.app.requestLock({ channel: 'live-C', code: 'NH-01', qty: 1, orderId: 'K3', ttlMs: 120_000, wait: true });

    // 模拟应用崩溃后重放事件日志
    const restored = h1.reopen();
    const locks = restored.listLocks();
    assert.equal(locks.length, 1);
    assert.equal(locks[0].orderId, 'K1');
    assert.equal(locks[0].status, 'active');
    assert.equal(restored.pendingShipments().length, 4);
    assert.equal(restored.listQueue()[0].orderId, 'K3');
    assert.equal(restored.inventoryView('NH-01').counts.reserved, 4);

    // 重启后取消订单释放库存，排队请求照样被补分配
    const res = restored.cancelOrder({ orderId: 'K2', reason: '缺货协商取消', operator: '客服小赵' });
    assert.equal(res.granted[0].channel, 'live-C');

    // 重启后过期回收同样生效
    h1.tick(120_001);
    const after = h1.reopen();
    const sweep = after.sweepExpiredLocks();
    assert.equal(sweep.expiredLocks.length, 2); // K1 与刚补分配的 K3 均到期
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('库存查询与订单状态可供联调核对', () => {
  const { app } = makeHarness();
  seed(app);
  app.requestLock({ channel: 'live-A', code: 'NH-01', qty: 2, orderId: 'Q1', ttlMs: 60_000 });
  app.confirmOrder({ orderId: 'Q1', channel: 'live-A' });
  const inv = app.inventoryView('NH-01');
  assert.equal(inv.total, 5);
  assert.equal(inv.counts.reserved, 2);
  assert.equal(inv.counts.available, 3);
  const tracked = inv.pieces.find((p) => p.pieceId === 'NH-01-0001');
  assert.equal(tracked.orderId, 'Q1'); // 单件可追踪到订单
});
