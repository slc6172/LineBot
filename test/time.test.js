'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const sysOf = (req) => req.body.systemInstruction.parts[0].text;
const lastSys = (w) => sysOf(w.req.gemini().at(-1));

// ---------- 次縫(純函式,表格式) ----------
test('periodOfDay_:時段邊界', () => {
  const w = createWorld();
  const table = [[0, '凌晨'], [4, '凌晨'], [5, '早上'], [10, '早上'], [11, '中午'], [12, '中午'], [13, '下午'], [17, '下午'], [18, '晚上'], [22, '晚上'], [23, '深夜']];
  for (const [h, name] of table) assert.strictEqual(w.call('periodOfDay_', h), name, h + ' 點');
});

test('gapLevel_:間隔分級邊界與行為提示', () => {
  const w = createWorld();
  const table = [
    [0, '接續'], [29 * MIN, '接續'], [30 * MIN, '隔了一陣子'], [6 * HOUR - MIN, '隔了一陣子'],
    [6 * HOUR, '過了半天以上'], [24 * HOUR - MIN, '過了半天以上'], [24 * HOUR, '隔了好幾天'],
    [7 * DAY - MIN, '隔了好幾天'], [7 * DAY, '很久沒聊'], [90 * DAY, '很久沒聊'], [-5000, '接續'],
  ];
  for (const [ms, name] of table) {
    const r = w.call('gapLevel_', ms);
    assert.strictEqual(r.name, name, ms + 'ms');
    assert.ok(r.hint.length > 5, '每級都附一句行為提示');
  }
});

test('formatGap_:間隔格式化', () => {
  const w = createWorld();
  const table = [
    [0, '不到 1 分鐘'], [59 * 1000, '不到 1 分鐘'], [MIN, '1 分鐘'], [29 * MIN, '29 分鐘'], [59 * MIN, '59 分鐘'],
    [HOUR, '1 小時'], [90 * MIN, '1 小時'], [23 * HOUR + 59 * MIN, '23 小時'], [DAY, '1 天'], [7 * DAY, '7 天'],
    [59 * DAY, '59 天'], [60 * DAY, '2 個月'], [365 * DAY, '12 個月'], [-1000, '不到 1 分鐘'],
  ];
  for (const [ms, text] of table) assert.strictEqual(w.call('formatGap_', ms), text, ms + 'ms');
});

// ---------- 主縫 ----------
test('system prompt 含正確的日期、星期、時分、時段(台北時間)', () => {
  const w = createWorld();
  w.setTaipei(2026, 11, 3, 21, 5); // 星期二 21:05
  w.post(w.ev.text('U1', 'hi'));
  const sys = lastSys(w);
  assert.match(sys, /2026年11月03日 \(星期二\) 21:05\(晚上\)/);
  assert.match(sys, /台北時間/);
});

test('時區由 TIMEZONE 設定決定', () => {
  const w = createWorld({ props: { TIMEZONE: 'Asia/Tokyo' } });
  w.setTaipei(2026, 11, 3, 23, 30); // 東京已是隔天 00:30
  w.post(w.ev.text('U1', 'hi'));
  assert.match(lastSys(w), /2026年11月04日 \(星期三\) 00:30\(凌晨\)/);
});

test('第一次對話:標明沒有上一則訊息,沒有間隔分級', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', 'hi'));
  const sys = lastSys(w);
  assert.match(sys, /第一次對話/);
  assert.ok(!/〔[^〕]+〕/.test(sys));
});

test('與上一則訊息的間隔與分級(假時鐘邊界值,走完整 doPost)', () => {
  const table = [
    [29 * MIN, '29 分鐘', '接續'], [30 * MIN, '30 分鐘', '隔了一陣子'], [6 * HOUR - MIN, '5 小時', '隔了一陣子'],
    [6 * HOUR, '6 小時', '過了半天以上'], [24 * HOUR - MIN, '23 小時', '過了半天以上'], [24 * HOUR, '1 天', '隔了好幾天'],
    [7 * DAY - MIN, '6 天', '隔了好幾天'], [7 * DAY, '7 天', '很久沒聊'],
  ];
  for (const [gap, shown, level] of table) {
    const w = createWorld();
    w.post(w.ev.text('U1', '先說一句'));
    w.advance(gap);
    w.post(w.ev.text('U1', '隔了一下'));
    const sys = lastSys(w);
    assert.ok(sys.includes('約 ' + shown + '〔' + level + '〕'), `gap=${gap} 應為 ${shown}〔${level}〕:\n${sys}`);
    for (const other of ['接續', '隔了一陣子', '過了半天以上', '隔了好幾天', '很久沒聊']) {
      if (other !== level) assert.ok(!sys.includes('〔' + other + '〕'), `不應出現 〔${other}〕`);
    }
  }
});

test('system prompt 含時間行為指示(不逐項報時、不把久遠對話當剛剛、不複述時間註記)', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', 'hi'));
  const sys = lastSys(w);
  assert.match(sys, /自然反應/);
  assert.match(sys, /不要逐項報時,除非使用者詢問/);
  assert.match(sys, /不要把很久以前的對話當成剛剛才發生的事/);
  assert.match(sys, /時間註記.*不要複述/);
});

test('原有規則仍在(繁體中文、不評論知識截止日期、純文字)', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', 'hi'));
  const sys = lastSys(w);
  assert.match(sys, /使用繁體中文回答/);
  assert.match(sys, /知識截止日/);
  assert.match(sys, /直接輸出純文字/);
});

test('間隔達 GAP_MARKER_MINUTES 的訊息在送給模型的內容前帶「(距上一句約…)」註記;存回狀態的原文沒有', () => {
  const w = createWorld();
  w.geminiQueue.push(g.text('答A'), g.text('答B'), g.text('答C'));
  w.post(w.ev.text('U1', 'A訊息'));
  w.advance(31 * MIN);
  w.post(w.ev.text('U1', 'B訊息'));
  w.advance(3 * MIN);
  w.post(w.ev.text('U1', 'C訊息'));
  const texts = w.req.gemini().at(-1).body.contents.map((c) => c.parts[0].text);
  assert.deepStrictEqual(texts, ['A訊息', '答A', '(距上一句約 31 分鐘) B訊息', '答B', 'C訊息']);
  // 存回狀態的是原文
  const hist = w.stateOf('U1').history;
  assert.ok(!JSON.stringify(hist).includes('距上一句'));
  assert.deepStrictEqual(hist.map((h) => h.t), ['A訊息', '答A', 'B訊息', '答B', 'C訊息', '答C']);
});

test('新的這則訊息若與上一句隔了很久,同樣帶註記', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', '舊的'));
  w.advance(3 * DAY);
  w.post(w.ev.text('U1', '新的'));
  const last = w.req.gemini().at(-1).body.contents.at(-1).parts[0].text;
  assert.strictEqual(last, '(距上一句約 3 天) 新的');
});

test('GAP_MARKER_MINUTES 可調整', () => {
  const w = createWorld({ props: { GAP_MARKER_MINUTES: '5' } });
  w.post(w.ev.text('U1', 'A'));
  w.advance(6 * MIN);
  w.post(w.ev.text('U1', 'B'));
  assert.strictEqual(w.req.gemini().at(-1).body.contents.at(-1).parts[0].text, '(距上一句約 6 分鐘) B');
});

test('歷史中每則訊息都記錄時間戳', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', 'A'));
  w.advance(10 * MIN);
  w.post(w.ev.text('U1', 'B'));
  const hist = w.stateOf('U1').history;
  assert.strictEqual(hist.length, 4);
  assert.ok(hist.every((h) => Number.isFinite(h.ts) && h.ts > 0));
  assert.strictEqual(hist[2].ts - hist[0].ts, 10 * MIN);
});

test('不做日常作息與安靜時段:深夜也照常回覆', () => {
  const w = createWorld();
  w.setTaipei(2026, 11, 3, 3, 0);
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.replyTexts().length, 1);
  assert.strictEqual(w.req.gemini().length, 1);
});

test('時間註記只加在使用者訊息,模型的回覆不加(即使經過搜尋回得很慢)', () => {
  const w = createWorld({ props: { GAP_MARKER_MINUTES: '1', TIME_BUDGET_S: '240' } });
  w.geminiQueue.push(g.delay(35000, g.call('web_search', { query: '天氣預報' }, 'x')), g.delay(35000, g.text('慢慢的回答')));
  w.post(w.ev.text('U1', '問題'));
  w.post(w.ev.text('U1', '追問'));
  const texts = w.req.gemini().at(-1).body.contents.map((c) => c.parts[0].text);
  assert.deepStrictEqual(texts, ['問題', '慢慢的回答', '追問']);
});
