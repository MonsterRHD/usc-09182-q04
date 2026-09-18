// 货盘协同核心：所有状态由事件重放得到，命令结果只来自事件。
// 作品按单件管理（pieceId = 作品编码-序号），任何一件作品在任一时刻
// 只可能处于一种占用状态，因此并发抢货只会出现“抢到 / 抢不到”，不会超卖。
import { DomainError, badRequest, conflict, notFound } from './errors.mjs';

const PIECE_STATES = {
  AVAILABLE: 'available',       // 可售
  DISPLAY_HELD: 'display_held', // 展示馆占用
  LOCKED: 'locked',             // 渠道短暂锁定
  RESERVED: 'reserved',         // 已下单待发（预售/定制/现货）
  SHIPPED: 'shipped',           // 已发货，不可回退
  LOST: 'lost',                 // 损耗，不可售
};

const DEFAULT_LOCK_TTL_MS = 30_000;
const MAX_LOCK_TTL_MS = 5 * 60_000;

export class InventoryApp {
  constructor(store, { clock = () => Date.now() } = {}) {
    this.store = store;
    this.clock = clock;
    this.seq = store.events.length;

    this.artworks = new Map();      // code -> { code, name, seq }
    this.pieces = new Map();        // pieceId -> piece 状态
    this.channels = new Map();      // channel -> { channel, priority }
    this.locks = new Map();         // lockId -> 锁（含 status、expiresAt）
    this.tokenIndex = new Map();    // channel:clientToken -> lockId（断网补传去重）
    this.queue = new Map();         // queueId -> 排队中的锁请求
    this.orders = new Map();        // orderId -> 订单聚合
    this.holds = new Map();         // holdId -> 展示占用
    this.receipts = new Map();      // 回执事件 eventId -> 记录
    this.adjustments = [];
    this.notifications = new Map(); // 去重键 -> 通知内容
    this.notificationLog = [];

    for (const e of store.events) this.#apply(e);
  }

  #nextId(prefix) {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(6, '0')}`;
  }

  #emit(type, data) {
    const e = this.store.append(type, { at: this.clock(), ...data });
    this.#apply(e);
    return e;
  }

  #notify(key, { channel = null, orderId = null, kind, payload = {} }) {
    if (this.notifications.has(key)) return false;
    this.#emit('NotificationEmitted', { key, channel, orderId, kind, payload });
    return true;
  }

  // ---------- 事件重放 ----------
  #apply(e) {
    switch (e.type) {
      case 'ArtworkRegistered':
        this.artworks.set(e.code, { code: e.code, name: e.name, seq: e.pieces.length });
        for (const p of e.pieces) {
          this.pieces.set(p.pieceId, { pieceId: p.pieceId, code: e.code, state: PIECE_STATES.AVAILABLE });
        }
        break;
      case 'PiecesAdded': {
        const meta = this.artworks.get(e.code);
        for (const p of e.pieces) {
          this.pieces.set(p.pieceId, { pieceId: p.pieceId, code: e.code, state: PIECE_STATES.AVAILABLE });
        }
        meta.seq = Math.max(meta.seq, ...e.pieces.map((p) => this.#pieceIndex(p.pieceId, e.code)));
        break;
      }
      case 'ChannelRegistered':
        this.channels.set(e.channel, { channel: e.channel, priority: e.priority });
        break;
      case 'DisplayHeld':
        this.holds.set(e.holdId, { ...e, status: 'active' });
        for (const id of e.pieceIds) this.pieces.get(id).state = PIECE_STATES.DISPLAY_HELD;
        break;
      case 'DisplayReleased': {
        const hold = this.holds.get(e.holdId);
        if (hold) hold.status = 'released';
        for (const id of e.pieceIds) {
          const p = this.pieces.get(id);
          if (p.state === PIECE_STATES.DISPLAY_HELD) p.state = PIECE_STATES.AVAILABLE;
        }
        break;
      }
      case 'LockQueued':
        this.queue.set(e.queueId, { ...e });
        break;
      case 'LockQueueExpired':
        this.queue.delete(e.queueId);
        break;
      case 'LockGranted': {
        this.queue.delete(e.queueId);
        this.locks.set(e.lockId, {
          lockId: e.lockId, channel: e.channel, orderId: e.orderId,
          clientToken: e.clientToken, pieceIds: e.pieceIds,
          expiresAt: e.expiresAt, queueId: e.queueId ?? null, status: 'active',
        });
        if (e.clientToken) this.tokenIndex.set(`${e.channel}:${e.clientToken}`, e.lockId);
        for (const id of e.pieceIds) {
          const p = this.pieces.get(id);
          p.state = PIECE_STATES.LOCKED;
          p.lockId = e.lockId;
        }
        break;
      }
      case 'LockExpired':
      case 'LockReleased': {
        const lock = this.locks.get(e.lockId);
        if (lock) {
          lock.status = e.type === 'LockExpired' ? 'expired' : 'released';
          for (const id of lock.pieceIds) {
            const p = this.pieces.get(id);
            if (p.state === PIECE_STATES.LOCKED) {
              p.state = PIECE_STATES.AVAILABLE;
              p.lockId = undefined;
            }
          }
        }
        break;
      }
      case 'OrderConfirmed': {
        const order = {
          orderId: e.orderId, channel: e.channel, type: e.orderType,
          status: 'confirmed', ready: e.ready,
          pieces: new Map(e.pieces.map((p) => [p.pieceId, p])),
          shipments: [], createdAt: e.at,
        };
        this.orders.set(e.orderId, order);
        for (const { pieceId } of e.pieces) {
          const p = this.pieces.get(pieceId);
          const lock = p.lockId ? this.locks.get(p.lockId) : null;
          if (lock) lock.status = 'consumed';
          p.state = PIECE_STATES.RESERVED;
          p.orderId = e.orderId;
          p.lockId = undefined;
        }
        break;
      }
      case 'OrderReady': {
        const order = this.orders.get(e.orderId);
        if (order) order.ready = true;
        break;
      }
      case 'OrderCancelled': {
        const order = this.orders.get(e.orderId);
        if (order) {
          order.status = 'cancelled';
          order.cancelledPieceIds = e.piecesReleased;
        }
        for (const id of e.piecesReleased) {
          const p = this.pieces.get(id);
          if (p && p.state === PIECE_STATES.RESERVED) {
            p.state = PIECE_STATES.AVAILABLE;
            p.orderId = undefined;
          }
        }
        break;
      }
      case 'ShipmentDispatched': {
        const order = this.orders.get(e.orderId);
        order.shipments.push({
          shipmentId: e.shipmentId, pieceIds: e.pieceIds,
          trackingNo: e.trackingNo, operator: e.operator, at: e.at,
        });
        for (const id of e.pieceIds) {
          const p = this.pieces.get(id);
          p.state = PIECE_STATES.SHIPPED;
          p.shippedAt = e.at;
          p.trackingNo = e.trackingNo;
        }
        if ([...order.pieces.keys()].every((id) => this.pieces.get(id).state === PIECE_STATES.SHIPPED)) {
          order.status = 'completed';
        }
        break;
      }
      case 'ReceiptRecorded':
        this.receipts.set(e.eventId, {
          eventId: e.eventId, channel: e.channel, orderId: e.orderId,
          status: e.status, pieceIds: e.pieceIds ?? [], duplicate: e.duplicate,
          applied: e.applied, reason: e.reason ?? null, attempts: 1, at: e.at,
        });
        break;
      case 'ReceiptRetry': {
        const r = this.receipts.get(e.eventId);
        if (r) r.attempts += 1;
        break;
      }
      case 'InventoryAdjusted':
        this.adjustments.push({
          adjustmentId: e.adjustmentId, code: e.code, kind: e.kind,
          pieceIds: e.pieceIds, reason: e.reason, operator: e.operator, at: e.at,
        });
        if (e.kind === 'loss') {
          for (const id of e.pieceIds) {
            const p = this.pieces.get(id);
            p.state = PIECE_STATES.LOST;
            p.lostReason = e.reason;
          }
        }
        break;
      case 'NotificationEmitted':
        this.notifications.set(e.key, e);
        this.notificationLog.push(e);
        break;
      default:
        break;
    }
  }

  // ---------- 基础资料 ----------
  registerChannel({ channel, priority = 100 }) {
    if (!channel) throw badRequest('channel 必填');
    if (this.channels.has(channel)) throw conflict('CHANNEL_EXISTS', `渠道 ${channel} 已注册`);
    this.#emit('ChannelRegistered', { channel, priority });
    return { channel, priority };
  }

  registerArtwork({ code, name, qty }) {
    if (!code) throw badRequest('作品编码 code 必填');
    if (this.artworks.has(code)) throw conflict('ARTWORK_EXISTS', `作品 ${code} 已登记`);
    if (!Number.isInteger(qty) || qty < 1) throw badRequest('qty 必须为正整数');
    const pieces = [];
    for (let i = 1; i <= qty; i += 1) {
      pieces.push({ pieceId: `${code}-${String(i).padStart(4, '0')}` });
    }
    this.#emit('ArtworkRegistered', { code, name: name ?? code, pieces });
    return { code, name: name ?? code, pieces: pieces.map((p) => p.pieceId) };
  }

  // ---------- 展示馆占用 ----------
  holdForDisplay({ code, qty, venue }) {
    const meta = this.#requireArtwork(code);
    if (!venue) throw badRequest('venue 必填');
    if (!Number.isInteger(qty) || qty < 1) throw badRequest('qty 必须为正整数');
    const free = this.#freePieces(code);
    if (free.length < qty) {
      throw conflict('INSUFFICIENT_STOCK', `可售库存不足：需要 ${qty}，剩余 ${free.length}`, { available: free.length });
    }
    const pieceIds = free.slice(0, qty);
    const holdId = this.#nextId('H');
    this.#emit('DisplayHeld', { holdId, code, venue, pieceIds });
    return { holdId, code, venue, pieceIds };
  }

  releaseDisplay({ holdId }) {
    const hold = this.holds.get(holdId);
    if (!hold) throw notFound(`展示占用 ${holdId}`);
    if (hold.status !== 'active') throw conflict('HOLD_NOT_ACTIVE', '展示占用已释放', { status: hold.status });
    this.#emit('DisplayReleased', { holdId, pieceIds: hold.pieceIds });
    const granted = this.#pumpQueue();
    return { holdId, pieceIds: hold.pieceIds, granted };
  }

  // ---------- 库存调整（损耗/补货）：必须带理由与操作者 ----------
  adjustInventory({ code, pieceIds, qty, kind = 'loss', reason, operator }) {
    this.#requireArtwork(code);
    if (!reason || !operator) throw badRequest('库存调整必须填写 reason 与 operator');
    if (!['loss', 'add'].includes(kind)) throw badRequest("kind 只支持 loss / add");

    let ids = pieceIds;
    if (kind === 'loss') {
      if (!Array.isArray(ids) || ids.length === 0) throw badRequest('损耗申报必须指定 pieceIds');
      // 已发货是既成事实，锁定/待发中的作品也不能被悄悄抹去，否则会超卖。
      for (const id of ids) {
        const p = this.#requirePiece(id, code);
        if (p.state === PIECE_STATES.SHIPPED) {
          throw conflict('SHIPPED_NOT_ADJUSTABLE', `作品 ${id} 已发货，不能申报损耗抹去发货事实`);
        }
        if (p.state === PIECE_STATES.LOCKED || p.state === PIECE_STATES.RESERVED) {
          throw conflict('PIECE_COMMITTED', `作品 ${id} 已被锁定或下单，请先取消相关订单/锁`, { state: p.state });
        }
        if (p.state === PIECE_STATES.LOST) throw conflict('PIECE_LOST', `作品 ${id} 已申报损耗`);
      }
    } else {
      const count = Array.isArray(ids) ? ids.length : (Number.isInteger(qty) ? qty : 0);
      if (count < 1) throw badRequest('补货需指定 pieceIds 或正整数件数');
      if (!Array.isArray(ids)) {
        const meta = this.artworks.get(code);
        ids = [];
        for (let i = 0; i < count; i += 1) {
          meta.seq += 1;
          ids.push(`${code}-${String(meta.seq).padStart(4, '0')}`);
        }
      } else {
        for (const id of ids) {
          if (this.pieces.has(id)) throw conflict('PIECE_EXISTS', `作品 ${id} 已存在`);
        }
      }
    }

    if (kind === 'add') {
      this.#emit('PiecesAdded', { code, pieces: ids.map((pieceId) => ({ pieceId })) });
    }
    const adjustmentId = this.#nextId('A');
    this.#emit('InventoryAdjusted', { adjustmentId, code, kind, pieceIds: ids, reason, operator });
    const granted = kind === 'add' ? this.#pumpQueue() : [];
    return { adjustmentId, code, kind, pieceIds: ids, reason, operator, granted };
  }

  // ---------- 渠道锁库存 ----------
  requestLock({ channel, code, qty, orderId, clientToken, ttlMs = DEFAULT_LOCK_TTL_MS, wait = false }) {
    this.#sweepExpired(); // 任何命令前先完成过期释放，避免拿过期库存做判断
    const ch = this.#requireChannel(channel);
    this.#requireArtwork(code);
    if (!orderId) throw badRequest('orderId 必填');
    if (!Number.isInteger(qty) || qty < 1) throw badRequest('qty 必须为正整数');
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LOCK_TTL_MS) {
      throw badRequest(`ttlMs 须在 1~${MAX_LOCK_TTL_MS} 毫秒之间`);
    }

    // 断网补传：同一客户端令牌直接返回原锁/原排队，绝不二次锁定、不重复排队；
    // 但旧锁已过期/被释放时，按重新锁定处理（令牌指向新锁）。
    if (clientToken) {
      const tokenKey = `${channel}:${clientToken}`;
      const queued = [...this.queue.values()].find((q) => q.channel === channel && q.clientToken === clientToken);
      if (queued) {
        return {
          status: 'queued', duplicate: true, queueId: queued.queueId,
          channel, code: queued.code, qty: queued.qty, expiresAt: queued.expiresAt,
        };
      }
      const existed = this.tokenIndex.get(tokenKey);
      if (existed) {
        const lock = this.locks.get(existed);
        const live = this.#lockLiveStatus(lock);
        if (live === 'active' || lock.status === 'consumed') {
          return { status: live, lock: this.#lockView(lock), duplicate: true };
        }
        this.tokenIndex.delete(tokenKey);
      }
    }

    const free = this.#freePieces(code);
    if (free.length >= qty) return { ...this.#grantLock({ channel, code, qty, orderId, clientToken, ttlMs }), duplicate: false };

    if (wait) {
      const queueId = this.#nextId('Q');
      this.#emit('LockQueued', {
        queueId, channel, code, qty, orderId, clientToken: clientToken ?? null,
        ttlMs, priority: ch.priority, expiresAt: this.clock() + ttlMs,
      });
      this.#notify(`queue:${queueId}`, {
        channel, orderId, kind: 'lock.queued',
        payload: { code, qty, available: free.length },
      });
      return { status: 'queued', queueId, channel, code, qty, expiresAt: this.clock() + ttlMs };
    }
    throw conflict('INSUFFICIENT_STOCK', `可售库存不足：需要 ${qty}，剩余 ${free.length}`, { available: free.length });
  }

  #grantLock({ channel, code, qty, orderId, clientToken, ttlMs, queueId = null }) {
    const free = this.#freePieces(code);
    if (free.length < qty) return null;
    const pieceIds = free.slice(0, qty);
    const lockId = this.#nextId('L');
    const expiresAt = this.clock() + ttlMs;
    this.#emit('LockGranted', {
      lockId, queueId, channel, orderId, clientToken: clientToken ?? null,
      code, pieceIds, expiresAt,
    });
    this.#notify(`lock-granted:${lockId}`, {
      channel, orderId, kind: 'lock.granted', payload: { lockId, code, pieceIds, expiresAt },
    });
    return { status: 'locked', lock: this.#lockView(this.locks.get(lockId)) };
  }

  // 库存释放后按渠道优先级（数字小优先）、同优先级按排队先后补分配。
  #pumpQueue() {
    const granted = [];
    const entries = [...this.queue.values()]
      .filter((q) => q.expiresAt > this.clock())
      .sort((a, b) => (a.priority - b.priority) || a.seq - b.seq || a.at - b.at);
    for (const q of entries) {
      if (this.#freePieces(q.code).length >= q.qty) {
        const result = this.#grantLock({
          channel: q.channel, code: q.code, qty: q.qty, orderId: q.orderId,
          clientToken: q.clientToken, ttlMs: q.ttlMs, queueId: q.queueId,
        });
        if (result) granted.push(result.lock);
      }
    }
    return granted;
  }

  // 显式过期释放：返回释放的锁、失效的排队和补分配结果。
  sweepExpiredLocks() {
    return this.#sweepExpired();
  }

  #sweepExpired() {
    const now = this.clock();
    const expiredLocks = [];
    for (const lock of this.locks.values()) {
      if (lock.status === 'active' && lock.expiresAt <= now) {
        this.#emit('LockExpired', { lockId: lock.lockId, pieceIds: lock.pieceIds });
        this.#notify(`lock-expired:${lock.lockId}`, {
          channel: lock.channel, orderId: lock.orderId, kind: 'lock.expired',
          payload: { lockId: lock.lockId, pieceIds: lock.pieceIds },
        });
        expiredLocks.push(this.#lockView(lock));
      }
    }
    const expiredQueue = [];
    for (const q of [...this.queue.values()]) {
      if (q.expiresAt <= now) {
        this.#emit('LockQueueExpired', { queueId: q.queueId });
        this.#notify(`queue-expired:${q.queueId}`, {
          channel: q.channel, orderId: q.orderId, kind: 'queue.expired', payload: { queueId: q.queueId },
        });
        expiredQueue.push(q.queueId);
      }
    }
    const granted = expiredLocks.length ? this.#pumpQueue() : [];
    return { now, expiredLocks, expiredQueue, granted };
  }

  releaseLock({ lockId, reason = 'manual_release', operator }) {
    if (!operator) throw badRequest('释放锁必须填写 operator');
    const lock = this.locks.get(lockId);
    if (!lock) throw notFound(`锁 ${lockId}`);
    if (lock.status !== 'active' || lock.expiresAt <= this.clock()) {
      throw conflict('LOCK_NOT_ACTIVE', '锁已过期或已使用', { status: lock.status });
    }
    this.#emit('LockReleased', { lockId, pieceIds: lock.pieceIds, reason, operator });
    const granted = this.#pumpQueue();
    return { lockId, pieceIds: lock.pieceIds, granted };
  }

  // ---------- 订单：现货 / 预售 / 定制 ----------
  confirmOrder({ orderId, channel, type = 'live' }) {
    this.#sweepExpired();
    if (!orderId || !channel) throw badRequest('orderId 与 channel 必填');
    if (!['live', 'presale', 'custom'].includes(type)) throw badRequest("type 只支持 live / presale / custom");

    const existed = this.orders.get(orderId);
    if (existed) {
      // 断网补传：同一订单号直接幂等返回；请求内容不一致则明确冲突。
      if (existed.channel !== channel || existed.type !== type) {
        throw conflict('ORDER_CONFLICT', `订单 ${orderId} 已存在但渠道/类型不一致`, {
          existingChannel: existed.channel, existingType: existed.type,
        });
      }
      return { order: this.orderView(orderId), duplicate: true };
    }
    this.#requireChannel(channel);

    const activeLocks = [...this.locks.values()].filter(
      (l) => l.orderId === orderId && l.channel === channel && l.status === 'active' && l.expiresAt > this.clock(),
    );
    if (activeLocks.length === 0) {
      throw conflict('NO_ACTIVE_LOCK', `订单 ${orderId} 没有有效锁：可能未锁库或锁已过期，请重新锁定`);
    }
    const pieces = activeLocks
      .flatMap((l) => l.pieceIds.map((pieceId) => ({ pieceId, code: this.pieces.get(pieceId).code })))
      .sort((a, b) => (a.pieceId < b.pieceId ? -1 : 1));

    const ready = type === 'live';
    this.#emit('OrderConfirmed', { orderId, channel, orderType: type, ready, pieces });
    this.#notify(`order-confirmed:${orderId}`, {
      channel, orderId, kind: 'order.confirmed',
      payload: { type, qty: pieces.length, ready },
    });
    return { order: this.orderView(orderId), duplicate: false };
  }

  markReady({ orderId, operator }) {
    if (!operator) throw badRequest('operator 必填');
    const order = this.#requireOrder(orderId);
    if (order.status === 'cancelled') throw conflict('ORDER_CANCELLED', '订单已取消');
    if (order.ready) return { orderId, ready: true, duplicate: true };
    if (order.type === 'live') throw badRequest('现货订单默认可发货，无需标记');
    this.#emit('OrderReady', { orderId, operator });
    return { orderId, ready: true };
  }

  cancelOrder({ orderId, reason, operator }) {
    if (!reason || !operator) throw badRequest('取消订单必须填写 reason 与 operator');
    const order = this.#requireOrder(orderId);
    if (order.status === 'cancelled') throw conflict('ORDER_CANCELLED', '订单已取消');
    // 只释放尚未发货的单件；已发货部分保留发货事实。
    const releasable = [...order.pieces.keys()]
      .filter((id) => this.pieces.get(id).state === PIECE_STATES.RESERVED);
    this.#emit('OrderCancelled', { orderId, reason, operator, piecesReleased: releasable });
    this.#notify(`order-cancelled:${orderId}`, {
      channel: order.channel, orderId, kind: 'order.cancelled',
      payload: { released: releasable.length, reason },
    });
    const granted = this.#pumpQueue();
    const shippedKept = [...order.pieces.keys()]
      .filter((id) => this.pieces.get(id).state === PIECE_STATES.SHIPPED).length;
    return { orderId, piecesReleased: releasable, shippedKept, granted };
  }

  // 部分发货：只发指定单件，其余继续留在待发队列。
  dispatchShipment({ orderId, pieceIds, trackingNo, operator }) {
    if (!operator) throw badRequest('operator 必填');
    if (!Array.isArray(pieceIds) || pieceIds.length === 0) throw badRequest('pieceIds 必填且非空');
    if (!trackingNo) throw badRequest('trackingNo 必填');
    const order = this.#requireOrder(orderId);
    if (order.status === 'cancelled') throw conflict('ORDER_CANCELLED', '订单已取消，不能发货');
    if (!order.ready) throw conflict('ORDER_NOT_READY', '预售/定制订单尚未完成备货，不能发货');

    const unique = [...new Set(pieceIds)];
    for (const id of unique) {
      if (!order.pieces.has(id)) throw badRequest(`作品 ${id} 不属于订单 ${orderId}`);
      const p = this.pieces.get(id);
      if (p.state === PIECE_STATES.SHIPPED) {
        throw conflict('ALREADY_SHIPPED', `作品 ${id} 已发货，禁止重复发货`, { trackingNo: p.trackingNo });
      }
      if (p.state !== PIECE_STATES.RESERVED) throw conflict('PIECE_NOT_RESERVED', `作品 ${id} 当前不可发货`, { state: p.state });
    }

    const shipmentId = this.#nextId('S');
    this.#emit('ShipmentDispatched', { shipmentId, orderId, pieceIds: unique, trackingNo, operator });
    this.#notify(`shipment:${shipmentId}`, {
      channel: order.channel, orderId, kind: 'shipment.dispatched',
      payload: { shipmentId, pieceIds: unique, trackingNo },
    });
    return { shipmentId, orderId, pieceIds: unique, trackingNo, orderStatus: this.orders.get(orderId).status };
  }

  // ---------- 渠道发货回执：幂等、容忍乱序 ----------
  recordReceipt({ channel, eventId, orderId, status, pieceIds = [] }) {
    this.#requireChannel(channel);
    if (!eventId || !orderId || !status) throw badRequest('eventId / orderId / status 必填');

    if (this.receipts.has(eventId)) {
      // 重复回调：只计数，不再产生任何状态变化或通知。
      this.#emit('ReceiptRetry', { eventId, channel, orderId });
      const first = this.receipts.get(eventId);
      return { duplicate: true, applied: false, eventId, firstReceipt: first.status, attempts: first.attempts + 1 };
    }

    const order = this.orders.get(orderId);
    let applied = false;
    let reason = null;
    if (!order) {
      reason = 'ORDER_NOT_FOUND';
    } else if (order.channel !== channel) {
      reason = 'CHANNEL_MISMATCH';
    } else {
      const ids = pieceIds.length ? pieceIds : [...order.pieces.keys()];
      const known = ids.every((id) => order.pieces.has(id));
      if (!known) {
        reason = 'PIECE_NOT_IN_ORDER';
      } else if (order.status === 'cancelled' && ids.some((id) => this.pieces.get(id).state !== PIECE_STATES.SHIPPED)) {
        reason = 'ORDER_CANCELLED';
      } else {
        // 以作品实际状态为准，因此签收先于“已发货通知”到达也能被接受（乱序容忍）。
        applied = true;
      }
    }
    this.#emit('ReceiptRecorded', {
      eventId, channel, orderId, status, pieceIds, duplicate: false, applied, reason,
    });
    if (applied) {
      this.#notify(`receipt:${eventId}`, {
        channel, orderId, kind: 'receipt.recorded', payload: { status, pieceIds },
      });
    }
    return { duplicate: false, applied, eventId, status, reason };
  }

  // ---------- 查询 ----------
  inventoryView(code) {
    this.#sweepExpired();
    this.#requireArtwork(code);
    const counts = Object.fromEntries(Object.values(PIECE_STATES).map((s) => [s, 0]));
    const pieces = [];
    for (const p of this.pieces.values()) {
      if (p.code !== code) continue;
      counts[p.state] += 1;
      pieces.push({ pieceId: p.pieceId, state: p.state, orderId: p.orderId ?? null, lockId: p.lockId ?? null });
    }
    return { code, name: this.artworks.get(code).name, counts, total: pieces.length, pieces };
  }

  #lockView(lock) {
    if (!lock) return null;
    return {
      lockId: lock.lockId, channel: lock.channel, orderId: lock.orderId,
      pieceIds: lock.pieceIds, expiresAt: lock.expiresAt,
      ttlRemaining: Math.max(0, lock.expiresAt - this.clock()),
      status: this.#lockLiveStatus(lock),
    };
  }

  #lockLiveStatus(lock) {
    if (!lock) return null;
    if (lock.status === 'active' && lock.expiresAt <= this.clock()) return 'expired';
    return lock.status;
  }

  listLocks({ channel, status = 'active' } = {}) {
    this.#sweepExpired();
    return [...this.locks.values()]
      .filter((l) => !channel || l.channel === channel)
      .filter((l) => status === 'all' || this.#lockLiveStatus(l) === status)
      .map((l) => this.#lockView(l));
  }

  listQueue() {
    this.#sweepExpired();
    return [...this.queue.values()].map((q) => ({
      queueId: q.queueId, channel: q.channel, code: q.code, qty: q.qty,
      orderId: q.orderId, priority: q.priority, expiresAt: q.expiresAt,
    }));
  }

  #requireOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw notFound(`订单 ${orderId}`);
    return order;
  }

  orderView(orderId) {
    const order = this.#requireOrder(orderId);
    const all = [...order.pieces.keys()];
    const shipped = all.filter((id) => this.pieces.get(id).state === PIECE_STATES.SHIPPED);
    const pending = all.filter((id) => {
      const p = this.pieces.get(id);
      return p.state === PIECE_STATES.RESERVED && order.ready;
    });
    const awaiting = all.filter((id) => this.pieces.get(id).state === PIECE_STATES.RESERVED && !order.ready);
    // 取消时释放的单件以事件记录为准：即使其后被别的渠道重新卖出，
    // 原订单仍能完整交代“哪些单件被放回去了”。
    const released = order.status === 'cancelled'
      ? (order.cancelledPieceIds ?? [])
      : all.filter((id) => this.pieces.get(id).state === PIECE_STATES.AVAILABLE);
    const appliedReceipts = [...this.receipts.values()]
      .filter((r) => r.orderId === orderId && r.applied)
      .map((r) => ({ eventId: r.eventId, status: r.status, at: r.at }));
    const callbackAttempts = [...this.receipts.values()]
      .filter((r) => r.orderId === orderId)
      .reduce((sum, r) => sum + r.attempts, 0);
    return {
      orderId: order.orderId, channel: order.channel, type: order.type,
      status: order.status, ready: order.ready,
      pieces: all,
      shippedPieceIds: shipped,
      pendingShipmentPieceIds: pending,   // 待发队列
      awaitingProductionPieceIds: awaiting,
      releasedPieceIds: released,
      shipments: order.shipments,
      receipts: appliedReceipts,
      callbackAttempts,
      notificationCount: this.notificationLog.filter((n) => n.orderId === orderId).length,
    };
  }

  pendingShipments() {
    const result = [];
    for (const order of this.orders.values()) {
      if (order.status === 'cancelled') continue;
      for (const id of order.pieces.keys()) {
        const p = this.pieces.get(id);
        if (p.state === PIECE_STATES.RESERVED && order.ready) {
          result.push({ orderId: order.orderId, channel: order.channel, pieceId: id, code: order.pieces.get(id).code });
        }
      }
    }
    return result;
  }

  listNotifications({ channel, orderId } = {}) {
    return this.notificationLog
      .filter((n) => (!channel || n.channel === channel) && (!orderId || n.orderId === orderId))
      .map(({ key, channel: c, orderId: o, kind, payload, at }) => ({ key, channel: c, orderId: o, kind, payload, at }));
  }

  listAdjustments() {
    return this.adjustments;
  }

  // ---------- 内部工具 ----------
  #requireArtwork(code) {
    const meta = this.artworks.get(code);
    if (!meta) throw notFound(`作品 ${code}`);
    return meta;
  }

  #requireChannel(channel) {
    const ch = this.channels.get(channel);
    if (!ch) throw notFound(`渠道 ${channel}`);
    return ch;
  }

  #requirePiece(pieceId, code) {
    const p = this.pieces.get(pieceId);
    if (!p) throw notFound(`单件 ${pieceId}`);
    if (code && p.code !== code) throw badRequest(`单件 ${pieceId} 不属于作品 ${code}`);
    return p;
  }

  // 从单件编码尾部还原序号，用于补货后续号
  #pieceIndex(pieceId, code) {
    const m = pieceId.match(/^(.+)-(\d+)$/);
    if (!m || m[1] !== code) return 0;
    return Number(m[2]);
  }

  #freePieces(code) {
    return [...this.pieces.values()]
      .filter((p) => p.code === code && p.state === PIECE_STATES.AVAILABLE)
      .map((p) => p.pieceId)
      .sort();
  }
}

export { PIECE_STATES, DEFAULT_LOCK_TTL_MS };
