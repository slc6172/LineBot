'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const FACTS = { 使用者: '- 喜歡貓\n- 住台北', 共同經歷: '- 一起去過露營', 待跟進: '- 下週三回診' };
const H = (t, r, ts) => ({ r: r || 'u', t, ts: ts || 1000 });

function seeded(props) {
  const w = createWorld({ props });
  w.addUser('C1', { kind: 'group' });
  w.addUser('U2');
  w.setState('U1', { facts: FACTS, history: [H('舊問題'), H('舊回答', 'm')], meta: { folds: 1, pending: [{ id: 'img-A', ts: w.now }] }, lastAt: w.now - 1000 });
  w.setState('C1', { kind: 'group', facts: { 使用者: '- 群組的事' }, history: [H('群組舊話'), H('群組回', 'm')], meta: { folds: 1 } });
  w.addEvents('U1', [{ date: '2026-10-01', text: 'U1 事件一' }, { date: '2026-10-02', text: 'U1 事件二' }, { date: '2026-10-03', text: 'U1 事件三' }]);
  w.addEvents('C1', [{ date: '2026-10-01', text: 'C1 事件' }]);
  w.addArchive('U1', [{ ts: 1, role: 'u', text: 'U1 歸檔一' }, { ts: 2, role: 'm', text: 'U1 歸檔二' }]);
  w.addArchive('C1', [{ ts: 3, role: 'u', text: 'C1 歸檔' }]);
  return w;
}
const col = (w, name, i) => w.rows(name).slice(1).map((r) => r[i]);

// ---------- /記憶 ----------
test('/記憶:回覆長期事實與日誌事件數量,不呼叫模型、不寫歷史', () => {
  const w = seeded();
  w.post(w.ev.text('U1', '/記憶'));
  const t = w.lastReplyText();
  assert.ok(t.includes('〔使用者〕') && t.includes('- 喜歡貓') && t.includes('- 住台北') && t.includes('〔共同經歷〕') && t.includes('〔待跟進〕'));
  assert.match(t, /日誌事件:3 筆/);
  assert.strictEqual(w.req.gemini().length, 0);
  assert.deepStrictEqual(w.stateOf('U1').history.map((h) => h.t), ['舊問題', '舊回答']);
});

test('/記憶:指令須文字完全符合(容許前後空白);夾在句子裡或多了字都不是指令', () => {
  const w = seeded();
  w.post(w.ev.text('U1', '  /記憶 '));
  assert.strictEqual(w.req.gemini().length, 0);
  for (const said of ['/記憶嗎', '請告訴我 /記憶', '/記憶 全部', '記憶', '/memory']) {
    w.post(w.ev.text('U1', said));
  }
  assert.strictEqual(w.req.gemini().length, 5);
});

test('/記憶:沒有任何記憶時回說明;內容很長時自動分段', () => {
  let w = createWorld();
  w.post(w.ev.text('U1', '/記憶'));
  assert.match(w.lastReplyText(), /還沒有長期記憶/);
  assert.match(w.lastReplyText(), /日誌事件:0 筆/);

  w = createWorld();
  const lines = []; for (let i = 0; i < 400; i++) lines.push('- ' + '字'.repeat(20) + i);
  w.setState('U1', { facts: { 使用者: lines.join('\n') } });
  w.post(w.ev.text('U1', '/記憶'));
  const msgs = w.req.replies()[0].body.messages;
  assert.ok(msgs.length >= 2 && msgs.every((m) => m.text.length <= 5000));
});

test('/記憶 在群組內處理的是群組記憶(不涉及個人);沒被 @ 不會觸發', () => {
  const w = seeded();
  w.post(w.ev.groupText('C1', 'U2', '/記憶'));
  const t = w.lastReplyText();
  assert.ok(t.includes('- 群組的事') && !t.includes('喜歡貓'));
  assert.match(t, /日誌事件:1 筆/);
  const n = w.requests.length;
  w.post(w.ev.groupText('C1', 'U2', '/記憶', { at: false }));
  assert.strictEqual(w.requests.length, n);
});

test('未登記的人使用指令 → 「尚未開通」,不洩漏任何記憶', () => {
  const w = seeded();
  w.post(w.ev.text('U999', '/記憶'));
  assert.match(w.lastReplyText(), /尚未開通/);
  assert.ok(!w.lastReplyText().includes('喜歡貓'));
});

// ---------- /忘記 ----------
test('/忘記 第一次:只回確認說明(含設定的秒數),不清任何資料、不呼叫模型', () => {
  const w = seeded({ FORGET_CONFIRM_TTL_S: '45' });
  w.post(w.ev.text('U1', '/忘記'));
  assert.strictEqual(w.lastReplyText(), '這會清空全部記憶與對話歷史,請在 45 秒內再輸入一次 /忘記 確認');
  assert.strictEqual(w.req.gemini().length, 0);
  assert.ok(w.stateRow('U1'));
  assert.strictEqual(w.rows('Events').length, 5);
  assert.strictEqual(w.rows('Archive').length, 4);
});

test('/忘記 確認(FORGET_CONFIRM_TTL_S 內再輸入一次):清空該聊天室,其他聊天室完全不受影響', () => {
  for (const second of ['/忘記', '/忘記 確認']) {
    const w = seeded();
    w.post(w.ev.text('U1', '/忘記'));
    w.advance(30 * 1000);
    w.post(w.ev.text('U1', second));
    assert.match(w.lastReplyText(), /已清空/);
    assert.strictEqual(w.stateRow('U1'), null, 'State 列被清空(含待提問圖片與長期事實)');
    assert.deepStrictEqual(col(w, 'Events', 0), ['C1'], 'U1 的事件被物理刪除');
    assert.deepStrictEqual(col(w, 'Archive', 0), ['C1'], 'U1 的歸檔被物理刪除');
    assert.strictEqual(w.rows('Events').flat().filter((c) => String(c).startsWith('U1')).length, 0);
    assert.ok(w.stateRow('C1') && w.stateRow('C1')[0] === 'C1', '群組的狀態完全不動');
    assert.deepStrictEqual(w.stateOf('C1').history.map((h) => h.t), ['群組舊話', '群組回']);
    assert.strictEqual(w.req.gemini().length, 0);
  }
});

test('/忘記 確認逾時(超過 FORGET_CONFIRM_TTL_S)無效:視為第一次,資料仍在', () => {
  const w = seeded();
  w.post(w.ev.text('U1', '/忘記'));
  w.advance(61 * 1000);
  w.post(w.ev.text('U1', '/忘記'));
  assert.match(w.lastReplyText(), /請在 60 秒內再輸入一次/);
  assert.ok(w.stateRow('U1'));
  assert.strictEqual(w.rows('Archive').length, 4);
});

test('/忘記 確認後下一則訊息從頭開始:看不到舊歷史(快取也被清掉)', () => {
  const w = seeded();
  w.post(w.ev.text('U1', '先暖機一下')); // 讓快取熱起來
  w.post(w.ev.text('U1', '/忘記'));
  w.post(w.ev.text('U1', '/忘記'));
  w.post(w.ev.text('U1', '新的開始'));
  const req = w.req.gemini().at(-1);
  assert.deepStrictEqual(req.body.contents.map((c) => c.parts[0].text), ['新的開始']);
  assert.match(req.body.systemInstruction.parts[0].text, /第一次對話/);
  assert.ok(!req.body.systemInstruction.parts[0].text.includes('喜歡貓'));
});

test('/忘記 確認在同一個寫入階段完成:一次取鎖、沒有 appendRow;可重複忘記', () => {
  const w = seeded();
  w.post(w.ev.text('U1', '/忘記'));
  w.resetStats();
  w.post(w.ev.text('U1', '/忘記'));
  assert.strictEqual(w.stats.lockAcquires, 1);
  assert.strictEqual(w.stats.appendRow, 0);
  w.post(w.ev.text('U1', '/忘記'));
  w.post(w.ev.text('U1', '/忘記'));
  assert.match(w.lastReplyText(), /已清空/);
});

test('/忘記 不動 _system 列(push 用量等全域計數)', () => {
  const w = seeded();
  w.setState('_system', { kind: 'system', meta: { push: { m: '2026-11', n: 3 } } });
  w.post(w.ev.text('U1', '/忘記'));
  w.post(w.ev.text('U1', '/忘記'));
  assert.deepStrictEqual(w.stateOf('_system').meta.push, { m: '2026-11', n: 3 });
});

test('/忘記 與 /記憶 不寫進歷史、不改變最後互動時間', () => {
  const w = seeded();
  const before = w.stateOf('U1').lastAt;
  w.post(w.ev.text('U1', '/記憶'));
  w.post(w.ev.text('U1', '/忘記'));
  assert.strictEqual(w.stateOf('U1').lastAt, before);
  assert.deepStrictEqual(w.stateOf('U1').history.map((h) => h.t), ['舊問題', '舊回答']);
});

// ---------- 群組內的 /忘記 ----------
test('群組內 /忘記:發送者在 Users 內 → 可清空群組(只清群組)', () => {
  const w = seeded();
  w.post(w.ev.groupText('C1', 'U2', '/忘記'));
  w.post(w.ev.groupText('C1', 'U2', '/忘記'));
  assert.match(w.lastReplyText(), /已清空/);
  assert.strictEqual(w.stateRow('C1'), null);
  assert.ok(w.stateRow('U1'), '個人聊天室不受影響');
  assert.deepStrictEqual(col(w, 'Events', 0), ['U1', 'U1', 'U1']);
  assert.deepStrictEqual(col(w, 'Archive', 0), ['U1', 'U1']);
});

test('群組內 /忘記:發送者不在 Users 內(或看不到發送者 ID)→ 拒絕,不清資料、不留確認狀態', () => {
  const w = seeded();
  w.post(w.ev.groupText('C1', 'Ustranger', '/忘記'));
  assert.match(w.lastReplyText(), /已登記/);
  w.post(w.ev.groupText('C1', 'Ustranger', '/忘記'));
  assert.match(w.lastReplyText(), /已登記/);
  assert.ok(w.stateRow('C1'));
  const noSender = w.ev.groupText('C1', undefined, '/忘記');
  delete noSender.source.userId;
  w.post(noSender);
  assert.match(w.lastReplyText(), /已登記/);
  assert.ok(w.stateRow('C1'));
});

test('群組內 /忘記:確認要由同一個人輸入(別人輸入只是自己的第一次)', () => {
  const w = seeded();
  w.addUser('U3');
  w.post(w.ev.groupText('C1', 'U2', '/忘記'));
  w.post(w.ev.groupText('C1', 'U3', '/忘記'));
  assert.match(w.lastReplyText(), /請在 60 秒內再輸入一次/);
  assert.ok(w.stateRow('C1'));
});

test('/忘記:破壞性指令必須嚴格比對,「/忘記嗎」「/忘記 全部」「請 /忘記」都只是普通訊息(不會啟動確認流程)', () => {
  const w = seeded();
  for (const said of ['/忘記嗎', '/忘記 全部', '請 /忘記', '/忘記確認', '/ 忘記']) w.post(w.ev.text('U1', said));
  assert.strictEqual(w.req.gemini().length, 5);
  assert.ok(w.stateRow('U1'));
  assert.strictEqual(w.cacheGet('forget:U1:U1'), null);
  w.post(w.ev.text('U1', '/忘記'));
  assert.match(w.lastReplyText(), /請在 60 秒內再輸入一次/);
  assert.ok(w.stateRow('U1'));
});
