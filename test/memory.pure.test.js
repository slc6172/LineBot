'use strict';
// 次縫:記憶相關的純函式(表格式測試)
const test = require('node:test');
const assert = require('node:assert');
const { createWorld } = require('./world');

const w = createWorld();
const call = (fn, ...args) => w.call(fn, ...args);

// ---------- bigram ----------
test('bigrams_:相鄰兩字,濾掉含常用虛字的字組,小寫、去重、標點斷開', () => {
  const table = [
    ['台北天氣', ['台北', '北天', '天氣']],
    ['我的貓咪', ['貓咪']],
    ['你好嗎', []],
    ['台北,天氣', ['台北', '天氣']],
    ['Hello World', ['he', 'el', 'll', 'lo', 'wo', 'or', 'rl', 'ld']],
    ['aaaa', ['aa']],
    ['', []],
    ['a', []],
    ['貓咪貓咪', ['貓咪', '咪貓']],
  ];
  for (const [text, expected] of table) assert.deepStrictEqual(call('bigrams_', text), expected, JSON.stringify(text));
});

// ---------- 檢索 ----------
const D = (text, date, label) => ({ text, date: date || '', label: label || '日誌' });
const retrieve = (query, docs, k, snip, min) => call('retrieveDocs_', query, docs, k || 3, snip || 200, min === undefined ? 0.6 : min);

test('retrieveDocs_:共用字組的文件被找到,附日期與標籤', () => {
  const hits = retrieve('我想去富士山看雪', [D('去年在富士山拍了雪景', '2025-12-01', '日誌'), D('昨天吃了拉麵', '2026-01-02', '日誌')]);
  assert.deepStrictEqual(hits, [{ date: '2025-12-01', label: '日誌', snippet: '去年在富士山拍了雪景' }]);
});

test('retrieveDocs_:兩個字的詞就足以找到', () => {
  assert.strictEqual(retrieve('聊聊露營', [D('上個月去露營', '2026-01-01')]).length, 1);
});

test('retrieveDocs_:只出現在單一文件的字組權重恰為 1;出現在全部文件的字組權重低於門檻', () => {
  // N=3:df=1 → ln(4)/ln(4)=1;df=3 → ln(2)/ln(4)=0.5 < 0.6
  const docs = [D('貓咪很可愛', '2026-01-01'), D('貓咪愛睡覺', '2026-01-02'), D('貓咪愛吃魚', '2026-01-03')];
  assert.deepStrictEqual(retrieve('貓咪', docs), []);
  assert.strictEqual(retrieve('貓咪睡覺', docs).length, 1); // 「睡覺」只在一份 → 1 分
});

test('retrieveDocs_:一個稀有字組勝過兩個常見字組', () => {
  const docs = [D('旅行 計畫 預算', '2026-01-01'), D('旅行 計畫 行程', '2026-01-02'), D('旅行 計畫', '2026-01-03'), D('富士山登山', '2026-01-04')];
  const hits = retrieve('旅行計畫富士山', docs, 4, 200, 0.1);
  assert.strictEqual(hits[0].snippet, '富士山登山');
});

test('retrieveDocs_:同分時較新的優先;最多取 k 筆', () => {
  const docs = [D('小明生日派對', '2025-01-01'), D('小明生日蛋糕', '2025-06-01'), D('其他事情', '2025-07-01'), D('小明生日禮物', '2025-12-01')];
  const hits = retrieve('小明生日', docs, 2, 200, 0.1);
  assert.deepStrictEqual(hits.map((h) => h.date), ['2025-12-01', '2025-06-01']);
});

test('retrieveDocs_:片段截成 snippetChars,關鍵字附近優先,過長處加「…」', () => {
  const long = '前'.repeat(300) + '富士山' + '後'.repeat(300);
  const [hit] = retrieve('富士山', [D(long, '2026-01-01')], 3, 50);
  assert.ok(hit.snippet.length <= 52, String(hit.snippet.length));
  assert.ok(hit.snippet.includes('富士山'));
  assert.ok(hit.snippet.startsWith('…') && hit.snippet.endsWith('…'));
  assert.strictEqual(retrieve('短文', [D('短文一則', '')], 3, 50)[0].snippet, '短文一則');
});

test('retrieveDocs_:沒有可用字組或沒有文件 → 空;門檻可調', () => {
  assert.deepStrictEqual(retrieve('你好嗎', [D('你好嗎', '')]), []);
  assert.deepStrictEqual(retrieve('台北天氣', []), []);
  const docs = [D('貓咪很可愛', ''), D('貓咪愛睡覺', ''), D('貓咪愛吃魚', '')];
  assert.strictEqual(retrieve('貓咪', docs, 3, 200, 0.4).length, 3);
});

// ---------- 整理結果驗證 ----------
const facts = (o) => Object.assign({ user: [], shared: [], followups: [] }, o);

test('normalizeFold_:合法結果被正規化(事實成「- 」開頭的行,空區段不留)', () => {
  const r = call('normalizeFold_', {
    events: [{ date: '2026-11-01', text: '  去了露營 ' }],
    facts: facts({ user: ['喜歡貓', ' 住台北 '], shared: [], followups: ['下週三回診'], earlier_summary: '  之前聊過旅行 ' }),
  }, '2026-10-30');
  assert.deepStrictEqual(r.events, [{ date: '2026-11-01', text: '去了露營' }]);
  assert.deepStrictEqual(r.facts, { 使用者: '- 喜歡貓\n- 住台北', 待跟進: '- 下週三回診', 更早的摘要: '之前聊過旅行' });
});

test('normalizeFold_:事件最多 10 筆、各截 80 字、日期不合法改用備用日期、沒有內容的略過', () => {
  const events = [];
  for (let i = 0; i < 14; i++) events.push({ date: '2026-11-0' + ((i % 9) + 1), text: '事' + i });
  events[0] = { date: '下週三', text: '字'.repeat(200) };
  events[1] = { date: '2026-13-45', text: '格式像日期但月份不存在' };
  events[2] = { date: '2026-11-02', text: '   ' };
  events[3] = { date: '2026-11-02' };
  events[4] = 'oops';
  const r = call('normalizeFold_', { events, facts: facts({}) }, '2026-10-30');
  assert.ok(r.events.length <= 10);
  assert.strictEqual(r.events[0].date, '2026-10-30');
  assert.strictEqual(r.events[0].text.length, 80);
  assert.strictEqual(r.events[1].date, '2026-10-30');
  assert.ok(r.events.every((e) => e.text.trim() && /^\d{4}-\d{2}-\d{2}$/.test(e.date)));
});

test('normalizeFold_:缺少必要區段、區段不是陣列、不是物件 → 整份視為無效(null)', () => {
  const bad = [
    null, 'x', 42, [], {}, { events: [] }, { facts: facts({}) }, { events: 'x', facts: facts({}) },
    { events: [], facts: { user: [], shared: [] } }, { events: [], facts: { user: 'a', shared: [], followups: [] } },
    { events: [], facts: { user: [], shared: {}, followups: [] } }, { events: [], facts: [] },
  ];
  for (const b of bad) assert.strictEqual(call('normalizeFold_', b, '2026-10-30'), null, JSON.stringify(b));
});

test('normalizeFold_:earlier_summary 可省略;非字串的事實行被丟掉', () => {
  const r = call('normalizeFold_', { events: [], facts: facts({ user: ['a', 3, null, ''], shared: ['b'] }) }, '2026-10-30');
  assert.deepStrictEqual(r.facts, { 使用者: '- a', 共同經歷: '- b' });
});

// ---------- 常駐區塊 ----------
const F = { 使用者: '- 喜歡貓\n- 住台北', 共同經歷: '- 一起去過露營', 待跟進: '- 下週三回診', 更早的摘要: '去年聊過很多旅行' };

test('fitFacts_:依固定順序顯示,超過上限時保留前面的區段與每區段前面的行(標題不計字數)', () => {
  const order = call('fitFacts_', F, 10000).map((x) => x[0]);
  assert.deepStrictEqual(order, ['使用者', '共同經歷', '待跟進', '更早的摘要']);
  const tight = { 使用者: ['- 12345678', '- 12345678', '- 12345678'].join('\n'), 共同經歷: '- 12' };
  assert.deepStrictEqual(call('fitFacts_', tight, 25), [['使用者', ['- 12345678', '- 12345678']]]);
  assert.deepStrictEqual(call('fitFacts_', {}, 100), []);
});

test('longTermBlock_ 與 leftOutFactLines_', () => {
  const block = call('longTermBlock_', F, 10000);
  assert.ok(block.startsWith('\n\n【長期記憶(自然運用,不要逐條複述)】\n〔使用者〕\n- 喜歡貓\n- 住台北\n〔共同經歷〕'));
  assert.strictEqual(call('longTermBlock_', {}, 100), '');
  const tight = { 使用者: ['- 12345678', '- 12345678', '- 12345678'].join('\n'), 共同經歷: '- 12' };
  assert.deepStrictEqual(call('leftOutFactLines_', tight, 25), ['- 12345678', '- 12']);
  assert.deepStrictEqual(call('leftOutFactLines_', F, 10000), []);
});

test('journalBlock_:昨天與今天各自限制字數,超過時保留最新的行', () => {
  const ev = (date, text) => ({ date, text });
  const block = call('journalBlock_', '2026-11-02', '2026-11-03',
    [ev('2026-11-02', '昨天一'), ev('2026-11-02', '昨天二')],
    [ev('2026-11-03', '今天甲甲甲'), ev('2026-11-03', '今天乙乙乙'), ev('2026-11-03', '今天丙丙丙')], 16);
  assert.strictEqual(block, '\n\n【最近的日誌】\n昨天 2026-11-02:\n- 昨天一\n- 昨天二\n今天 2026-11-03:\n- 今天乙乙乙\n- 今天丙丙丙');
  assert.strictEqual(call('journalBlock_', '2026-11-02', '2026-11-03', [], [], 600), '');
});

test('retrievalBlock_:標明片段不一定準確', () => {
  const block = call('retrievalBlock_', [{ date: '2025-12-01', label: '日誌', snippet: '去了富士山' }, { date: '', label: '長期記憶', snippet: '- 喜歡貓' }]);
  assert.ok(block.includes('【可能相關的記憶】') && block.includes('不一定完全準確'));
  assert.ok(block.includes('- 2025-12-01 日誌:去了富士山') && block.includes('- 長期記憶:- 喜歡貓'));
  assert.strictEqual(call('retrievalBlock_', []), '');
});
