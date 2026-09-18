# 非遗直播货盘协同

为浚县非遗产业（展示馆、作坊、直播与电商渠道）提供的货盘协同服务：作品按**单件**管理，渠道按下单时的短暂锁定抢占库存，支持锁定过期自动释放、按渠道优先级排队补分配、预售/定制/取消/部分发货、渠道发货回执幂等去重、损耗审计，并保证应用恢复运行后锁定与待发队列可恢复。

## 设计要点

- **事件溯源**：所有状态来自只追加的事件日志（默认 `data/events.jsonl`，可用 `EVENT_LOG` 覆盖）。重启后重放日志即可还原锁定、排队、待发队列与通知。
- **单件状态机**：每件作品（`pieceId = 作品编码-序号`）在任一时刻只有一种状态：`available / display_held / locked / reserved / shipped / lost`，因此并发抢货只可能"抢到或抢不到"，不会超卖。
- **渠道锁**：`POST /locks` 按 TTL 短暂锁定；过期由后台定时器（`SWEEP_INTERVAL_MS`，默认 1s）或任意命令前置回收自动释放，返回过期锁与排队补分配结果。
- **幂等补传**：锁请求带 `clientToken`、渠道回执带 `eventId`、订单按 `orderId` 去重，直播断网后原样重传不会二次锁定、不会重复扣库存。
- **已发货不可抹**：损耗申报不能作用于已发货、已锁定或待发中的单件；任何库存调整必须填写 `reason` 与 `operator`。

## 启动

```bash
npm start          # 默认 http://localhost:3000
npm test           # 领域并发场景 + HTTP 联调测试
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/channels` | 登记渠道与优先级（数字越小优先级越高） |
| POST | `/artworks` | 登记作品编码与可售数量（生成单件编码） |
| GET | `/inventory/:code` | 查询库存分状态计数与单件追踪（订单号/锁号） |
| POST | `/artworks/:code/display-holds` | 展示馆占用 |
| POST | `/display-holds/:id/release` | 撤展释放，触发排队补分配 |
| POST | `/adjustments` | 损耗（kind=loss，需 pieceIds）/补货（kind=add，需 qty 或 pieceIds），须带 reason、operator |
| POST | `/locks` | 渠道锁库存（ttlMs、wait 排队、clientToken 幂等） |
| POST | `/locks/sweep` | 主动回收过期锁/排队并返回释放结果 |
| POST | `/locks/:id/release` | 提前释放锁 |
| GET | `/locks` / `/queue` | 查看有效锁 / 排队请求 |
| POST | `/orders` | 下单确认（type=live/presale/custom，按订单号幂等） |
| GET | `/orders/:id` | 订单状态：已发/待发/待生产/已释放单件、回执与通知次数 |
| POST | `/orders/:id/ready` | 预售/定制备货完成（进入待发队列） |
| POST | `/orders/:id/cancel` | 取消，只释放未发部分，须带 reason、operator |
| POST | `/orders/:id/shipments` | 部分发货（pieceIds + trackingNo + operator） |
| GET | `/pending-shipments` | 全渠道待发队列 |
| POST | `/receipts` | 渠道发货回执（eventId 幂等，容忍乱序与重复回调） |
| GET | `/notifications` | 通知记录（可按 channel/orderId 过滤），同键只发一次 |

### 最小联调流程

```bash
curl -s -XPOST localhost:3000/channels -d '{"channel":"live-A","priority":1}'
curl -s -XPOST localhost:3000/artworks -d '{"code":"NH-01","name":"泥咕咕-福虎","qty":5}'
curl -s -XPOST localhost:3000/locks    -d '{"channel":"live-A","code":"NH-01","qty":2,"orderId":"O1","ttlMs":30000}'
curl -s -XPOST localhost:3000/orders   -d '{"orderId":"O1","channel":"live-A"}'
curl -s -XPOST localhost:3000/orders/O1/shipments \
  -d '{"pieceIds":["NH-01-0001"],"trackingNo":"SF-1","operator":"仓管小王"}'
curl -s localhost:3000/orders/O1
```

所有写接口返回 `{ "ok": true, "data": ... }`；失败返回 `{ "ok": false, "error": { code, message, details } }`，常见错误码：`INSUFFICIENT_STOCK`、`NO_ACTIVE_LOCK`、`LOCK_NOT_ACTIVE`、`ORDER_CONFLICT`、`ALREADY_SHIPPED`、`SHIPPED_NOT_ADJUSTABLE`、`PIECE_COMMITTED`。
