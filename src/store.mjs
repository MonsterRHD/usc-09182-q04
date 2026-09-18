// 极简 JSON 文件持久化：临时文件写入 + rename 保证原子性，重启后整体读回。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class JsonFileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
  }

  load() {
    if (!existsSync(this.file)) return null;
    return JSON.parse(readFileSync(this.file, 'utf8'));
  }

  save(state) {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.file);
  }
}
