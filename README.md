# 非遗直播货盘协同

面向浚县非遗产业的直播货盘协同服务：在展示馆、多个作坊与电商渠道之间协调同一批作品库存，
按渠道优先级短暂锁定库存，杜绝多主播同时开卖导致的超卖，并保证每件作品全程可追踪。

## 运行

```bash
npm start   # 启动服务，默认 3000 端口，状态写入 ./data/state.json
npm test    # 单元测试 + 直播运营联调场景测试
```

环境变量：`PORT` 端口；`DATA_DIR` 状态目录；`CHANNEL_PRIORITIES` 渠道优先级 JSON 覆盖（如 `{"douyin":70}`）。

## 领域规则

- 库存不变式：在库 + 展示占用 + 锁定 + 已分配 + 已发货 + 损耗 = 累计入库，任何时刻成立。
- 展示占用不参与线上可售，保障线下到店顾客。
- 锁定短暂有效（默认 30s，可配 1s~300s），过期自动释放并记录释放结果（`GET /releases`）。
- 库存不足时，高优先级渠道可抢占低优先级渠道的未消费锁定。
- 损耗申报只核销在库件，已发货事实不可抹去；所有库存调整必须携带操作者 `operator` 与理由 `reason`。
- 订单幂等键、锁定请求号、发货回执号全局去重：断网补传、重复回调不会重复扣减或重复通知。
- 状态持久化到本地文件，重启后未过期锁定与待发队列自动恢复，过期锁定在恢复时结算。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/works` | 登记作品：`{code, quantity, displayQty?, location?}` |
| GET | `/works/:code` | 库存视图（在库/展示/锁定/已分配/已发货/损耗/可售） |
| GET | `/works/:code/units` | 单件追踪：每件状态与全程历史 |
| POST | `/works/:code/adjustments` | 库存调整：`{type: loss\|restock\|correction, quantity, operator, reason}` |
| GET | `/works/:code/adjustments` | 调整审计流水 |
| POST | `/works/:code/display` | 展示占用转换：`{direction: occupy\|release, quantity, operator, reason}` |
| POST | `/locks` | 渠道锁定：`{workCode, channel, quantity, ttlMs?, requestId?}` |
| GET | `/locks`、`/locks/:id` | 锁定查询（含过期/被抢占状态） |
| POST | `/locks/:id/release` | 主动释放 |
| GET | `/releases` | 释放结果（过期/抢占/主动） |
| POST | `/orders` | 下单：`{workCode, channel, quantity, type?, lockId?, idempotencyKey?}`，`type` 支持 `normal`/`presale`/`custom` |
| POST | `/orders/:id/confirm` | 预售/定制到货确认 |
| POST | `/orders/:id/cancel` | 取消：`{operator, reason}`，已发货部分保留 |
| GET | `/orders/:id` | 订单状态与单件归属 |
| POST | `/shipments` | 发货回执：`{orderId, receiptId, quantity}`，支持部分发货、乱序、重复回调 |
| GET | `/orders/:id/shipments` | 订单回执列表 |
| GET | `/notifications` | 通知流水与按类型计数（联调核对用） |
| GET | `/admin/pending-shipments` | 待发队列 |
| POST | `/admin/sweep` | 手动结算过期锁定 |

错误统一为 `{error: {code, message}}`：`400` 参数/审计缺失，`404` 对象不存在，`409` 业务冲突
（`INSUFFICIENT_STOCK` 可售不足、`OVERSHIP` 超发、`IDEMPOTENCY_CONFLICT` 幂等键冲突等）。
