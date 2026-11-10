'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

test('一次請求的日誌在請求結束時一次寫入(Logs 表只被寫一次)', () => {
  const w = createWorld();
  w.geminiQueue.push(g.status(429), g.text('好'));
  w.lineReplyHandler = () => ({ status: 400, body: { message: 'Invalid reply token' } });
  w.post(w.ev.text('U1', 'hi')); // 會產生 GEMINI_RETRY 與 LINE_REPLY_FAILED 兩筆
  assert.ok(w.logs().length >= 2);
  assert.strictEqual(w.stats.writesByName.Logs, 2 /* 建表標題列 + 批次寫入 */);
  assert.strictEqual(w.stats.appendRow, 0);
});

test('沒有任何日誌時,Logs 表完全沒有寫入', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '暖機')); // 暖機(可能有 KEY_MISSING 之類的狀態日誌)
  w.props.TINYFISH_API_KEY = 'TINYFISH-KEY-SECRET';
  w.resetStats();
  w.post(w.ev.text('U1', '正常請求'));
  assert.strictEqual(w.stats.writesByName.Logs, undefined);
  assert.strictEqual(w.stats.writesByName.State, 1);
});

test('沒有日誌也沒有狀態變化的請求完全不碰試算表', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '暖機'));
  w.resetStats();
  w.post(w.ev.sticker('U1'));
  w.post(w.ev.follow('U1'));
  assert.strictEqual(w.stats.openById, 0);
  assert.strictEqual(w.stats.writes, 0);
});

test('日誌列不含使用者訊息、模型回覆、金鑰', () => {
  const w = createWorld();
  w.geminiQueue.push(g.status(429), g.status(429));
  w.post(w.ev.text('U1', '使用者的秘密訊息-ALPHA'));
  w.geminiQueue.push(g.text('模型的回覆-BETA'));
  w.lineReplyHandler = () => ({ status: 400, body: { message: 'Invalid reply token' } });
  w.post(w.ev.text('U1', '另一則秘密-GAMMA'));
  w.post(w.ev.text('U9', '陌生人訊息-DELTA'));
  const dump = JSON.stringify(w.rows('Logs'));
  for (const s of ['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'GEMINI-KEY-SECRET', 'LINE-TOKEN-SECRET']) assert.ok(!dump.includes(s), s);
  assert.ok(w.logs().length >= 3);
});

test('日誌的細節字數有上限,且已知金鑰一律被遮蔽(即使意外混入)', () => {
  const w = createWorld();
  w.lineReplyHandler = () => ({ status: 400, body: { message: 'bad token LINE-TOKEN-SECRET ' + 'x'.repeat(500) } });
  w.post(w.ev.text('U1', 'hi'));
  const e = w.logs().find((l) => l.code === 'LINE_REPLY_FAILED');
  assert.ok(!e.detail.includes('LINE-TOKEN-SECRET'));
  assert.ok(e.detail.length <= 200);
});

test('日誌超過 LOG_MAX_ROWS 加緩衝後,最舊的一段被刪除,最新的保留', () => {
  const w = createWorld({ props: { LOG_MAX_ROWS: '50' } });
  const rows = [['time', 'level', 'code', 'chat_id', 'detail']];
  for (let i = 1; i <= 160; i++) rows.push(['t', '狀態', 'SEED', '', 'seed-' + i]);
  w.setRows('Logs', rows);
  w.post(w.ev.text('U1', 'x'), { key: 'bad' }); // 新增一筆 BAD_KEY
  const logs = w.logs();
  assert.strictEqual(logs.length, 50, '輪替後剛好保留 LOG_MAX_ROWS 筆(含新增的這筆)');
  assert.strictEqual(logs.at(-1).code, 'BAD_KEY');
  assert.strictEqual(logs[0].detail, 'seed-112');
  assert.ok(w.stats.deleteRows >= 1);
});

test('日誌未超過緩衝時不刪除', () => {
  const w = createWorld({ props: { LOG_MAX_ROWS: '50' } });
  const rows = [['time', 'level', 'code', 'chat_id', 'detail']];
  for (let i = 1; i <= 120; i++) rows.push(['t', '狀態', 'SEED', '', 'seed-' + i]); // 120 < 50+100
  w.setRows('Logs', rows);
  w.post(w.ev.text('U1', 'x'), { key: 'bad' });
  assert.strictEqual(w.stats.deleteRows, 0);
  assert.strictEqual(w.logs().length, 121);
});

test('DEBUG_TIMING 開啟:額外記錄各儲存操作與外部呼叫的耗時(除錯等級)', () => {
  const w = createWorld({ props: { DEBUG_TIMING: 'true' } });
  w.latency.openById = 1234;
  w.latency.getValues = 20;
  w.geminiFallback = () => g.delay(800, g.text('慢一點'));
  w.post(w.ev.text('U1', 'hi'));
  const dbg = w.logs().filter((l) => l.level === '除錯');
  assert.ok(dbg.length > 0);
  const open = dbg.find((l) => l.detail.startsWith('sheet.open'));
  assert.ok(open && open.detail.includes('1234ms'), JSON.stringify(dbg));
  assert.ok(dbg.some((l) => l.detail.startsWith('http generativelanguage.googleapis.com') && l.detail.includes('800ms')));
  assert.ok(dbg.some((l) => l.detail.startsWith('sheet.read')));
  assert.ok(dbg.every((l) => l.code === 'TIMING'));
});

test('DEBUG_TIMING 關閉時沒有任何除錯日誌', () => {
  const w = createWorld();
  w.latency.openById = 1234;
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.logs().filter((l) => l.level === '除錯').length, 0);
});

test('第一個請求就沒有任何日誌時,連 Logs 表都不會被建立', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '第一則')); // 預設設定齊全 → 無日誌
  assert.strictEqual(w.logs().length, 0);
  assert.strictEqual(w.sheets.Logs, undefined);
});

test('日誌內容以 = + - @ 開頭時,Logs 表存的是純文字,不會被試算表當成公式', () => {
  const w = createWorld();
  const rc = w.call('createRequestContext');
  w.call('logAdd', rc, 'STATUS', 'TEST', '', '=IMPORTDATA("x")');
  w.call('logAdd', rc, 'STATUS', 'TEST', '', '+1');
  w.call('logAdd', rc, 'STATUS', 'TEST', '', '@SUM(1)');
  w.call('logAdd', rc, 'STATUS', 'TEST', '', '-2');
  w.call('writePhase', rc, () => {});
  const details = w.logs().map((x) => x.detail);
  assert.strictEqual(details.length, 4);
  // 要嘛整欄設成純文字(讀回原值),要嘛原值前面加了 ' 前綴;兩者都不會讓以 = 開頭的字串被求值
  assert.ok(w.logs().length === 4 && w.sheets.Logs.plainText === true, 'Logs 表應為純文字格式');
  assert.deepStrictEqual(details, ['=IMPORTDATA("x")', '+1', '@SUM(1)', '-2']);
});
