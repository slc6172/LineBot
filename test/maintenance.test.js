'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld } = require('./world');

test('setupSheets 建立所有需要的表並加好標題列;重複執行不破壞既有資料', () => {
  const w = createWorld({ defaultUser: false });
  const created = w.call('setupSheets');
  assert.deepStrictEqual(created.sort(), ['Archive', 'Events', 'Images', 'Logs', 'State', 'Users']);
  assert.deepStrictEqual(w.rows('Users')[0], ['id', 'kind', 'note', 'enabled', 'added_at']);
  assert.deepStrictEqual(w.rows('State')[0].slice(0, 7), ['chat_id', 'kind', 'updated_at', 'last_at', 'meta', 'facts_chunks', 'history_chunks']);
  w.addUser('U1');
  const again = w.call('setupSheets');
  assert.deepStrictEqual(again, []);
  assert.strictEqual(w.rows('Users').length, 2);
});

test('smokeTest:在目標環境執行一次,確認正規表示式(lookbehind、\\p{L})、時區格式化等執行期相容;全部通過時回報 ok', () => {
  const w = createWorld();
  const r = w.call('smokeTest');
  assert.deepStrictEqual(r.failures, []);
  assert.strictEqual(r.ok, true);
  assert.ok(r.checked >= 8);
});

test('refreshUsersCache:新增白名單後立即生效(不必等 USERS_CACHE_TTL_S 過期)', () => {
  const w = createWorld();
  w.post(w.ev.text('U7', 'a'));
  assert.match(w.lastReplyText(), /尚未開通/);
  w.addUser('U7');
  w.post(w.ev.text('U7', 'b')); // 快取仍有效 → 還是未開通
  assert.match(w.lastReplyText(), /尚未開通/);
  w.call('refreshUsersCache');
  w.post(w.ev.text('U7', 'c'));
  assert.strictEqual(w.req.gemini().length, 1);
});
