// 服务入口：加载持久化状态、恢复未过期锁定与待发队列后监听 HTTP。
import { InventoryService } from './service.mjs';
import { JsonFileStore } from './store.mjs';
import { createApp } from './http.mjs';

const dataDir = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;
const store = new JsonFileStore(dataDir);
const channelPriorities = process.env.CHANNEL_PRIORITIES ? JSON.parse(process.env.CHANNEL_PRIORITIES) : undefined;
const service = new InventoryService({ store, channelPriorities });
service.recover(); // 重启后结算过期锁定；未过期锁定与待发队列从状态文件恢复

const port = Number(process.env.PORT || 3000);
const server = createApp({ service });
server.listen(port, () => {
  console.log(`非遗直播货盘协同服务已启动: http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    service.persistIfDirty();
    server.close(() => process.exit(0));
  });
}
