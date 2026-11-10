'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const FACTS = { 使用者: '- 喜歡貓\n- 住台北', 共同經歷: '- 一起去過露營', 待跟進: '- 下週三回診', 更早的摘要: '去年聊過很多旅行' };
const DAY = 24 * 3600 * 1000;
const sysOf = (w) => w.req.gemini().filter((r) => !(r.body.generationConfig && r.body.generationConfig.responseMimeType)).at(-1).body.systemInstruction.parts[0].text;
const recallBlock = (sys) => (sys.includes('【可能相關的記憶】') ? sys.split('【可能相關的記憶】')[1].split('\n\n【')[0] : '');

function seeded(props, o) {
  const w = createWorld({ props });
  o = o || {};
  w.setState('U1', { facts: o.facts === undefined ? FACTS : o.facts, meta: { folds: 1 }, history: o.history || [] });
  return w;
}
const ask = (w, text) => { w.post(w.ev.text('U1', text)); return sysOf(w); };

// ---------- 常駐注入 ----------
test('長期事實(四個區段,依序)出現在 system prompt', () => {
  const sys = ask(seeded(), '你好嗎');
  assert.ok(sys.includes('【長期記憶(自然運用,不要逐條複述)】\n〔使用者〕\n- 喜歡貓\n- 住台北\n〔共同經歷〕\n- 一起去過露營\n〔待跟進〕\n- 下週三回診\n〔更早的摘要〕\n去年聊過很多旅行'));
});

test('長期事實超過 LONG_TERM_MAX_CHARS:保留前面的區段與每區段前面的行,標題不計字數', () => {
  const lines = []; for (let i = 0; i < 30; i++) lines.push('- ' + '字'.repeat(10) + i);
  const w = seeded({ LONG_TERM_MAX_CHARS: '200' }, { facts: { 使用者: lines.join('\n'), 共同經歷: '- 共同的事' } });
  const sys = ask(w, '你好嗎');
  const block = sys.split('【長期記憶(自然運用,不要逐條複述)】')[1].split('\n\n【')[0];
  assert.ok(block.includes('字字字字字字字字字字0') && !block.includes('字字字字字字字字字字29'));
  assert.ok(!block.includes('共同的事'));
  assert.ok(block.length < 260);
});

test('今天與昨天的日誌出現在 system prompt;更早的不在常駐區塊;超過 RECENT_NOTES_MAX_CHARS 保留最新的行', () => {
  const w = seeded({ RECENT_NOTES_MAX_CHARS: '30' });
  w.addEvents('U1', [
    { date: '2026-10-20', text: '很久以前的事件' }, { date: '2026-11-02', text: '昨天的事件' },
    { date: '2026-11-03', text: '今天最舊的事件甲甲甲' }, { date: '2026-11-03', text: '今天較新的事件乙乙乙' }, { date: '2026-11-03', text: '今天最新的事件丙丙丙' },
  ]);
  const sys = ask(w, '你好嗎');
  const block = sys.split('【最近的日誌】')[1].split('\n\n【')[0];
  assert.ok(block.includes('昨天 2026-11-02:\n- 昨天的事件'));
  assert.ok(block.includes('今天 2026-11-03:') && block.includes('丙丙丙') && !block.includes('甲甲甲'));
  assert.ok(!block.includes('很久以前的事件'));
});

test('沒有任何記憶、或記憶功能關閉(MEMORY_ENABLED=false)時,system prompt 沒有記憶區塊', () => {
  let w = createWorld();
  const sys = ask(w, '你好嗎');
  for (const t of ['【長期記憶', '【最近的日誌】', '【可能相關的記憶】']) assert.ok(!sys.includes(t), t);
  w = seeded({ MEMORY_ENABLED: 'false' });
  w.addEvents('U1', [{ date: '2026-11-03', text: '今天的事件' }]);
  const sys2 = ask(w, '你好嗎');
  for (const t of ['【長期記憶', '【最近的日誌】', '【可能相關的記憶】', '喜歡貓']) assert.ok(!sys2.includes(t), t);
});

test('日誌的「昨天」依 TIMEZONE 計算', () => {
  const w = seeded({ TIMEZONE: 'Asia/Tokyo' });
  w.setTaipei(2026, 11, 3, 23, 30); // 東京已是 11-04 00:30
  w.addEvents('U1', [{ date: '2026-11-03', text: '東京的昨天事件' }]);
  assert.ok(ask(w, '你好嗎').includes('昨天 2026-11-03:\n- 東京的昨天事件'));
});

// ---------- 檢索 ----------
function archiveWorld(props) {
  const w = seeded(props);
  w.addArchive('U1', [
    { ts: Date.UTC(2026, 7, 1), role: 'u', text: '我去年十二月去了富士山拍雪景' },
    { ts: Date.UTC(2026, 7, 2), role: 'm', text: '富士山的雪景很美,記得帶保暖衣物' },
    { ts: Date.UTC(2026, 8, 5), role: 'u', text: '今天午餐吃了拉麵' },
  ]);
  return w;
}

test('與舊話題相關的新訊息 → 檢索片段出現在 system prompt(帶日期與標籤);不相關的閒聊 → 不出現', () => {
  const w = archiveWorld();
  const block = recallBlock(ask(w, '我想再去富士山看雪'));
  assert.ok(block.includes('2026-08-01') && block.includes('富士山拍雪景'), block);
  assert.ok(block.includes('更早的對話'));
  assert.strictEqual(recallBlock(ask(archiveWorld(), '最近睡得不太好')), '');
});

test('檢索純本機:不增加任何模型呼叫', () => {
  const w = archiveWorld();
  ask(w, '我想再去富士山看雪');
  assert.strictEqual(w.req.gemini().length, 1);
});

test('短於 RETRIEVAL_MIN_MESSAGE_CHARS 的訊息不檢索', () => {
  const w = archiveWorld();
  assert.strictEqual(recallBlock(ask(w, '富士')), '');
  assert.notStrictEqual(recallBlock(ask(archiveWorld(), '富士山')), '');
});

test('候選語料:不在今天或昨天的日誌事件可被檢索;今天或昨天的(已常駐)不重複檢索', () => {
  const w = seeded();
  w.addEvents('U1', [{ date: '2026-09-10', text: '去京都賞楓並吃了抹茶甜點' }, { date: '2026-11-02', text: '昨天討論了牙醫預約' }, { date: '2026-11-03', text: '今天研究了鋼琴課程' }]);
  const sysOld = ask(w, '想再聊聊京都賞楓');
  assert.ok(recallBlock(sysOld).includes('2026-09-10 日誌:去京都賞楓並吃了抹茶甜點'));
  const sysNew = ask(w, '聊聊牙醫預約與鋼琴課程');
  assert.ok(sysNew.includes('昨天的事件') === false);
  assert.ok(sysNew.includes('昨天討論了牙醫預約') && sysNew.includes('今天研究了鋼琴課程'), '常駐日誌有');
  assert.strictEqual(recallBlock(sysNew), '', '已在常駐區塊的事件不重複檢索');
});

test('候選語料:沒放進常駐區塊的事實行可被檢索;已在常駐區塊的不重複', () => {
  const lines = []; for (let i = 0; i < 30; i++) lines.push('- 第' + i + '項事實內容字字字字字');
  lines.push('- 特別喜歡收集郵票與古幣');
  const w = seeded({ LONG_TERM_MAX_CHARS: '200' }, { facts: { 使用者: lines.join('\n') } });
  const sys = ask(w, '最近有在收集郵票嗎');
  assert.ok(!sys.split('【長期記憶')[1].split('\n\n【')[0].includes('郵票'), '郵票那行沒放進常駐區塊');
  assert.ok(recallBlock(sys).includes('長期記憶:- 特別喜歡收集郵票與古幣'));
  const w2 = seeded();
  assert.strictEqual(recallBlock(ask(w2, '你還記得我喜歡貓嗎')), '', '常駐區塊已有的不重複');
});

test('候選語料:只搜尋歸檔最近 ARCHIVE_SCAN_LIMIT 筆', () => {
  const w = seeded({ ARCHIVE_SCAN_LIMIT: '2' });
  w.addArchive('U1', [
    { ts: 1, role: 'u', text: '很久以前聊過富士山' }, { ts: 2, role: 'u', text: '近期聊了拉麵' }, { ts: 3, role: 'u', text: '近期聊了咖啡' },
  ]);
  assert.strictEqual(recallBlock(ask(w, '想聊聊富士山')), '');
  const w2 = seeded({ ARCHIVE_SCAN_LIMIT: '3' });
  w2.addArchive('U1', [{ ts: 1, role: 'u', text: '很久以前聊過富士山' }, { ts: 2, role: 'u', text: '近期聊了拉麵' }, { ts: 3, role: 'u', text: '近期聊了咖啡' }]);
  assert.notStrictEqual(recallBlock(ask(w2, '想聊聊富士山')), '');
});

test('候選語料:State 內早於原文窗口但尚未整理的訊息可被檢索;窗口內的不重複', () => {
  const t = Date.UTC(2026, 9, 1);
  const hist = [];
  hist.push({ r: 'u', t: '我養了一隻柴犬叫阿福', ts: t }, { r: 'm', t: '阿福好可愛', ts: t });
  hist.push({ r: 'u', t: '最近在學小提琴', ts: t + 1 }, { r: 'm', t: '小提琴很有趣', ts: t + 1 });
  for (let i = 3; i <= 5; i++) hist.push({ r: 'u', t: '閒聊第' + i, ts: t + i }, { r: 'm', t: '好的第' + i, ts: t + i });
  const w = seeded({ HISTORY_MAX_TURNS: '3' }, { history: hist });
  assert.ok(recallBlock(ask(w, '阿福最近好嗎')).includes('我養了一隻柴犬叫阿福'));
  const w2 = seeded({ HISTORY_MAX_TURNS: '3' }, { history: hist });
  assert.strictEqual(recallBlock(ask(w2, '閒聊第4的內容')), '', '窗口內的訊息本來就送給模型,不再檢索');
});

test('汙染回合的回覆不進語料(歸檔與 State 內都一樣)', () => {
  const w = seeded();
  w.addArchive('U1', [{ ts: 1, role: 'm', text: '網頁說富士山今年封山-SECRETPAGE', polluted: true }]);
  assert.ok(!ask(w, '富士山還能去嗎').includes('SECRETPAGE'));
  const t = Date.UTC(2026, 9, 1);
  const hist = [{ r: 'u', t: '查一下富士山', ts: t }, { r: 'm', t: '富士山網頁內容-SECRETSTATE', ts: t, p: 1 }];
  for (let i = 3; i <= 6; i++) hist.push({ r: 'u', t: '閒聊第' + i, ts: t + i }, { r: 'm', t: '好的第' + i, ts: t + i });
  const w2 = seeded({ HISTORY_MAX_TURNS: '3' }, { history: hist });
  assert.ok(!ask(w2, '富士山還能去嗎').includes('SECRETSTATE'));
});

test('只檢索這個聊天室自己的資料(其他聊天室與群組的不會出現)', () => {
  const w = seeded();
  w.addArchive('U2', [{ ts: 1, role: 'u', text: '別人的對話提到富士山-OTHERCHAT' }]);
  w.addEvents('C9', [{ date: '2026-01-01', text: '群組事件富士山-OTHEREVENT' }]);
  const sys = ask(w, '想聊聊富士山');
  assert.ok(!sys.includes('OTHERCHAT') && !sys.includes('OTHEREVENT'));
});

test('最多 RETRIEVAL_K 筆,每筆截成 RETRIEVAL_SNIPPET_CHARS;同分時較新的優先', () => {
  const w = seeded({ RETRIEVAL_K: '2', RETRIEVAL_SNIPPET_CHARS: '30' });
  w.addArchive('U1', [
    { ts: Date.UTC(2026, 0, 1), role: 'u', text: '小明生日派對' + '甲'.repeat(100) },
    { ts: Date.UTC(2026, 1, 1), role: 'u', text: '小明生日蛋糕' + '乙'.repeat(100) },
    { ts: Date.UTC(2026, 2, 1), role: 'u', text: '小明生日禮物' + '丙'.repeat(100) },
  ]);
  const lines = recallBlock(ask(w, '聊聊小明生日')).split('\n').filter((l) => l.startsWith('- '));
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].includes('2026-03-01') && lines[1].includes('2026-02-01'));
  assert.ok(lines.every((l) => l.length <= 60));
});

test('RETRIEVAL_K=0 時不檢索', () => {
  assert.strictEqual(recallBlock(ask(archiveWorld({ RETRIEVAL_K: '0' }), '我想再去富士山看雪')), '');
});

// ---------- 存取預算與快取 ----------
test('熱請求:檢索語料與日誌來自快取,試算表讀取 0 次', () => {
  const w = archiveWorld();
  w.addEvents('U1', [{ date: '2026-11-03', text: '今天的事件' }]);
  ask(w, '暖機一下喔');
  w.resetStats();
  const sys = ask(w, '我想再去富士山看雪');
  assert.strictEqual(w.stats.reads, 0);
  assert.ok(recallBlock(sys).includes('富士山拍雪景'));
  assert.ok(w.stats.lockAcquires <= 1);
});

test('冷請求:讀取階段不超過 2 次(使用者、狀態、事件、歸檔連續讀取),且內容正確', () => {
  const w = archiveWorld();
  w.addEvents('U1', [{ date: '2026-11-03', text: '今天的事件' }]);
  w.clearCache();
  w.resetStats();
  const sys = ask(w, '我想再去富士山看雪');
  assert.ok(w.readPhases() <= 2, 'phases=' + w.readPhases() + ' ops=' + w.ops.join(','));
  assert.ok(recallBlock(sys).includes('富士山拍雪景') && sys.includes('今天的事件'));
  assert.strictEqual(w.stats.appendRow, 0);
});

test('從來沒整理過的聊天室不讀 Events / Archive 兩張表', () => {
  const w = createWorld();
  w.addEvents('U1', [{ date: '2026-11-03', text: '不該被讀到' }]);
  w.post(w.ev.text('U1', '暖機'));
  w.clearCache();
  w.resetStats();
  w.post(w.ev.text('U1', '再說一次'));
  assert.strictEqual(w.stats.readsByName.Events, undefined);
  assert.strictEqual(w.stats.readsByName.Archive, undefined);
});

test('語料超過 90KB 不放快取、直接走試算表,結果仍正確', () => {
  const w = seeded({ ARCHIVE_SCAN_LIMIT: '5000' });
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push({ ts: 1000 + i, role: 'u', text: ('字' + i).repeat(60).slice(0, 300) });
  rows.push({ ts: 5000, role: 'u', text: '提到了獨特的火星探測任務' });
  w.addArchive('U1', rows);
  const sys = ask(w, '火星探測任務進度');
  assert.ok(recallBlock(sys).includes('火星探測任務'));
  assert.ok(!w.cacheKeys().includes('mem:U1'));
  w.resetStats();
  ask(w, '火星探測任務進度');
  assert.ok(w.stats.reads >= 1, '沒有快取,每次都讀試算表');
});

test('整理成功後檢索語料快取失效:新事件馬上可被檢索', () => {
  const w = createWorld({ props: { HISTORY_MAX_TURNS: '3', FOLD_BATCH_TURNS: '2' } });
  w.setState('U1', { meta: { folds: 1 }, history: [] });
  w.addEvents('U1', [{ date: '2026-01-01', text: '舊事件無關' }]);
  ask(w, '暖機一下喔'); // 語料進快取
  for (let i = 1; i <= 3; i++) { w.geminiQueue.push(g.text('a' + i)); w.post(w.ev.text('U1', 'q' + i)); }
  w.geminiQueue.push(g.text('a4'), g.text(JSON.stringify({ events: [{ date: '2026-02-02', text: '學會了衝浪課程' }], facts: { user: ['x'], shared: [], followups: [] } })));
  w.post(w.ev.text('U1', 'q4'));
  const sys = ask(w, '想聊聊衝浪課程');
  assert.ok(recallBlock(sys).includes('2026-02-02 日誌:學會了衝浪課程'));
});

test('群組以群組自己的記憶運作', () => {
  const w = createWorld();
  w.addUser('C1', { kind: 'group' });
  w.setState('C1', { kind: 'group', facts: { 共同經歷: '- 群組一起去過墾丁' }, meta: { folds: 1 } });
  w.post(w.ev.groupText('C1', 'U5', '你好'));
  const sys = w.req.gemini()[0].body.systemInstruction.parts[0].text;
  assert.ok(sys.includes('群組一起去過墾丁'));
});
