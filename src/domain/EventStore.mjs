// 基于 JSONL 文件的事件存储：只追加、可重放。
// 服务重启后重放事件即可还原锁定、待发队列等全部运行态。
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class EventStore {
  constructor(path) {
    this.path = path;
    this.events = [];
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      try {
        const text = readFileSync(path, 'utf8');
        for (const line of text.split('\n')) {
          if (line.trim()) this.events.push(JSON.parse(line));
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }

  append(type, data) {
    // type 必须最后展开：载荷里允许出现同名字段（如订单类型 type），
    // 但不能覆盖事件类型，否则重放时无法正确分发。
    const event = { seq: this.events.length + 1, ...data, type };
    if (this.path) appendFileSync(this.path, JSON.stringify(event) + '\n');
    this.events.push(event);
    return event;
  }
}
