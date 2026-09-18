// 非遗直播货盘协同 —— 领域核心：作品库存、渠道锁定、订单、发货回执与通知。
// 核心不变式：在库 + 展示占用 + 锁定 + 已分配 + 已发货 + 损耗 = 累计入库；
// 已发货与损耗只增不减，库存调整必须携带操作者与理由，单件作品全程可追踪。

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

export const ORDER_TYPES = ['normal', 'presale', 'custom'];

// 渠道默认优先级：数值越大优先级越高，可用 CHANNEL_PRIORITIES 环境变量覆盖。
export const DEFAULT_CHANNEL_PRIORITIES = {
  exhibition: 100, // 展示馆 / 线下门店
  douyin: 60,
  kuaishou: 50,
  taobao: 40,
};

const DEFAULT_LOCK_TTL_MS = 30_000; // 短暂锁定默认 30 秒
const MIN_LOCK_TTL_MS = 1_000;
const MAX_LOCK_TTL_MS = 300_000;

const COUNT_KEYS = {
  in_stock: 'inStock',
  display: 'display',
  locked: 'locked',
  allocated: 'allocated',
  shipped: 'shipped',
  lost: 'lost',
};

export function emptyState() {
  return {
    works: {}, // code -> { code, location, nextUnitSeq, units: [] }
    locks: {}, // lockId -> lock
    lockRequests: {}, // requestId -> lockId（锁定请求幂等）
    orders: {}, // orderId -> order
    orderKeys: {}, // idempotencyKey -> orderId（断网补传幂等）
    shipments: {}, // receiptId -> shipment（回执全局唯一）
    notifications: [], // 通知流水，联调按条数核对
    releases: [], // 锁定释放结果（过期 / 被抢占 / 主动释放）
    adjustments: [], // 库存调整审计（含损耗申报）
    seq: 0,
  };
}

export class InventoryService {
  constructor({ state, store, now, channelPriorities } = {}) {
    this.store = store ?? null;
    this.state = state ?? store?.load() ?? emptyState();
    this.now = now ?? (() => Date.now());
    this.channelPriorities = { ...DEFAULT_CHANNEL_PRIORITIES, ...(channelPriorities ?? {}) };
    this.dirty = false;
  }

  // ---------- 持久化与恢复 ----------

  persistIfDirty() {
    if (this.store && this.dirty) {
      this.store.save(this.state);
      this.dirty = false;
    }
  }

  // 应用重启后调用：结算已过期锁定；未过期锁定与待发队列随状态文件原样恢复。
  recover() {
    this._sweep();
    this.persistIfDirty();
  }

  // ---------- 作品与库存 ----------

  registerWork({ code, quantity, location = '', displayQty = 0 } = {}) {
    this._sweep();
    if (!code || typeof code !== 'string') throw new DomainError(400, 'INVALID_WORK', '作品编码必填');
    if (this.state.works[code]) throw new DomainError(409, 'WORK_EXISTS', `作品 ${code} 已登记`);
    const qty = this._positiveInt(quantity, 'quantity');
    const display = this._nonNegativeInt(displayQty, 'displayQty');
    if (display > qty) throw new DomainError(400, 'INVALID_DISPLAY', '展示占用不能超过入库数量');
    const work = { code, location, nextUnitSeq: 1, units: [], createdAt: this.now() };
    this.state.works[code] = work;
    this._addUnits(work, qty, 'registered');
    for (const u of work.units.filter((x) => x.status === 'in_stock').slice(0, display)) {
      u.status = 'display';
      u.history.push({ at: this.now(), event: 'display_occupied' });
    }
    this._touch();
    return this.workView(code);
  }

  workView(code) {
    const work = this._mustWork(code);
    const counts = { inStock: 0, display: 0, locked: 0, allocated: 0, shipped: 0, lost: 0 };
    for (const u of work.units) counts[COUNT_KEYS[u.status]] += 1;
    return {
      code: work.code,
      location: work.location,
      total: work.units.length,
      ...counts,
      available: counts.inStock, // 可售 = 在库；展示占用与锁定均不可售
    };
  }

  listUnits(code) {
    const work = this._mustWork(code);
    return work.units.map((u) => ({
      serial: u.serial,
      status: u.status,
      lockId: u.lockId,
      orderId: u.orderId,
      shipmentId: u.shipmentId,
      history: u.history,
    }));
  }

  // 库存调整：loss 损耗申报 / restock 补货入库 / correction 数据校正。
  // 损耗只核销在库件——已锁定、已分配、已发货的件数不可被抹去。
  adjust({ workCode, type, quantity, operator, reason } = {}) {
    this._sweep();
    const work = this._mustWork(workCode);
    this._requireAudit(operator, reason);
    if (!['loss', 'restock', 'correction'].includes(type)) {
      throw new DomainError(400, 'INVALID_ADJUSTMENT', 'type 仅支持 loss / restock / correction');
    }
    let qty;
    if (type === 'correction') {
      qty = Number(quantity);
      if (!Number.isInteger(qty) || qty === 0) throw new DomainError(400, 'INVALID_QUANTITY', 'correction 数量须为非零整数');
    } else {
      qty = this._positiveInt(quantity, 'quantity');
    }

    if (type === 'restock' || (type === 'correction' && qty > 0)) {
      this._addUnits(work, Math.abs(qty), type === 'restock' ? 'restocked' : 'corrected');
    } else {
      const remove = Math.abs(qty);
      const free = work.units.filter((u) => u.status === 'in_stock');
      if (remove > free.length) {
        throw new DomainError(409, 'ADJUST_EXCEEDS_IN_STOCK', `核销 ${remove} 超过在库 ${free.length}，已发货与已占用件不可调整`);
      }
      const targets = free.slice(0, remove);
      if (type === 'loss') {
        for (const u of targets) {
          u.status = 'lost';
          u.history.push({ at: this.now(), event: 'loss_reported', operator, reason });
        }
      } else {
        const removing = new Set(targets.map((u) => u.serial));
        work.units = work.units.filter((u) => !removing.has(u.serial));
      }
    }
    this.state.adjustments.push({ seq: ++this.state.seq, workCode, type, quantity: qty, operator, reason, at: this.now() });
    this._touch();
    return this.workView(workCode);
  }

  // 展示占用与在库之间的转换（展示馆占用 / 释放）。
  moveDisplay({ workCode, direction, quantity, operator, reason } = {}) {
    this._sweep();
    const work = this._mustWork(workCode);
    this._requireAudit(operator, reason);
    const qty = this._positiveInt(quantity, 'quantity');
    const from = direction === 'occupy' ? 'in_stock' : direction === 'release' ? 'display' : null;
    if (!from) throw new DomainError(400, 'INVALID_DIRECTION', 'direction 仅支持 occupy / release');
    const to = from === 'in_stock' ? 'display' : 'in_stock';
    const candidates = work.units.filter((u) => u.status === from);
    if (qty > candidates.length) {
      throw new DomainError(409, 'INSUFFICIENT_UNITS', `可转换件数 ${candidates.length} 不足 ${qty}`);
    }
    for (const u of candidates.slice(0, qty)) {
      u.status = to;
      u.history.push({ at: this.now(), event: direction === 'occupy' ? 'display_occupied' : 'display_released', operator, reason });
    }
    this._touch();
    return this.workView(workCode);
  }

  adjustments(workCode) {
    this._mustWork(workCode);
    return this.state.adjustments.filter((a) => a.workCode === workCode);
  }

  // ---------- 渠道锁定 ----------

  // 按渠道优先级短暂锁定库存；库存不足时可抢占优先级更低的未消费锁定。
  lock({ workCode, channel, quantity, ttlMs, requestId, priority } = {}) {
    this._sweep();
    if (requestId && this.state.lockRequests[requestId]) {
      const existing = this.state.locks[this.state.lockRequests[requestId]];
      if (existing.workCode !== workCode || existing.quantity !== quantity || existing.channel !== channel) {
        throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', `请求号 ${requestId} 已用于不同的锁定内容`);
      }
      return { lock: this._lockView(existing), duplicated: true };
    }
    const work = this._mustWork(workCode);
    if (!channel || typeof channel !== 'string') throw new DomainError(400, 'INVALID_CHANNEL', '渠道必填');
    const qty = this._positiveInt(quantity, 'quantity');
    const prio = this._priority(channel, priority);
    const ttl = ttlMs == null ? DEFAULT_LOCK_TTL_MS : Number(ttlMs);
    if (!Number.isInteger(ttl) || ttl < MIN_LOCK_TTL_MS || ttl > MAX_LOCK_TTL_MS) {
      throw new DomainError(400, 'INVALID_TTL', `锁定时长须在 ${MIN_LOCK_TTL_MS}~${MAX_LOCK_TTL_MS}ms 之间`);
    }

    const free = this._ensureFreeUnits(work, qty, prio);
    const lockId = `L-${String(++this.state.seq).padStart(6, '0')}`;
    const at = this.now();
    const lock = {
      lockId, workCode, channel, priority: prio, quantity: qty,
      unitSerials: [], status: 'active', createdAt: at, expiresAt: at + ttl,
      requestId: requestId ?? null,
    };
    for (const u of free.slice(0, qty)) {
      u.status = 'locked';
      u.lockId = lockId;
      u.history.push({ at, event: 'locked', lockId, channel });
      lock.unitSerials.push(u.serial);
    }
    this.state.locks[lockId] = lock;
    if (requestId) this.state.lockRequests[requestId] = lockId;
    this._touch();
    return { lock: this._lockView(lock), duplicated: false };
  }

  getLock(lockId) {
    const lock = this.state.locks[lockId];
    if (!lock) throw new DomainError(404, 'LOCK_NOT_FOUND', `锁定 ${lockId} 不存在`);
    this._sweep();
    return this._lockView(lock);
  }

  listLocks({ status } = {}) {
    this._sweep();
    return Object.values(this.state.locks)
      .filter((l) => !status || l.status === status)
      .map((l) => this._lockView(l));
  }

  releaseLock(lockId) {
    this._sweep();
    const lock = this.state.locks[lockId];
    if (!lock) throw new DomainError(404, 'LOCK_NOT_FOUND', `锁定 ${lockId} 不存在`);
    if (lock.status !== 'active') return { lock: this._lockView(lock), duplicated: true };
    this._releaseLock(lock, 'released', '渠道主动释放');
    this._touch();
    return { lock: this._lockView(lock), duplicated: false };
  }

  // 手动触发过期结算，返回本次释放结果（过期释放结果也可在 GET /releases 查询）。
  sweepNow() {
    return this._sweep().map((l) => this._lockView(l));
  }

  releases() {
    return this.state.releases;
  }

  // ---------- 订单 ----------

  // type: normal 现货（立即占用）/ presale 预售 / custom 定制（先到货后确认占用）。
  createOrder({ orderId, idempotencyKey, workCode, channel, quantity, type = 'normal', lockId, priority } = {}) {
    this._sweep();
    if (idempotencyKey && this.state.orderKeys[idempotencyKey]) {
      const existing = this.state.orders[this.state.orderKeys[idempotencyKey]];
      this._assertSameOrder(existing, { workCode, quantity, type });
      return { order: this._orderView(existing), duplicated: true };
    }
    if (orderId && this.state.orders[orderId]) {
      const existing = this.state.orders[orderId];
      this._assertSameOrder(existing, { workCode, quantity, type });
      return { order: this._orderView(existing), duplicated: true };
    }
    const work = this._mustWork(workCode);
    if (!channel || typeof channel !== 'string') throw new DomainError(400, 'INVALID_CHANNEL', '渠道必填');
    const qty = this._positiveInt(quantity, 'quantity');
    if (!ORDER_TYPES.includes(type)) throw new DomainError(400, 'INVALID_ORDER_TYPE', 'type 仅支持 normal / presale / custom');
    const prio = this._priority(channel, priority);
    const id = orderId ?? `O-${String(++this.state.seq).padStart(6, '0')}`;
    const at = this.now();
    const order = {
      orderId: id, workCode, channel, priority: prio, type, quantity: qty,
      status: null, unitSerials: [], shippedQty: 0, shipments: [],
      idempotencyKey: idempotencyKey ?? null, createdAt: at, updatedAt: at,
    };

    if (type === 'normal') {
      if (lockId) {
        this._consumeLock(order, lockId);
      } else {
        const free = this._ensureFreeUnits(work, qty, prio);
        this._allocateUnits(order, free.slice(0, qty));
      }
      order.status = 'confirmed';
    } else {
      order.status = 'awaiting_stock'; // 预售 / 定制：先登记不占用现货
    }

    this.state.orders[id] = order;
    if (idempotencyKey) this.state.orderKeys[idempotencyKey] = id;
    this._notify(order.status === 'confirmed' ? 'order.confirmed' : 'order.awaiting_stock', {
      workCode, orderId: id, channel, detail: { type, quantity: qty },
    });
    this._touch();
    return { order: this._orderView(order), duplicated: false };
  }

  getOrder(orderId) {
    this._sweep();
    return this._orderView(this._mustOrder(orderId));
  }

  // 预售 / 定制到货后确认：原子占用库存，不足则保持 awaiting_stock 并报错。
  confirmOrder(orderId) {
    this._sweep();
    const order = this._mustOrder(orderId);
    if (order.status === 'confirmed') return { order: this._orderView(order), duplicated: true };
    if (order.status !== 'awaiting_stock') {
      throw new DomainError(409, 'ORDER_NOT_CONFIRMABLE', `订单状态 ${order.status} 不可确认`);
    }
    const work = this._mustWork(order.workCode);
    const free = this._ensureFreeUnits(work, order.quantity, order.priority);
    this._allocateUnits(order, free.slice(0, order.quantity));
    order.status = 'confirmed';
    order.updatedAt = this.now();
    this._notify('order.confirmed', { workCode: order.workCode, orderId, channel: order.channel, detail: { type: order.type, quantity: order.quantity } });
    this._touch();
    return { order: this._orderView(order), duplicated: false };
  }

  // 取消：释放未发货占用，已发货部分事实保留；重复取消幂等。
  cancelOrder(orderId, { operator, reason } = {}) {
    this._sweep();
    const order = this._mustOrder(orderId);
    this._requireAudit(operator, reason);
    if (order.status === 'cancelled') return { order: this._orderView(order), duplicated: true };
    if (order.status === 'shipped') throw new DomainError(409, 'ORDER_ALREADY_SHIPPED', '已发货订单不可取消');
    const work = this._mustWork(order.workCode);
    for (const serial of order.unitSerials) {
      const u = this._unit(work, serial);
      if (u.status === 'allocated' && u.orderId === orderId) {
        u.status = 'in_stock';
        u.orderId = null;
        u.history.push({ at: this.now(), event: 'order_cancelled', orderId, operator, reason });
      }
    }
    order.status = 'cancelled';
    order.cancelledAt = this.now();
    order.cancelledBy = operator;
    order.cancelReason = reason;
    order.updatedAt = this.now();
    this._notify('order.cancelled', { workCode: order.workCode, orderId, channel: order.channel, detail: { shippedQty: order.shippedQty } });
    this._touch();
    return { order: this._orderView(order), duplicated: false };
  }

  // ---------- 发货回执 ----------

  // 回执按 receiptId 全局唯一去重：乱序到达各自独立累计，重复回调不重复计数、不重复通知。
  receiveShipment({ orderId, receiptId, quantity, operator = 'logistics' } = {}) {
    this._sweep();
    const order = this._mustOrder(orderId);
    if (!receiptId || typeof receiptId !== 'string') throw new DomainError(400, 'INVALID_RECEIPT', '回执编号 receiptId 必填');
    const seen = this.state.shipments[receiptId];
    if (seen) {
      if (seen.orderId !== orderId) {
        throw new DomainError(409, 'RECEIPT_CONFLICT', `回执 ${receiptId} 已属于订单 ${seen.orderId}`);
      }
      return { shipment: seen, order: this._orderView(order), duplicated: true };
    }
    const qty = this._positiveInt(quantity, 'quantity');
    const remaining = order.quantity - order.shippedQty;
    if (qty > remaining) {
      throw new DomainError(409, 'OVERSHIP', `发货 ${qty} 超出订单待发 ${remaining}`);
    }
    if (order.status !== 'confirmed' && order.status !== 'partially_shipped') {
      throw new DomainError(409, 'ORDER_NOT_SHIPPABLE', `订单状态 ${order.status} 不可发货`);
    }
    const work = this._mustWork(order.workCode);
    const picked = order.unitSerials
      .map((s) => this._unit(work, s))
      .filter((u) => u.status === 'allocated')
      .slice(0, qty);
    if (picked.length !== qty) throw new DomainError(500, 'INVARIANT_BROKEN', '已分配件数与订单待发不一致');

    const at = this.now();
    for (const u of picked) {
      u.status = 'shipped';
      u.shipmentId = receiptId;
      u.history.push({ at, event: 'shipped', orderId, receiptId, operator });
    }
    const shipment = { receiptId, orderId, workCode: order.workCode, quantity: qty, unitSerials: picked.map((u) => u.serial), operator, receivedAt: at };
    this.state.shipments[receiptId] = shipment;
    order.shipments.push(receiptId);
    order.shippedQty += qty;
    order.status = order.shippedQty === order.quantity ? 'shipped' : 'partially_shipped';
    order.updatedAt = at;
    this._notify(order.status === 'shipped' ? 'order.shipped' : 'order.partially_shipped', {
      workCode: order.workCode, orderId, channel: order.channel, detail: { receiptId, quantity: qty, shippedQty: order.shippedQty },
    });
    this._touch();
    return { shipment, order: this._orderView(order), duplicated: false };
  }

  orderShipments(orderId) {
    const order = this._mustOrder(orderId);
    return order.shipments.map((id) => this.state.shipments[id]);
  }

  // 待发队列：已确认未发完的订单（重启后随状态文件恢复）。
  pendingShipments() {
    this._sweep();
    return Object.values(this.state.orders)
      .filter((o) => o.status === 'confirmed' || o.status === 'partially_shipped')
      .map((o) => ({
        orderId: o.orderId,
        workCode: o.workCode,
        channel: o.channel,
        quantity: o.quantity,
        shippedQty: o.shippedQty,
        remaining: o.quantity - o.shippedQty,
        allocatedSerials: this._allocatedSerials(o),
      }));
  }

  // ---------- 通知 ----------

  notifications({ type } = {}) {
    const items = type ? this.state.notifications.filter((n) => n.type === type) : this.state.notifications;
    const byType = {};
    for (const n of this.state.notifications) byType[n.type] = (byType[n.type] ?? 0) + 1;
    return { total: this.state.notifications.length, byType, items };
  }

  // ---------- 内部 ----------

  _sweep() {
    const at = this.now();
    const released = [];
    for (const lock of Object.values(this.state.locks)) {
      if (lock.status === 'active' && lock.expiresAt <= at) {
        this._releaseLock(lock, 'expired', '锁定到期自动释放');
        released.push(lock);
      }
    }
    return released;
  }

  // 确保有 qty 件在库；不足时按优先级从低到高抢占严格更低优先级的未消费锁定。
  _ensureFreeUnits(work, qty, prio) {
    const free = work.units.filter((u) => u.status === 'in_stock');
    if (free.length >= qty) return free;
    const candidates = Object.values(this.state.locks)
      .filter((l) => l.status === 'active' && l.workCode === work.code && l.priority < prio)
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    const releasable = candidates.reduce((sum, l) => sum + l.quantity, 0);
    if (free.length + releasable < qty) {
      throw new DomainError(409, 'INSUFFICIENT_STOCK', `作品 ${work.code} 可售不足：需要 ${qty}，可售 ${free.length}`);
    }
    let freed = 0;
    for (const l of candidates) {
      if (free.length + freed >= qty) break;
      this._releaseLock(l, 'preempted', '被更高优先级渠道抢占');
      freed += l.quantity;
    }
    return work.units.filter((u) => u.status === 'in_stock');
  }

  _releaseLock(lock, status, reason) {
    const work = this.state.works[lock.workCode];
    for (const serial of lock.unitSerials) {
      const u = this._unit(work, serial);
      if (u && u.status === 'locked' && u.lockId === lock.lockId) {
        u.status = 'in_stock';
        u.lockId = null;
        u.history.push({ at: this.now(), event: `lock_${status}`, lockId: lock.lockId });
      }
    }
    lock.status = status;
    lock.releasedAt = this.now();
    lock.releaseReason = reason;
    this.state.releases.push({
      lockId: lock.lockId, workCode: lock.workCode, channel: lock.channel,
      quantity: lock.quantity, reason: status, detail: reason, at: this.now(),
    });
    this._notify(`lock.${status}`, { workCode: lock.workCode, lockId: lock.lockId, channel: lock.channel, detail: { quantity: lock.quantity, reason } });
  }

  _consumeLock(order, lockId) {
    const lock = this.state.locks[lockId];
    if (!lock) throw new DomainError(404, 'LOCK_NOT_FOUND', `锁定 ${lockId} 不存在`);
    if (lock.status !== 'active') throw new DomainError(409, 'LOCK_NOT_ACTIVE', `锁定 ${lockId} 状态为 ${lock.status}，不可使用`);
    if (lock.workCode !== order.workCode) throw new DomainError(409, 'LOCK_WORK_MISMATCH', '锁定与订单的作品不一致');
    if (lock.quantity !== order.quantity) throw new DomainError(409, 'LOCK_QUANTITY_MISMATCH', '订单数量须与锁定数量一致');
    const work = this._mustWork(order.workCode);
    for (const serial of lock.unitSerials) {
      const u = this._unit(work, serial);
      u.status = 'allocated';
      u.lockId = null;
      u.orderId = order.orderId;
      u.history.push({ at: this.now(), event: 'allocated', orderId: order.orderId, lockId });
      order.unitSerials.push(serial);
    }
    lock.status = 'consumed';
    lock.orderId = order.orderId;
    lock.consumedAt = this.now();
  }

  _allocateUnits(order, units) {
    for (const u of units) {
      u.status = 'allocated';
      u.orderId = order.orderId;
      u.history.push({ at: this.now(), event: 'allocated', orderId: order.orderId });
      order.unitSerials.push(u.serial);
    }
  }

  _addUnits(work, count, event) {
    for (let i = 0; i < count; i += 1) {
      const serial = `${work.code}-U${String(work.nextUnitSeq).padStart(4, '0')}`;
      work.nextUnitSeq += 1;
      work.units.push({ serial, status: 'in_stock', lockId: null, orderId: null, shipmentId: null, history: [{ at: this.now(), event }] });
    }
  }

  _notify(type, { workCode, orderId = null, lockId = null, channel = null, detail = null }) {
    this.state.notifications.push({ seq: ++this.state.seq, type, workCode, orderId, lockId, channel, detail, at: this.now() });
    this._touch();
  }

  _assertSameOrder(existing, { workCode, quantity, type }) {
    if (existing.workCode !== workCode || existing.quantity !== quantity || existing.type !== type) {
      throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键提交了不同的订单内容');
    }
  }

  _allocatedSerials(order) {
    const work = this.state.works[order.workCode];
    if (!work) return [];
    return order.unitSerials.filter((s) => {
      const u = this._unit(work, s);
      return u && u.status === 'allocated';
    });
  }

  _orderView(order) {
    const work = this.state.works[order.workCode];
    const shippedSerials = order.shipments.flatMap((id) => this.state.shipments[id]?.unitSerials ?? []);
    return {
      ...order,
      allocatedSerials: work ? this._allocatedSerials(order) : [],
      shippedSerials,
      remaining: order.quantity - order.shippedQty,
    };
  }

  _lockView(lock) {
    return { ...lock, remainingMs: lock.status === 'active' ? Math.max(0, lock.expiresAt - this.now()) : 0 };
  }

  _unit(work, serial) {
    return work.units.find((u) => u.serial === serial);
  }

  _mustWork(code) {
    const work = this.state.works[code];
    if (!work) throw new DomainError(404, 'WORK_NOT_FOUND', `作品 ${code} 未登记`);
    return work;
  }

  _mustOrder(orderId) {
    const order = this.state.orders[orderId];
    if (!order) throw new DomainError(404, 'ORDER_NOT_FOUND', `订单 ${orderId} 不存在`);
    return order;
  }

  _requireAudit(operator, reason) {
    if (!operator || typeof operator !== 'string' || !reason || typeof reason !== 'string') {
      throw new DomainError(400, 'AUDIT_REQUIRED', '库存调整必须提供操作者 operator 与理由 reason');
    }
  }

  _priority(channel, explicit) {
    if (explicit != null) {
      const p = Number(explicit);
      if (!Number.isFinite(p)) throw new DomainError(400, 'INVALID_PRIORITY', '优先级须为数值');
      return p;
    }
    return this.channelPriorities[channel] ?? 0;
  }

  _positiveInt(value, field) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new DomainError(400, 'INVALID_QUANTITY', `${field} 须为正整数`);
    return n;
  }

  _nonNegativeInt(value, field) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new DomainError(400, 'INVALID_QUANTITY', `${field} 须为非负整数`);
    return n;
  }

  _touch() {
    this.dirty = true;
  }
}
