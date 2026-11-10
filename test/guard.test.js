'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

test('沒帶或帶錯網址密鑰:回 200、不呼叫任何外部服務、不寫狀態', () => {
  const w = createWorld();
  for (const key of [null, 'wrong', '']) {
    const out = w.post(w.ev.text('U1', 'hi'), { key });
    assert.strictEqual(out.getContent(), '');
  }
  assert.strictEqual(w.requests.length, 0);
  assert.strictEqual(w.stateRow('U1'), null);
  assert.strictEqual(w.sheets.State, undefined);
  assert.ok(!w.cacheKeys().some((k) => k.startsWith('ev:') || k.startsWith('st:')));
});

test('WEBHOOK_KEY 沒設定時一律拒絕(不會因 undefined===undefined 放行)', () => {
  const w = createWorld({ props: { WEBHOOK_KEY: '' } });
  w.post(w.ev.text('U1', 'hi'), { key: null });
  w.post(w.ev.text('U1', 'hi'), { key: '' });
  assert.strictEqual(w.requests.length, 0);
});

test('密鑰錯誤只記一筆限頻的狀態日誌', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', 'hi'), { key: 'wrong' });
  w.post(w.ev.text('U1', 'hi'), { key: 'wrong' });
  assert.deepStrictEqual(w.logCodes(), ['BAD_KEY']);
});

test('LINE Verify(空事件陣列)回 200 且不做任何事;doGet 不洩漏設定', () => {
  const w = createWorld();
  const out = w.post([], {});
  assert.strictEqual(out.getContent(), '');
  assert.strictEqual(w.requests.length, 0);
  const got = w.get().getContent();
  assert.strictEqual(got, 'Webhook Verified');
});

test('不在名單的使用者只收到「尚未開通」與自己的 ID,沒有任何 Gemini 請求', () => {
  const w = createWorld();
  w.post(w.ev.text('U999stranger', '可以用嗎'));
  assert.strictEqual(w.req.gemini().length, 0);
  assert.strictEqual(w.replyTexts().length, 1);
  assert.match(w.lastReplyText(), /尚未開通/);
  assert.match(w.lastReplyText(), /U999stranger/);
});

test('陌生人嘗試的日誌是限頻的:同一 ID 一小時內只記一次', () => {
  const w = createWorld();
  w.post(w.ev.text('U9', 'a'));
  w.post(w.ev.text('U9', 'b'));
  assert.strictEqual(w.logs().filter((l) => l.code === 'STRANGER').length, 1);
  w.advance(3601 * 1000);
  w.post(w.ev.text('U9', 'c'));
  assert.strictEqual(w.logs().filter((l) => l.code === 'STRANGER').length, 2);
});

test('同一 Webhook 事件 ID 送兩次(含重送旗標)只產生一次 reply 與一次模型呼叫', () => {
  const w = createWorld();
  const first = w.ev.text('U1', '你好', { id: 'dup-1' });
  const again = w.ev.text('U1', '你好', { id: 'dup-1', redelivery: true });
  w.post(first);
  w.post(again);
  assert.strictEqual(w.req.replies().length, 1);
  assert.strictEqual(w.req.gemini().length, 1);
});

test('處理中收到的重送也被擋下(去重寫入發生在處理之前)', () => {
  const w = createWorld();
  const ev = w.ev.text('U1', '你好', { id: 'dup-2' });
  w.beforeGemini = () => { w.beforeGemini = null; w.post(w.ev.text('U1', '你好', { id: 'dup-2', redelivery: true })); };
  w.post(ev);
  assert.strictEqual(w.req.gemini().length, 1);
  assert.strictEqual(w.req.replies().length, 1);
});

test('停用某人後,在 USERS_CACHE_TTL_S 之後生效', () => {
  const w = createWorld({ props: { USERS_CACHE_TTL_S: '300' } });
  w.post(w.ev.text('U1', 'a'));
  assert.strictEqual(w.req.gemini().length, 1);
  w.setUserEnabled('U1', false);
  w.post(w.ev.text('U1', 'b')); // 快取仍有效
  assert.strictEqual(w.req.gemini().length, 2);
  w.advance(301 * 1000);
  w.post(w.ev.text('U1', 'c'));
  assert.strictEqual(w.req.gemini().length, 2);
  assert.match(w.lastReplyText(), /尚未開通/);
});

test('新增白名單在 TTL 之後生效', () => {
  const w = createWorld({ props: { USERS_CACHE_TTL_S: '60' } });
  w.post(w.ev.text('U7', 'a'));
  assert.match(w.lastReplyText(), /尚未開通/);
  w.addUser('U7');
  w.advance(61 * 1000);
  w.post(w.ev.text('U7', 'b'));
  assert.strictEqual(w.req.gemini().length, 1);
});

test('白名單檢查在快取命中時零次試算表讀取', () => {
  const w = createWorld();
  w.post(w.ev.text('U9', 'warm')); // 暖機:讀 Users 放進快取
  w.resetStats();
  w.post(w.ev.text('U9', 'again'));
  assert.strictEqual(w.stats.reads, 0);
  assert.strictEqual(w.stats.openById, 0);
});

test('Users 表啟用欄位為 FALSE / 空白的人都視為停用', () => {
  const w = createWorld({ defaultUser: false });
  w.setRows('Users', [['id', 'kind', 'note', 'enabled', 'added_at'], ['UA', 'user', '', 'FALSE', ''], ['UB', 'user', '', '', ''], ['UC', 'user', '', 'TRUE', '']]);
  for (const u of ['UA', 'UB', 'UC']) w.post(w.ev.text(u, 'x'));
  assert.strictEqual(w.req.gemini().length, 1);
});

test('貼圖、非訊息事件、非一對一來源靜默忽略', () => {
  const w = createWorld();
  w.post([
    w.ev.sticker('U1'),
    w.ev.follow('U1'),
    w.ev.text('U1', '群組', { source: { type: 'group', groupId: 'C1', userId: 'U1' } }),
  ]);
  assert.strictEqual(w.requests.length, 0);
});

test('單次執行超過 270 秒就停止處理剩餘事件並記一筆狀態日誌', () => {
  const w = createWorld();
  w.geminiFallback = () => g.delay(40000, g.text('慢'));
  const events = [];
  for (let i = 0; i < 10; i++) events.push(w.ev.text('U1', 'q' + i));
  w.post(events);
  assert.strictEqual(w.req.replies().length, 7); // 7 × 40s = 280s ≥ 270s
  assert.ok(w.logCodes().includes('EVENT_LOOP_TIMEOUT'));
});

test('所有外部請求都帶 muteHttpExceptions', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', 'hi'));
  assert.ok(w.requests.length >= 2);
  assert.ok(w.requests.every((r) => r.mute));
});
