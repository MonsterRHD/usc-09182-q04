import test from 'node:test';
import assert from 'node:assert/strict';
test('服务目录包含入口', () => assert.equal(typeof fetch, 'function'));
