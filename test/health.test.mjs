import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/service.mjs';
import { createApp } from '../src/http.mjs';

test('健康检查', async (t) => {
  const server = createApp({ service: new InventoryService() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});
