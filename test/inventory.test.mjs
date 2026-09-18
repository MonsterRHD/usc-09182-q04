import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryService } from '../src/service.mjs';
import { JsonFileStore } from '../src/store.mjs';

function makeService() {
  let now = 1_000_000;
  const service = new InventoryService({ now: () => now });
  return { service, advance: (ms) => { now += ms; } };
}

test('登记作品：展示占用不参与线上可售', () => {
  const { service } = makeService();
  const view = service.registerWork({ code: 'NIANHUA-01', quantity: 10, displayQty: 3, location: '展示馆' });
  assert.equal(view.total, 10);
  assert.equal(view.display, 3);
  assert.equal(view.inStock, 7);
  assert.equal(view.available, 7);
  assert.throws(() => service.registerWork({ code: 'NIANHUA-01', quantity: 1 }), /已登记/);
  // 展示占用不可售：锁 8 件超出在库 7 件
  assert.throws(() => service.lock({ workCode: 'NIANHUA-01', channel: 'douyin', quantity: 8 }), /可售不足/);
});

test('库存调整必须携带操作者与理由', () => {
  const { service } = makeService();
  service.registerWork({ code: 'W1', quantity: 5 });
  assert.throws(() => service.adjust({ workCode: 'W1', type: 'loss', quantity: 1, reason: '破损' }), /操作者/);
  assert.throws(() => service.adjust({ workCode: 'W1', type: 'loss', quantity: 1, operator: '作坊甲' }), /理由/);
  const view = service.adjust({ workCode: 'W1', type: 'loss', quantity: 2, operator: '作坊甲', reason: '运输破损' });
  assert.equal(view.lost, 2);
  assert.equal(view.inStock, 3);
  const audit = service.adjustments('W1');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].operator, '作坊甲');
  assert.equal(audit[0].reason, '运输破损');
});

test('损耗申报不能抹去已发货事实', () => {
  const { service } = makeService();
  service.registerWork({ code: 'W2', quantity: 5 });
  const { order } = service.createOrder({ workCode: 'W2', channel: 'douyin', quantity: 2 });
  service.receiveShipment({ orderId: order.orderId, receiptId: 'rc-1', quantity: 2 });
  // 已发货 2、在库 3：申报损耗 4 超出在库，拒绝
  assert.throws(
    () => service.adjust({ workCode: 'W2', type: 'loss', quantity: 4, operator: '作坊甲', reason: '盘点差异' }),
    /不可调整/,
  );
  const view = service.adjust({ workCode: 'W2', type: 'loss', quantity: 3, operator: '作坊甲', reason: '破损' });
  assert.equal(view.shipped, 2); // 已发货事实保留
  assert.equal(view.inStock, 0);
  assert.equal(view.lost, 3);
});

test('锁定过期自动释放并记录释放结果', () => {
  const { service, advance } = makeService();
  service.registerWork({ code: 'W3', quantity: 5 });
  const { lock } = service.lock({ workCode: 'W3', channel: 'taobao', quantity: 3, ttlMs: 5_000, requestId: 'req-1' });
  assert.equal(service.workView('W3').available, 2);
  advance(6_000);
  const released = service.sweepNow();
  assert.equal(released.length, 1);
  assert.equal(released[0].status, 'expired');
  assert.equal(service.workView('W3').available, 5);
  const releases = service.releases();
  assert.equal(releases.length, 1);
  assert.equal(releases[0].reason, 'expired');
  assert.equal(service.getLock(lock.lockId).status, 'expired');
  // 过期释放产生一条通知
  assert.equal(service.notifications().byType['lock.expired'], 1);
  // 重复请求号幂等：返回同一把锁（已过期），不重新占用
  const dup = service.lock({ workCode: 'W3', channel: 'taobao', quantity: 3, ttlMs: 5_000, requestId: 'req-1' });
  assert.equal(dup.duplicated, true);
  assert.equal(dup.lock.lockId, lock.lockId);
});

test('高优先级渠道可抢占低优先级锁定，无可抢占时拒绝且不误伤', () => {
  const { service } = makeService();
  service.registerWork({ code: 'W4', quantity: 4 });
  service.lock({ workCode: 'W4', channel: 'taobao', quantity: 3 }); // 优先级 40
  const { lock: win } = service.lock({ workCode: 'W4', channel: 'douyin', quantity: 3 }); // 优先级 60
  assert.equal(win.status, 'active');
  assert.equal(service.releases().filter((r) => r.reason === 'preempted').length, 1);
  assert.equal(service.notifications().byType['lock.preempted'], 1);

  service.registerWork({ code: 'W5', quantity: 2 });
  service.lock({ workCode: 'W5', channel: 'douyin', quantity: 2 });
  // taobao 优先级更低，抢不过 douyin 的锁，且 douyin 的锁不受影响
  assert.throws(() => service.lock({ workCode: 'W5', channel: 'taobao', quantity: 1 }), /可售不足/);
  assert.equal(service.workView('W5').locked, 2);
});

test('断网补传：重复下单幂等，不超卖、不重复通知', () => {
  const { service } = makeService();
  service.registerWork({ code: 'W6', quantity: 3 });
  const first = service.createOrder({ workCode: 'W6', channel: 'douyin', quantity: 2, idempotencyKey: 'k-1' });
  assert.equal(first.order.status, 'confirmed');
  assert.equal(service.workView('W6').available, 1);
  const retry = service.createOrder({ workCode: 'W6', channel: 'douyin', quantity: 2, idempotencyKey: 'k-1' });
  assert.equal(retry.duplicated, true);
  assert.equal(retry.order.orderId, first.order.orderId);
  assert.equal(service.workView('W6').available, 1); // 未重复扣减
  assert.equal(Object.keys(service.state.orders).length, 1);
  assert.equal(service.notifications().total, 1); // 未重复通知
  // 同一幂等键提交不同内容 -> 冲突
  assert.throws(
    () => service.createOrder({ workCode: 'W6', channel: 'douyin', quantity: 3, idempotencyKey: 'k-1' }),
    /幂等键/,
  );
});

test('预售与定制：先登记不占用现货，到货确认后占用', () => {
  const { service } = makeService();
  service.registerWork({ code: 'W7', quantity: 1, displayQty: 1 }); // 现货 0
  const presale = service.createOrder({ workCode: 'W7', channel: 'taobao', quantity: 1, type: 'presale' });
  assert.equal(presale.order.status, 'awaiting_stock');
  assert.equal(service.workView('W7').available, 0);
  assert.throws(() => service.confirmOrder(presale.order.orderId), /可售不足/);
  service.adjust({ workCode: 'W7', type: 'restock', quantity: 1, operator: '作坊乙', reason: '预售补货入库' });
  const confirmed = service.confirmOrder(presale.order.orderId);
  assert.equal(confirmed.order.status, 'confirmed');
  assert.equal(service.workView('W7').allocated, 1);

  const custom = service.createOrder({ workCode: 'W7', channel: 'taobao', quantity: 1, type: 'custom' });
  assert.equal(custom.order.status, 'awaiting_stock');
  const cancelled = service.cancelOrder(custom.order.orderId, { operator: '李卫雪', reason: '客户改期' });
  assert.equal(cancelled.order.status, 'cancelled');
  assert.equal(service.workView('W7').total, 2); // 定制未占用任何件
});

test('取消释放未发货部分，已发货事实保留，重复取消幂等', () => {
  const { service } = makeService();
  service.registerWork({ code: 'W8', quantity: 5 });
  const { order } = service.createOrder({ workCode: 'W8', channel: 'douyin', quantity: 5 });
  service.receiveShipment({ orderId: order.orderId, receiptId: 'rc-1', quantity: 2 });
  const cancelled = service.cancelOrder(order.orderId, { operator: '李卫雪', reason: '客户取消' });
  assert.equal(cancelled.order.status, 'cancelled');
  assert.equal(cancelled.order.shippedQty, 2); // 已发货保留
  const view = service.workView('W8');
  assert.equal(view.shipped, 2);
  assert.equal(view.inStock, 3); // 未发货 3 件回库
  const again = service.cancelOrder(order.orderId, { operator: '李卫雪', reason: '客户取消' });
  assert.equal(again.duplicated, true);
  assert.equal(service.notifications().byType['order.cancelled'], 1);
});

test('回执乱序、重复回调与超发防护', () => {
  const { service } = makeService();
  service.registerWork({ code: 'W9', quantity: 4 });
  const { order } = service.createOrder({ workCode: 'W9', channel: 'douyin', quantity: 4 });
  // 乱序：rc-2 先到
  const r2 = service.receiveShipment({ orderId: order.orderId, receiptId: 'rc-2', quantity: 1 });
  assert.equal(r2.order.status, 'partially_shipped');
  const r1 = service.receiveShipment({ orderId: order.orderId, receiptId: 'rc-1', quantity: 2 });
  assert.equal(r1.order.shippedQty, 3);
  // 重复回调：不重复计数、不重复通知
  const dup = service.receiveShipment({ orderId: order.orderId, receiptId: 'rc-2', quantity: 1 });
  assert.equal(dup.duplicated, true);
  assert.equal(dup.order.shippedQty, 3);
  // 超发拒绝
  assert.throws(() => service.receiveShipment({ orderId: order.orderId, receiptId: 'rc-3', quantity: 2 }), /超出订单待发/);
  const done = service.receiveShipment({ orderId: order.orderId, receiptId: 'rc-3', quantity: 1 });
  assert.equal(done.order.status, 'shipped');
  // 回执号全局唯一：不能套到别的订单上
  service.registerWork({ code: 'W10', quantity: 1 });
  const other = service.createOrder({ workCode: 'W10', channel: 'taobao', quantity: 1 });
  assert.throws(
    () => service.receiveShipment({ orderId: other.order.orderId, receiptId: 'rc-1', quantity: 1 }),
    /已属于订单/,
  );
  const byType = service.notifications().byType;
  assert.equal(byType['order.confirmed'], 2);
  assert.equal(byType['order.partially_shipped'], 2);
  assert.equal(byType['order.shipped'], 1);
  assert.equal(service.notifications().total, 5);
});

test('重启后未过期锁定与待发队列可恢复，过期锁定自动结算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ich-store-'));
  const store = new JsonFileStore(dir);
  let now = 1_000_000;
  const s1 = new InventoryService({ store, now: () => now });
  s1.registerWork({ code: 'W11', quantity: 5 });
  const { lock: alive } = s1.lock({ workCode: 'W11', channel: 'douyin', quantity: 2, ttlMs: 300_000 });
  const { order } = s1.createOrder({ workCode: 'W11', channel: 'taobao', quantity: 2 });
  const { lock: dying } = s1.lock({ workCode: 'W11', channel: 'kuaishou', quantity: 1, ttlMs: 1_000 });
  s1.persistIfDirty();
  now += 2_000; // dying 锁已过期但尚未结算

  const s2 = new InventoryService({ store: new JsonFileStore(dir), now: () => now });
  s2.recover();
  assert.equal(s2.getLock(dying.lockId).status, 'expired'); // 过期锁定恢复时结算
  assert.equal(s2.getLock(alive.lockId).status, 'active'); // 未过期锁定保留
  const pending = s2.pendingShipments(); // 待发队列恢复
  assert.equal(pending.length, 1);
  assert.equal(pending[0].orderId, order.orderId);
  assert.equal(pending[0].remaining, 2);
  const view = s2.workView('W11');
  assert.equal(view.locked, 2);
  assert.equal(view.allocated, 2);
  assert.equal(view.inStock, 1);
});

test('单件可追踪：每件作品全程状态与经手记录可查', () => {
  const { service } = makeService();
  service.registerWork({ code: 'W12', quantity: 2 });
  const { order } = service.createOrder({ workCode: 'W12', channel: 'douyin', quantity: 1 });
  service.receiveShipment({ orderId: order.orderId, receiptId: 'rc-1', quantity: 1 });
  const units = service.listUnits('W12');
  const shipped = units.find((u) => u.status === 'shipped');
  assert.equal(shipped.orderId, order.orderId);
  assert.equal(shipped.shipmentId, 'rc-1');
  assert.deepEqual(shipped.history.map((h) => h.event), ['registered', 'allocated', 'shipped']);
  const inStock = units.find((u) => u.status === 'in_stock');
  assert.deepEqual(inStock.history.map((h) => h.event), ['registered']);
});
