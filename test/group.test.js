'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const b64 = (id) => Buffer.from('JPEGDATA-' + id).toString('base64');
const inlineOf = (req) => req.body.contents.at(-1).parts.filter((p) => p.inlineData).map((p) => p.inlineData);
const sysOf = (req) => req.body.systemInstruction.parts[0].text;
const texts = (req) => req.body.contents.map((c) => c.parts.filter((p) => p.text !== undefined).map((p) => p.text).join(''));
const groupWorld = (props) => { const w = createWorld({ props }); w.addUser('C1', { kind: 'group' }); return w; };

// ---------- 次縫:提及資訊 ----------
test('isSelfMentioned_:只認提及資訊中標示為「自己」的提及', () => {
  const w = createWorld();
  const M = (mentionees) => ({ type: 'text', text: '@x', mention: { mentionees } });
  const table = [
    [M([{ index: 0, length: 4, type: 'user', userId: 'Ubot', isSelf: true }]), true],
    [M([{ index: 0, length: 4, type: 'user', userId: 'Ualice' }, { index: 5, length: 4, type: 'user', userId: 'Ubot', isSelf: true }]), true],
    [M([{ index: 0, length: 6, type: 'user', userId: 'Ualice', isSelf: false }]), false],
    [M([{ index: 0, length: 4, type: 'all' }]), false],
    [M([]), false],
    [{ type: 'text', text: '@Bot 文字裡寫了 @Bot 但沒有提及資訊' }, false],
    [{ type: 'text', text: 'x', mention: {} }, false],
    [{ type: 'text', text: 'x', mention: { mentionees: 'oops' } }, false],
    [null, false], [undefined, false],
  ];
  for (const [msg, expected] of table) assert.strictEqual(w.call('isSelfMentioned_', msg), expected, JSON.stringify(msg));
});

test('stripSelfMentions_:移除對機器人的 @ 字樣(不動別人的 @),收斂空白', () => {
  const w = createWorld();
  const self = (index, length) => ({ index, length, type: 'user', userId: 'Ubot', isSelf: true });
  const other = (index, length) => ({ index, length, type: 'user', userId: 'Ualice', isSelf: false });
  const table = [
    ['@Bot 今天天氣如何', [self(0, 4)], '今天天氣如何'],
    ['請問 @Bot 今天天氣', [self(3, 4)], '請問 今天天氣'],
    ['今天天氣 @Bot', [self(5, 4)], '今天天氣'],
    ['@Alice 你好 @Bot', [other(0, 6), self(10, 4)], '@Alice 你好'],
    ['@Bot @Bot 你好', [self(0, 4), self(5, 4)], '你好'],
    ['@Bot', [self(0, 4)], ''],
    ['😀 @Bot 嗨', [self(3, 4)], '😀 嗨'], // 索引以 UTF-16 計
    ['😀 @Bot 嗨', [self(2, 4)], '😀 嗨'], // 索引以字元(碼位)計
    ['@Bot   多個   空白', [self(0, 4)], '多個 空白'],
    ['沒有提及資訊 @Bot', [], '沒有提及資訊 @Bot'],
    ['索引對不上 @Bot', [self(0, 4)], '索引對不上 @Bot'], // 該段不是以 @ 開頭 → 不亂刪
  ];
  for (const [text, mentionees, expected] of table) {
    assert.strictEqual(w.call('stripSelfMentions_', text, { mention: { mentionees } }), expected, text);
  }
});

// ---------- 主縫 ----------
test('群組內沒 @ 的訊息:沒有 reply、沒有狀態寫入、沒有模型呼叫(連去重快取都不寫)', () => {
  const w = groupWorld();
  w.post(w.ev.text('U1', '大家好')); // 暖機
  w.resetStats();
  const before = w.requests.length;
  const keysBefore = w.cacheKeys().length;
  w.post(w.ev.groupText('C1', 'U5', '今天聚餐去哪', { at: false }));
  assert.strictEqual(w.requests.length, before);
  assert.strictEqual(w.stats.writes, 0);
  assert.strictEqual(w.stats.openById, 0);
  assert.strictEqual(w.cacheKeys().length, keysBefore);
  assert.strictEqual(w.stateRow('C1'), null);
});

test('群組內被 @:@ 字樣不出現在送給模型的文字,也不存進歷史;reply 回到該群組', () => {
  const w = groupWorld();
  w.geminiQueue.push(g.text('台北今天晴'));
  w.post(w.ev.groupText('C1', 'U5', '今天天氣如何'));
  const req = w.req.gemini()[0];
  assert.deepStrictEqual(texts(req), ['今天天氣如何']);
  assert.ok(!JSON.stringify(req.body.contents).includes('@Bot'));
  assert.deepStrictEqual(w.replyTexts(), ['台北今天晴']);
  const st = w.stateOf('C1');
  assert.deepStrictEqual(st.history.map((h) => h.t), ['今天天氣如何', '台北今天晴']);
  assert.strictEqual(w.stateRow('C1')[1], 'group');
});

test('只有 @ 沒有內容:靜默忽略(不呼叫模型、不回覆、不寫狀態)', () => {
  const w = groupWorld();
  w.post(w.ev.groupText('C1', 'U5', ''));
  assert.strictEqual(w.req.gemini().length, 0);
  assert.strictEqual(w.req.replies().length, 0);
  assert.strictEqual(w.stateRow('C1'), null);
});

test('提及別人或 @All 但沒有提及機器人 → 完全忽略', () => {
  const w = groupWorld();
  const ev1 = w.ev.groupText('C1', 'U5', '你看一下', { mention: { mentionees: [{ index: 0, length: 4, type: 'user', userId: 'Ualice', isSelf: false }] } });
  const ev2 = w.ev.groupText('C1', 'U5', '大家注意', { mention: { mentionees: [{ index: 0, length: 4, type: 'all' }] } });
  w.post([ev1, ev2]);
  assert.strictEqual(w.requests.length, 0);
});

test('以聊天室 ID 為單位:群組歷史與任何人的個人聊天室完全獨立(雙向)', () => {
  const w = groupWorld();
  w.geminiQueue.push(g.text('收到私人訊息'), g.text('收到群組訊息'), g.text('再收到私人訊息'));
  w.post(w.ev.text('U1', '我的私人秘密-ALPHA'));
  w.post(w.ev.groupText('C1', 'U1', '群組裡的討論-BETA'));
  const groupReq = w.req.gemini()[1];
  assert.deepStrictEqual(texts(groupReq), ['群組裡的討論-BETA']);
  assert.ok(!JSON.stringify(groupReq.body).includes('ALPHA'));
  w.post(w.ev.text('U1', '回到私聊'));
  const personal = w.req.gemini()[2];
  assert.ok(!JSON.stringify(personal.body).includes('BETA'));
  assert.deepStrictEqual(texts(personal), ['我的私人秘密-ALPHA', '收到私人訊息', '回到私聊']);
  assert.ok(w.stateRow('C1') && w.stateRow('U1'));
});

test('整個群組共用一份對話:不同成員的 @ 都接在同一份歷史上', () => {
  const w = groupWorld();
  w.geminiQueue.push(g.text('答一'), g.text('答二'));
  w.post(w.ev.groupText('C1', 'UA', '甲說'));
  w.post(w.ev.groupText('C1', 'UB', '乙說'));
  assert.deepStrictEqual(texts(w.req.gemini()[1]), ['甲說', '答一', '乙說']);
});

test('群組內任何成員(不論個人是否登記)被 @ 都可使用', () => {
  const w = groupWorld();
  w.post(w.ev.groupText('C1', 'U-not-registered', '你好'));
  assert.strictEqual(w.req.gemini().length, 1);
});

test('未登記的群組被 @ → 「此群組尚未開通」與群組 ID,沒有任何 Gemini 請求;未被 @ → 完全靜默', () => {
  const w = createWorld();
  w.post(w.ev.groupText('C9', 'U1', '你好'));
  assert.strictEqual(w.req.gemini().length, 0);
  assert.match(w.lastReplyText(), /此群組尚未開通/);
  assert.match(w.lastReplyText(), /C9/);
  assert.strictEqual(w.stateRow('C9'), null);
  const n = w.requests.length;
  w.post(w.ev.groupText('C9', 'U1', '沒有 at', { at: false }));
  assert.strictEqual(w.requests.length, n);
});

test('群組在 Users 表被停用 → 視為未登記;登記成 user 種類的群組 ID 也不算', () => {
  let w = createWorld();
  w.addUser('C1', { kind: 'group', enabled: false });
  w.post(w.ev.groupText('C1', 'U1', '你好'));
  assert.match(w.lastReplyText(), /尚未開通/);
  w = createWorld();
  w.addUser('C1', { kind: 'user' });
  w.post(w.ev.groupText('C1', 'U1', '你好'));
  assert.match(w.lastReplyText(), /尚未開通/);
});

test('多人聊天室(room)與群組同樣處理,Users 表種類寫 group 或 room 都可以', () => {
  for (const kind of ['group', 'room']) {
    const w = createWorld();
    w.addUser('R1', { kind });
    w.post(w.ev.groupText('R1', 'U1', '你好', { room: true }));
    assert.strictEqual(w.req.gemini().length, 1, kind);
    assert.strictEqual(w.stateRow('R1')[1], 'group');
  }
});

test('一對一的使用者 ID 登記成 group 種類不算已登記(種類要對)', () => {
  const w = createWorld({ defaultUser: false });
  w.addUser('U1', { kind: 'group' });
  w.post(w.ev.text('U1', '你好'));
  assert.match(w.lastReplyText(), /尚未開通/);
});

test('群組傳圖:沒有任何 reply,只靜默記下圖片 ID;之後 @ 提問 → 帶上該圖,之後不再帶', () => {
  const w = groupWorld();
  w.post(w.ev.groupImage('C1', 'U5', { id: 'gimg' }));
  assert.strictEqual(w.req.replies().length, 0);
  assert.strictEqual(w.req.gemini().length, 0);
  assert.deepStrictEqual(w.stateOf('C1').meta.pending.map((p) => p.id), ['gimg']);
  w.post(w.ev.groupText('C1', 'U6', '這張是哪裡'));
  assert.deepStrictEqual(inlineOf(w.req.gemini()[0]), [{ mimeType: 'image/jpeg', data: b64('gimg') }]);
  assert.strictEqual(w.stateOf('C1').history[0].t, '[圖片] 這張是哪裡');
  w.post(w.ev.groupText('C1', 'U6', '再問'));
  assert.strictEqual(inlineOf(w.req.gemini()[1]).length, 0);
});

test('群組圖片遵守 TTL 與張數上限;與個人聊天室的待提問圖片互不相干', () => {
  const w = groupWorld();
  w.post(w.ev.image('U1', { id: 'personal' }));
  for (const id of ['g1', 'g2', 'g3', 'g4']) w.post(w.ev.groupImage('C1', 'U5', { id }));
  assert.deepStrictEqual(w.stateOf('C1').meta.pending.map((p) => p.id), ['g2', 'g3', 'g4']);
  w.advance(601 * 1000);
  w.post(w.ev.groupText('C1', 'U5', '問'));
  assert.strictEqual(w.req.content().length, 0, '過期不帶');
  assert.deepStrictEqual(w.stateOf('U1').meta.pending.map((p) => p.id), ['personal'], '個人的待提問圖片沒被動到');
});

test('未登記群組傳圖:完全忽略(沒有 reply、沒有狀態)', () => {
  const w = createWorld();
  w.post(w.ev.groupImage('C9', 'U1', { id: 'x' }));
  assert.strictEqual(w.req.replies().length, 0);
  assert.strictEqual(w.stateRow('C9'), null);
});

test('群組的 system prompt 說明這是多人共用的對話;一對一沒有這句', () => {
  const w = groupWorld();
  w.post(w.ev.groupText('C1', 'U5', '你好'));
  w.post(w.ev.text('U1', '你好'));
  assert.match(sysOf(w.req.gemini()[0]), /多人群組/);
  assert.ok(!/多人群組/.test(sysOf(w.req.gemini()[1])));
});

test('群組事件重送只處理一次', () => {
  const w = groupWorld();
  const ev = w.ev.groupText('C1', 'U5', '你好', { id: 'dup-g' });
  w.post(ev); w.post(ev);
  assert.strictEqual(w.req.replies().length, 1);
});

test('群組 reply 失敗且 push 預算大於 0:push 到群組 ID', () => {
  const w = groupWorld({ PUSH_MONTHLY_BUDGET: '3' });
  w.lineReplyHandler = () => ({ status: 400, body: { message: 'Invalid reply token' } });
  w.geminiQueue.push(g.text('回覆群組'));
  w.post(w.ev.groupText('C1', 'U5', '你好'));
  assert.strictEqual(w.req.pushes().length, 1);
  assert.strictEqual(w.req.pushes()[0].body.to, 'C1');
});

test('熱請求(群組被 @):試算表讀取 0 次、一次寫入階段', () => {
  const w = groupWorld();
  w.post(w.ev.groupText('C1', 'U5', '暖機'));
  w.resetStats();
  w.post(w.ev.groupText('C1', 'U5', '熱請求'));
  assert.strictEqual(w.stats.reads, 0);
  assert.ok(w.stats.lockAcquires <= 1);
  assert.strictEqual(w.stats.appendRow, 0);
});

test('同一個請求混合一對一與群組事件:各自獨立處理', () => {
  const w = groupWorld();
  w.post([w.ev.text('U1', '私聊'), w.ev.groupText('C1', 'U5', '群聊'), w.ev.groupText('C1', 'U5', '沒 at', { at: false })]);
  assert.strictEqual(w.req.gemini().length, 2);
  assert.strictEqual(w.req.replies().length, 2);
});
