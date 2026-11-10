'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const MB = 1024 * 1024;
const b64 = (id) => Buffer.from('JPEGDATA-' + id).toString('base64');
const inlineOf = (req) => req.body.contents.at(-1).parts.filter((p) => p.inlineData).map((p) => p.inlineData);
const textOf = (req) => req.body.contents.at(-1).parts.filter((p) => p.text !== undefined).map((p) => p.text).join('');
const sysOf = (req) => req.body.systemInstruction.parts[0].text;
const pendingOf = (w, id) => (w.stateOf(id || 'U1') ? (w.stateOf(id || 'U1').meta.pending || []) : []);

test('一對一單獨傳圖 → 回「收到,想問什麼?」,沒有任何 Gemini 請求與內容下載;只記圖片 ID 與時間', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'img-A' }));
  assert.deepStrictEqual(w.replyTexts(), ['收到,想問什麼?']);
  assert.strictEqual(w.req.gemini().length, 0);
  assert.strictEqual(w.req.content().length, 0);
  assert.deepStrictEqual(pendingOf(w).map((p) => p.id), ['img-A']);
  assert.strictEqual(pendingOf(w)[0].ts, w.now);
  assert.ok(!JSON.stringify(w.stateRow('U1')).includes(b64('img-A')), '不存圖片位元組');
});

test('舊行為已移除:單獨傳圖不會立刻被描述', () => {
  const w = createWorld();
  w.post(w.ev.image('U1'));
  assert.ok(!w.req.gemini().length);
  assert.ok(!w.lastReplyText().includes('圖片中是什麼'));
});

test('10 分鐘內的下一則文字 → 現場下載圖片,Gemini 請求同時含圖(內嵌)與文字;之後再傳文字不再帶圖', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'img-A' }));
  w.advance(121 * 1000);
  w.geminiQueue.push(g.text('這是一隻貓'));
  w.post(w.ev.text('U1', '這是什麼?'));

  const dl = w.req.content();
  assert.strictEqual(dl.length, 1);
  assert.strictEqual(dl[0].url, 'https://api-data.line.me/v2/bot/message/img-A/content');
  assert.strictEqual(dl[0].headers.Authorization, 'Bearer LINE-TOKEN-SECRET');
  const gem = w.req.gemini()[0];
  assert.deepStrictEqual(inlineOf(gem), [{ mimeType: 'image/jpeg', data: b64('img-A') }]);
  assert.strictEqual(textOf(gem), '這是什麼?');
  assert.deepStrictEqual(w.replyTexts().at(-1), '這是一隻貓');
  assert.deepStrictEqual(pendingOf(w), []);

  w.post(w.ev.text('U1', '再問一個'));
  assert.strictEqual(w.req.content().length, 1);
  assert.strictEqual(inlineOf(w.req.gemini().at(-1)).length, 0);
});

test('連傳 3 張後問問題 → 3 張都帶上(一次批次下載);傳第 4 張時最舊的被丟掉', () => {
  let w = createWorld();
  for (const id of ['i1', 'i2', 'i3']) w.post(w.ev.image('U1', { id }));
  w.post(w.ev.text('U1', '比較這些'));
  assert.deepStrictEqual(inlineOf(w.req.gemini()[0]).map((x) => x.data), ['i1', 'i2', 'i3'].map(b64));
  assert.strictEqual(w.stats.fetchAllCalls, 1);

  w = createWorld();
  for (const id of ['i1', 'i2', 'i3', 'i4']) w.post(w.ev.image('U1', { id }));
  assert.deepStrictEqual(pendingOf(w).map((p) => p.id), ['i2', 'i3', 'i4']);
  w.post(w.ev.text('U1', '比較這些'));
  assert.deepStrictEqual(w.req.content().map((r) => r.messageId), ['i2', 'i3', 'i4']);
});

test('IMAGE_PENDING_MAX 可調整', () => {
  const w = createWorld({ props: { IMAGE_PENDING_MAX: '1' } });
  for (const id of ['i1', 'i2']) w.post(w.ev.image('U1', { id }));
  assert.deepStrictEqual(pendingOf(w).map((p) => p.id), ['i2']);
});

test('超過 10 分鐘 → 不帶圖(假時鐘驗證邊界)', () => {
  let w = createWorld();
  w.post(w.ev.image('U1', { id: 'old' }));
  w.advance(601 * 1000);
  w.post(w.ev.text('U1', '這是什麼?'));
  assert.strictEqual(w.req.content().length, 0);
  assert.strictEqual(inlineOf(w.req.gemini()[0]).length, 0);
  assert.deepStrictEqual(pendingOf(w), [], '過期的待提問圖片會被清掉');

  w = createWorld();
  w.post(w.ev.image('U1', { id: 'fresh' }));
  w.advance(599 * 1000);
  w.post(w.ev.text('U1', '這是什麼?'));
  assert.strictEqual(inlineOf(w.req.gemini()[0]).length, 1);
});

test('IMAGE_PENDING_TTL_S 可調整;過期與新圖混在一起時只帶沒過期的', () => {
  const w = createWorld({ props: { IMAGE_PENDING_TTL_S: '60' } });
  w.post(w.ev.image('U1', { id: 'older' }));
  w.advance(50 * 1000);
  w.post(w.ev.image('U1', { id: 'newer' }));
  w.advance(20 * 1000); // older 已 70 秒、newer 20 秒
  w.post(w.ev.text('U1', '問'));
  assert.deepStrictEqual(w.req.content().map((r) => r.messageId), ['newer']);
});

test('歷史中該使用者訊息以「[圖片] 」前綴標記(只標記有過圖,不存圖);送給模型的當前訊息不帶前綴', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'img-A' }));
  w.post(w.ev.text('U1', '這是什麼?'));
  assert.strictEqual(textOf(w.req.gemini()[0]), '這是什麼?');
  const hist = w.stateOf('U1').history;
  assert.strictEqual(hist[0].t, '[圖片] 這是什麼?');
  assert.ok(!JSON.stringify(w.stateRow('U1')).includes(b64('img-A')));
  w.post(w.ev.text('U1', '再說一次'));
  assert.strictEqual(w.req.gemini()[1].body.contents[0].parts[0].text, '[圖片] 這是什麼?');
  assert.strictEqual(w.stateOf('U1').history[2].t, '再說一次', '沒有圖的訊息沒有前綴');
});

test('system prompt 說明「[圖片]」前綴只是標記', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', 'hi'));
  assert.match(sysOf(w.req.gemini()[0]), /「\[圖片\]」/);
});

test('下載圖片失敗 → 文字照常回答並告知圖片無法取得(模型也被告知看不到圖)', () => {
  const failures = [() => ({ status: 404, body: {} }), () => ({ throws: true }), () => ({ status: 200, bytes: Buffer.from('<html>'), headers: { 'Content-Type': 'text/html' } })];
  for (const f of failures) {
    const w = createWorld();
    w.images['bad'] = f;
    w.post(w.ev.image('U1', { id: 'bad' }));
    w.geminiQueue.push(g.text('我看不到耶'));
    w.post(w.ev.text('U1', '這是什麼?'));
    const gem = w.req.gemini()[0];
    assert.strictEqual(inlineOf(gem).length, 0);
    assert.match(sysOf(gem), /圖片無法取得/);
    const reply = w.lastReplyText();
    assert.ok(reply.startsWith('我看不到耶'));
    assert.match(reply, /1 張圖片無法取得/);
    assert.strictEqual(w.stateOf('U1').history[0].t, '這是什麼?', '沒有成功帶圖就不加前綴');
    assert.deepStrictEqual(pendingOf(w), []);
  }
});

test('部分圖片下載失敗:成功的照常帶上,失敗的告知', () => {
  const w = createWorld();
  w.images['bad'] = () => ({ status: 500, body: {} });
  for (const id of ['ok1', 'bad', 'ok2']) w.post(w.ev.image('U1', { id }));
  w.post(w.ev.text('U1', '看看'));
  assert.deepStrictEqual(inlineOf(w.req.gemini()[0]).map((x) => x.data), [b64('ok1'), b64('ok2')]);
  assert.match(w.lastReplyText(), /1 張圖片無法取得/);
  assert.strictEqual(w.stateOf('U1').history[0].t, '[圖片] 看看');
});

test('單張超過 10MB 就略過該張並在回覆中告知', () => {
  const w = createWorld();
  w.images['big'] = { status: 200, bytes: Buffer.from('BIG'), headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(10 * MB + 1) } };
  w.images['edge'] = { status: 200, bytes: Buffer.from('EDGE'), headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(10 * MB) } };
  for (const id of ['big', 'edge']) w.post(w.ev.image('U1', { id }));
  w.post(w.ev.text('U1', '看看'));
  assert.deepStrictEqual(inlineOf(w.req.gemini()[0]).map((x) => x.data), [Buffer.from('EDGE').toString('base64')]);
  assert.match(w.lastReplyText(), /1 張圖片超過 10MB/);
});

test('圖片格式以回應的內容類型為準(png 等),缺少時預設 jpeg', () => {
  const w = createWorld();
  w.images['p'] = { status: 200, bytes: Buffer.from('PNG'), headers: { 'content-type': 'image/png' } };
  w.images['n'] = { status: 200, bytes: Buffer.from('NOHDR'), headers: {} };
  for (const id of ['p', 'n']) w.post(w.ev.image('U1', { id }));
  w.post(w.ev.text('U1', '看看'));
  assert.deepStrictEqual(inlineOf(w.req.gemini()[0]).map((x) => x.mimeType), ['image/png', 'image/jpeg']);
});

test('模型呼叫失敗時待提問圖片保留,重問仍會帶圖', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'img-A' }));
  w.geminiQueue.push(g.status(400), g.text('這次成功'));
  w.post(w.ev.text('U1', '這是什麼?'));
  assert.deepStrictEqual(pendingOf(w).map((p) => p.id), ['img-A']);
  w.post(w.ev.text('U1', '再問一次這是什麼?'));
  assert.strictEqual(inlineOf(w.req.gemini()[1]).length, 1);
  assert.deepStrictEqual(pendingOf(w), []);
});

test('回答期間才到的新圖不會被吃掉:只清掉已消耗與已過期的', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'first' }));
  let fired = false;
  w.beforeGemini = () => { if (fired) return; fired = true; w.post(w.ev.image('U1', { id: 'second' })); };
  w.post(w.ev.text('U1', '問題一'));
  w.beforeGemini = null;
  assert.deepStrictEqual(pendingOf(w).map((p) => p.id), ['second']);
  w.post(w.ev.text('U1', '問題二'));
  assert.deepStrictEqual(inlineOf(w.req.gemini().at(-1)).map((x) => x.data), [b64('second')]);
});

test('不在白名單的人傳圖 → 只收到「尚未開通」,不記任何待提問圖片', () => {
  const w = createWorld();
  w.post(w.ev.image('U999'));
  assert.match(w.lastReplyText(), /尚未開通/);
  assert.strictEqual(w.stateRow('U999'), null);
});

test('同一個圖片事件重送只處理一次', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'img-A', eventId: 'dup' }));
  w.post(w.ev.image('U1', { id: 'img-A', eventId: 'dup' }));
  assert.strictEqual(w.req.replies().length, 1);
  assert.strictEqual(pendingOf(w).length, 1);
});

test('傳圖不算對話:不改變「與上一則訊息的間隔」', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '先聊一句'));
  w.advance(3 * 3600 * 1000);
  w.post(w.ev.image('U1', { id: 'img-A' }));
  w.advance(60 * 1000);
  w.post(w.ev.text('U1', '看這張'));
  assert.match(sysOf(w.req.gemini().at(-1)), /約 3 小時〔過了半天以上〕|約 3 小時〔隔了一陣子〕/);
});

test('熱請求傳圖:試算表讀取 0 次、一次寫入階段、沒有 appendRow', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '暖機'));
  w.resetStats();
  w.post(w.ev.image('U1', { id: 'img-A' }));
  assert.strictEqual(w.stats.reads, 0);
  assert.ok(w.stats.lockAcquires <= 1);
  assert.strictEqual(w.stats.appendRow, 0);
});

test('傳圖的 ack 不用 push 補送(即使 reply 失敗且 push 預算大於 0)', () => {
  const w = createWorld({ props: { PUSH_MONTHLY_BUDGET: '5' } });
  w.lineReplyHandler = () => ({ status: 400, body: { message: 'Invalid reply token' } });
  w.post(w.ev.image('U1', { id: 'img-A' }));
  assert.strictEqual(w.req.pushes().length, 0);
  assert.deepStrictEqual(pendingOf(w).map((p) => p.id), ['img-A'], '即使 reply 失敗,圖片仍被記下');
});

test('下載請求的 timeoutSeconds 不超過剩餘預算;金鑰不出現在日誌', () => {
  const w = createWorld({ props: { TIME_BUDGET_S: '20', BUDGET_RESERVE_S: '5' } });
  w.post(w.ev.image('U1', { id: 'img-A' }));
  w.post(w.ev.text('U1', '看'));
  const t = w.req.content()[0].timeoutSeconds;
  assert.ok(t >= 1 && t <= 15, 'timeout=' + t);
  assert.ok(!JSON.stringify(w.rows('Logs')).includes('LINE-TOKEN-SECRET'));
});

test('圖片搭配明令搜尋也能運作(圖與搜尋結果一起交給模型)', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'img-A' }));
  w.post(w.ev.text('U1', '幫我查一下這是哪裡'));
  assert.strictEqual(w.req.search().length, 1);
  assert.strictEqual(inlineOf(w.req.gemini()[0]).length, 1);
});

test('剛好 10 分鐘(600 秒)仍算「10 分鐘內」,會帶圖', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'img-A' }));
  w.advance(600 * 1000);
  w.post(w.ev.text('U1', '這是什麼?'));
  assert.strictEqual(inlineOf(w.req.gemini()[0]).length, 1);
});

test('送給模型的使用者訊息:圖片(內嵌)在前、文字在後', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'i1' }));
  w.post(w.ev.image('U1', { id: 'i2' }));
  w.post(w.ev.text('U1', '比較'));
  const parts = w.req.gemini()[0].body.contents.at(-1).parts;
  assert.deepStrictEqual(parts.map((p) => (p.inlineData ? 'img' : 'text')), ['img', 'img', 'text']);
});

test('模型呼叫失敗的回合不進入寫入階段(沒有提交失敗的日誌、沒有狀態變化)', () => {
  const w = createWorld();
  w.post(w.ev.image('U1', { id: 'img-A' }));
  const before = JSON.stringify(w.stateRow('U1'));
  w.geminiQueue.push(g.status(400));
  w.post(w.ev.text('U1', '這是什麼?'));
  assert.ok(!w.logs().some((l) => l.code === 'COMMIT_FAILED'));
  assert.strictEqual(JSON.stringify(w.stateRow('U1')), before);
});
