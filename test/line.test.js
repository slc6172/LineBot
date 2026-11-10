'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const failReplies = (w) => { w.lineReplyHandler = () => ({ status: 400, body: { message: 'Invalid reply token' } }); };

test('reply 失敗:記錄錯誤日誌(HTTP 狀態與 LINE 回應的錯誤欄位),預算為 0 不 push', () => {
  const w = createWorld();
  failReplies(w);
  w.post(w.ev.text('U1', 'hi'));
  const e = w.logs().find((l) => l.code === 'LINE_REPLY_FAILED');
  assert.ok(e);
  assert.strictEqual(e.level, '錯誤');
  assert.match(e.detail, /HTTP 400/);
  assert.match(e.detail, /Invalid reply token/);
  assert.strictEqual(w.req.pushes().length, 0);
});

test('reply 失敗但回合仍被保存(使用者的對話不因 reply 失敗而遺失)', () => {
  const w = createWorld();
  failReplies(w);
  w.geminiQueue.push(g.text('回答'));
  w.post(w.ev.text('U1', '問題'));
  w.lineReplyHandler = null;
  w.post(w.ev.text('U1', '下一題'));
  assert.deepStrictEqual(w.req.gemini().at(-1).body.contents.map((c) => c.parts[0].text), ['問題', '回答', '下一題']);
});

test('PUSH_MONTHLY_BUDGET 大於 0 且未達上限:改用 push 補送並計數;用完後不再 push', () => {
  const w = createWorld({ props: { PUSH_MONTHLY_BUDGET: '2' } });
  failReplies(w);
  for (let i = 0; i < 3; i++) { w.geminiQueue.push(g.text('答' + i)); w.post(w.ev.text('U1', 'q' + i)); }
  const pushes = w.req.pushes();
  assert.strictEqual(pushes.length, 2);
  assert.strictEqual(pushes[0].body.to, 'U1');
  assert.deepStrictEqual(pushes[0].body.messages.map((m) => m.text), ['答0']);
  assert.strictEqual(pushes[0].headers.Authorization, 'Bearer LINE-TOKEN-SECRET');
  const sys = w.stateRow('_system');
  assert.ok(sys, '_system 列應記錄 push 用量');
  assert.deepStrictEqual(JSON.parse(sys[4]).push, { m: '2026-11', n: 2 });
});

test('push 用量跨月重置', () => {
  const w = createWorld({ props: { PUSH_MONTHLY_BUDGET: '1' } });
  failReplies(w);
  w.post(w.ev.text('U1', 'a'));
  w.post(w.ev.text('U1', 'b'));
  assert.strictEqual(w.req.pushes().length, 1);
  w.advance(30 * 24 * 3600 * 1000); // 進入 12 月
  w.post(w.ev.text('U1', 'c'));
  assert.strictEqual(w.req.pushes().length, 2);
});

test('預設(預算 0)永不 push,即使 reply 一直失敗', () => {
  const w = createWorld();
  failReplies(w);
  for (let i = 0; i < 3; i++) w.post(w.ev.text('U1', 'q' + i));
  assert.strictEqual(w.req.pushes().length, 0);
});

test('reply 的網路例外也被記錄,不丟出', () => {
  const w = createWorld();
  w.lineReplyHandler = () => ({ throws: true });
  w.post(w.ev.text('U1', 'hi'));
  assert.ok(w.logs().some((l) => l.code === 'LINE_REPLY_FAILED' && l.detail === 'EXC'));
});
