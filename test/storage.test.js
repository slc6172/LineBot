'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const lastContents = (w) => w.req.gemini().filter((r) => !(r.body.generationConfig && r.body.generationConfig.responseMimeType)).at(-1).body.contents; // 略過整理請求
const textsOf = (contents) => contents.map((c) => c.parts[0].text);

test('兩則訊息幾乎同時抵達同一聊天室,兩個回合都保存在歷史裡', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '暖機')); // 讓快取熱起來
  // A 在呼叫模型期間,B 完整處理完(模擬兩則同時抵達)
  let fired = false;
  w.beforeGemini = () => {
    if (fired) return;
    fired = true;
    w.geminiQueue.push(g.text('B的回答'));
    w.post(w.ev.text('U1', 'B訊息'));
  };
  w.geminiQueue.push(g.text('A的回答'));
  w.post(w.ev.text('U1', 'A訊息'));
  w.beforeGemini = null;

  w.post(w.ev.text('U1', '之後'));
  const sent = textsOf(lastContents(w));
  for (const t of ['A訊息', 'A的回答', 'B訊息', 'B的回答']) assert.ok(sent.includes(t), '歷史缺少 ' + t);
});

test('冷快取下的併發也不遺失回合(快取遺失時以試算表為準)', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '暖機'));
  w.clearCache();
  let fired = false;
  w.beforeGemini = () => {
    if (fired) return;
    fired = true;
    w.geminiQueue.push(g.text('B的回答'));
    w.post(w.ev.text('U1', 'B訊息'));
  };
  w.geminiQueue.push(g.text('A的回答'));
  w.post(w.ev.text('U1', 'A訊息'));
  w.beforeGemini = null;
  w.clearCache();
  w.post(w.ev.text('U1', '之後'));
  const sent = textsOf(lastContents(w));
  for (const t of ['A訊息', 'A的回答', 'B訊息', 'B的回答']) assert.ok(sent.includes(t), '歷史缺少 ' + t);
});

test('歷史超過單格 50,000 字元:不丟例外、分塊寫入、讀回後內容完全相同', () => {
  const w = createWorld();
  const big = (c) => c.repeat(4800);
  const msgs = [];
  for (let i = 0; i < 6; i++) {
    const u = big(String.fromCharCode(0x4e00 + i)); // 每則 4800 個漢字
    const m = big(String.fromCharCode(0x5e00 + i));
    msgs.push(u, m);
    w.geminiQueue.push(g.text(m));
    w.post(w.ev.text('U1', u));
  }
  // 沒有任何單格超過 50,000,且歷史實際分成多塊
  const row = w.stateRow('U1');
  const cells = row.slice(7).filter((c) => c !== '');
  assert.ok(cells.length >= 2, '應該分成多塊');
  assert.ok(row.every((c) => typeof c !== 'string' || c.length <= 50000));
  // 冷讀(快取清空)後內容與寫入前完全相同
  w.clearCache();
  w.post(w.ev.text('U1', '再問一次'));
  const sent = textsOf(lastContents(w));
  assert.deepStrictEqual(sent.slice(0, 12), msgs);
  assert.strictEqual(w.logs().filter((l) => l.level === '錯誤').length, 0);
});

test('超過 90KB 的狀態不放快取,直接走試算表,內容仍完整', () => {
  const w = createWorld();
  for (let i = 0; i < 8; i++) {
    const u = String.fromCharCode(0x4e00 + i).repeat(4000);
    w.geminiQueue.push(g.text(u));
    w.post(w.ev.text('U1', u));
  }
  assert.ok(!w.cacheKeys().includes('st:U1'), '大於 90KB 的狀態不應放快取');
  w.post(w.ev.text('U1', '收尾'));
  const sent = textsOf(lastContents(w));
  assert.strictEqual(sent[0], String.fromCharCode(0x4e00).repeat(4000));
});

test('熱請求:試算表讀取 0 次、寫入階段至多一次、沒有 appendRow', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '暖機'));
  w.resetStats();
  w.post(w.ev.text('U1', '熱請求'));
  assert.strictEqual(w.stats.reads, 0);
  assert.ok(w.stats.openById <= 1);
  assert.ok(w.stats.lockAcquires <= 1);
  assert.strictEqual(w.stats.appendRow, 0);
});

test('冷請求(既有聊天室):讀取不超過 2 次、只開一次試算表、一次寫入階段、沒有 appendRow', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '暖機'));
  w.clearCache();
  w.resetStats();
  w.post(w.ev.text('U1', '冷請求'));
  assert.ok(w.stats.reads <= 2, 'reads=' + w.stats.reads);
  assert.strictEqual(w.stats.openById, 1);
  assert.strictEqual(w.stats.lockAcquires, 1);
  assert.strictEqual(w.stats.appendRow, 0);
});

test('冷請求(全新使用者):讀取不超過 2 次,新列用 setValues 寫入', () => {
  const w = createWorld();
  w.addUser('UNEW');
  w.resetStats();
  w.post(w.ev.text('UNEW', '第一次'));
  assert.ok(w.stats.reads <= 2, 'reads=' + w.stats.reads);
  assert.strictEqual(w.stats.appendRow, 0);
  assert.ok(w.stateRow('UNEW'));
});

test('兩個新聊天室各佔一列,不互相覆蓋', () => {
  const w = createWorld();
  w.addUser('UA'); w.addUser('UB');
  w.post(w.ev.text('UA', 'a說'));
  w.post(w.ev.text('UB', 'b說'));
  w.clearCache();
  w.post(w.ev.text('UA', 'a再說'));
  const sent = textsOf(lastContents(w));
  assert.ok(sent.includes('a說') && !sent.includes('b說'));
  assert.strictEqual(w.rows('State').filter((r) => r[0] === 'UA').length, 1);
});

test('取不到鎖時 reply 仍送出,並記一筆錯誤日誌', () => {
  const w = createWorld();
  w.lockBusy = true;
  w.geminiQueue.push(g.text('照樣回覆'));
  w.post(w.ev.text('U1', 'hi'));
  assert.deepStrictEqual(w.replyTexts(), ['照樣回覆']);
  const errs = w.logs().filter((l) => l.level === '錯誤');
  assert.deepStrictEqual(errs.map((l) => l.code), ['LOCK_TIMEOUT']);
  assert.strictEqual(w.stateRow('U1'), null);
});

test('歷史只保留 HISTORY_MAX_TURNS 輪,最舊的被丟掉', () => {
  const w = createWorld({ props: { HISTORY_MAX_TURNS: '3' } });
  for (let i = 1; i <= 5; i++) { w.geminiQueue.push(g.text('a' + i)); w.post(w.ev.text('U1', 'q' + i)); }
  w.post(w.ev.text('U1', 'q6'));
  assert.deepStrictEqual(textsOf(lastContents(w)), ['q3', 'a3', 'q4', 'a4', 'q5', 'a5', 'q6']);
});

test('全新聊天室的併發 + 快取被淘汰:鎖內改讀最新試算表,兩個回合都保留、只佔一列', () => {
  const w = createWorld();
  w.addUser('UN');
  let fired = false;
  w.beforeGemini = () => {
    if (fired) return;
    fired = true;
    w.geminiQueue.push(g.text('B的回答'));
    w.post(w.ev.text('UN', 'B訊息'));
    w.cacheMap.delete('st:UN'); // 快取被淘汰
  };
  w.geminiQueue.push(g.text('A的回答'));
  w.post(w.ev.text('UN', 'A訊息'));
  w.beforeGemini = null;
  assert.strictEqual(w.rows('State').filter((r) => r[0] === 'UN').length, 1);
  w.clearCache();
  w.post(w.ev.text('UN', '之後'));
  const sent = textsOf(lastContents(w));
  for (const t of ['A訊息', 'A的回答', 'B訊息', 'B的回答']) assert.ok(sent.includes(t), '歷史缺少 ' + t);
});

test('既有聊天室被別的請求更新、快取又被淘汰:鎖內不使用過期快照', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '暖機'));
  w.clearCache();
  let fired = false;
  w.beforeGemini = () => {
    if (fired) return;
    fired = true;
    w.geminiQueue.push(g.text('B的回答'));
    w.post(w.ev.text('U1', 'B訊息'));
    w.cacheMap.delete('st:U1');
  };
  w.geminiQueue.push(g.text('A的回答'));
  w.post(w.ev.text('U1', 'A訊息'));
  w.beforeGemini = null;
  w.clearCache();
  w.post(w.ev.text('U1', '之後'));
  const sent = textsOf(lastContents(w));
  for (const t of ['暖機', 'A訊息', 'A的回答', 'B訊息', 'B的回答']) assert.ok(sent.includes(t), '歷史缺少 ' + t);
});
