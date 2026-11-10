'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const P = { HISTORY_MAX_TURNS: '3', FOLD_BATCH_TURNS: '2', GEMINI_MODEL_AUX: 'aux-model' };
const fold = (events, facts) => g.text(JSON.stringify({ events: events || [], facts: Object.assign({ user: [], shared: [], followups: [] }, facts || {}) }));
const isFold = (r) => r.body.generationConfig && r.body.generationConfig.responseMimeType === 'application/json';
const hist = (w) => w.stateOf('U1').history.map((h) => h.t);
const cols = (w, name, i) => w.rows(name).slice(1).map((r) => r[i]);

// 先聊 n 輪(各回 a1..an),不含整理
function chat(w, n, from) {
  for (let i = from || 1; i < (from || 1) + n; i++) { w.geminiQueue.push(g.text('a' + i)); w.post(w.ev.text('U1', 'q' + i)); }
}

test('原文沒超過 HISTORY_MAX_TURNS 輪時不整理', () => {
  const w = createWorld({ props: P });
  chat(w, 3);
  assert.strictEqual(w.req.gemini().length, 3);
  assert.deepStrictEqual(hist(w), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
});

test('超過 HISTORY_MAX_TURNS 輪 → reply 送出之後,用輔助模型、結構化輸出整理最舊 FOLD_BATCH_TURNS 輪', () => {
  const w = createWorld({ props: P });
  chat(w, 3);
  w.geminiQueue.push(g.text('a4'), fold([{ date: '2026-11-03', text: '聊了 q1 與 q2' }], { user: ['喜歡貓'] }));
  w.post(w.ev.text('U1', 'q4'));

  const gem = w.req.gemini();
  assert.strictEqual(gem.length, 5);
  const f = gem[4];
  assert.ok(isFold(f));
  assert.ok(f.url.includes('/models/aux-model:'));
  assert.strictEqual(f.body.tools, undefined);
  const schema = f.body.generationConfig.responseJsonSchema;
  assert.deepStrictEqual(schema.required.sort(), ['events', 'facts']);
  assert.deepStrictEqual(schema.properties.facts.required.sort(), ['followups', 'shared', 'user']);
  assert.ok(f.body.generationConfig.maxOutputTokens >= 2048, '整理的輸出不能被對話用的 token 上限截斷');

  // 順序:reply 先送出,整理的模型呼叫在其後
  const kinds = w.requests.map((r) => r.kind);
  const lastReply = kinds.lastIndexOf('line-reply');
  const foldIdx = w.requests.indexOf(f);
  assert.ok(lastReply < foldIdx, 'reply 要在整理之前送出');

  // 提示詞要求
  const sys = f.body.systemInstruction.parts[0].text;
  for (const phrase of ['刪除過時', '合併重複', '不要編造', '上限', '絕對日期', '下週', '最多 10 項', '80 字']) assert.ok(sys.includes(phrase), phrase);
  assert.ok(!sys.includes('角色自己'), '沒有「角色自己的事」區段');

  // 送去整理的內容:最舊 2 輪,每行帶訊息當天日期;不含較新的 2 輪
  const req = f.body.contents[0].parts[0].text;
  assert.ok(req.includes('【目前的長期記憶】(共 0 字,上限 2000 字)\n無'));
  for (const line of ['[2026-11-03] 使用者:q1', '[2026-11-03] 助理:a1', '[2026-11-03] 使用者:q2', '[2026-11-03] 助理:a2']) assert.ok(req.includes(line), line);
  for (const t of ['q3', 'a3', 'q4', 'a4']) assert.ok(!req.includes(t), t);
});

test('整理結果在同一個寫入階段完成:歸檔、事件、新版事實、State 進度一起寫入(一次取鎖、沒有 appendRow)', () => {
  const w = createWorld({ props: P });
  chat(w, 3);
  w.geminiQueue.push(g.text('a4'), fold([{ date: '2026-11-02', text: '聊了 q1 與 q2' }, { date: '2026-11-03', text: '另一件事' }], { user: ['喜歡貓', '住台北'], followups: ['下週三回診'] }));
  w.resetStats();
  w.post(w.ev.text('U1', 'q4'));
  assert.strictEqual(w.stats.lockAcquires, 1);
  assert.strictEqual(w.stats.appendRow, 0);

  assert.deepStrictEqual(hist(w), ['q3', 'a3', 'q4', 'a4'], '被整理的原文移出 State');
  assert.deepStrictEqual(cols(w, 'Archive', 0), ['U1', 'U1', 'U1', 'U1']);
  assert.deepStrictEqual(cols(w, 'Archive', 3), ['q1', 'a1', 'q2', 'a2']);
  assert.deepStrictEqual(cols(w, 'Archive', 2), ['u', 'm', 'u', 'm']);
  assert.deepStrictEqual(cols(w, 'Archive', 4), [0, 0, 0, 0]);
  assert.ok(cols(w, 'Archive', 1).every((t) => Number.isFinite(t) && t > 0));
  assert.deepStrictEqual(w.rows('Events').slice(1).map((r) => [r[0], r[1], r[4]]), [['U1', '2026-11-02', '聊了 q1 與 q2'], ['U1', '2026-11-03', '另一件事']]);
  const st = w.stateOf('U1');
  assert.deepStrictEqual(JSON.parse(st.facts), { 使用者: '- 喜歡貓\n- 住台北', 待跟進: '- 下週三回診' });
  assert.strictEqual(st.meta.folds, 1);
});

test('整理的日期不合法 → 改用該批次第一則訊息的日期;事件最多 10 筆、各截 80 字', () => {
  const w = createWorld({ props: P });
  chat(w, 3);
  const many = []; for (let i = 0; i < 14; i++) many.push({ date: i === 0 ? '下週三' : '2026-11-03', text: i === 0 ? '字'.repeat(200) : '事' + i });
  w.geminiQueue.push(g.text('a4'), fold(many, {}));
  w.post(w.ev.text('U1', 'q4'));
  const ev = w.rows('Events').slice(1);
  assert.strictEqual(ev.length, 10);
  assert.strictEqual(ev[0][1], '2026-11-03');
  assert.strictEqual(ev[0][4].length, 80);
});

test('整理回應不合法 → 狀態不動(只多了這回合)、有狀態日誌、不影響對話;下一次請求重試', () => {
  const bad = [g.text('not json'), g.text(JSON.stringify({ events: [] })), g.text(JSON.stringify({ events: [], facts: { user: 'x', shared: [], followups: [] } })), g.text('{"events":"x","facts":{}}')];
  for (const b of bad) {
    const w = createWorld({ props: P });
    chat(w, 3);
    w.geminiQueue.push(g.text('a4'), b);
    w.post(w.ev.text('U1', 'q4'));
    assert.deepStrictEqual(w.replyTexts().at(-1), 'a4');
    assert.deepStrictEqual(hist(w), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3', 'q4', 'a4']);
    assert.strictEqual(w.rows('Archive').length, 0);
    assert.strictEqual(w.rows('Events').length, 0);
    assert.ok(w.logs().some((l) => l.code === 'FOLD_INVALID' && l.level === '狀態'));
    // 下一次請求會重試,這次成功
    w.geminiQueue.push(g.text('a5'), fold([{ date: '2026-11-03', text: '事件' }], { user: ['新事實'] }));
    w.post(w.ev.text('U1', 'q5'));
    assert.strictEqual(w.rows('Archive').slice(1).length, 4);
    assert.deepStrictEqual(hist(w), ['q3', 'a3', 'q4', 'a4', 'q5', 'a5']);
  }
});

test('整理的模型呼叫失敗(400、429、例外)→ 不影響對話,狀態只多了這回合', () => {
  for (const failure of [[g.status(400)], [g.throws(), g.throws()]]) {
    const w = createWorld({ props: P });
    chat(w, 3);
    w.geminiQueue.push(g.text('a4'), ...failure);
    w.post(w.ev.text('U1', 'q4'));
    assert.deepStrictEqual(w.replyTexts().at(-1), 'a4');
    assert.deepStrictEqual(hist(w), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3', 'q4', 'a4']);
    assert.ok(w.logs().some((l) => l.code === 'FOLD_FAILED'));
  }
});

test('整理結果會讓所有既有事實消失 → 不採信(整份結果作廢,下次再試)', () => {
  const w = createWorld({ props: P });
  w.setState('U1', { facts: { 使用者: '- 喜歡貓' }, meta: { folds: 1 }, history: [{ r: 'u', t: 'q1', ts: w.now }, { r: 'm', t: 'a1', ts: w.now }, { r: 'u', t: 'q2', ts: w.now }, { r: 'm', t: 'a2', ts: w.now }, { r: 'u', t: 'q3', ts: w.now }, { r: 'm', t: 'a3', ts: w.now }] });
  w.geminiQueue.push(g.text('a4'), fold([{ date: '2026-11-03', text: '事件' }], {}));
  w.post(w.ev.text('U1', 'q4'));
  assert.deepStrictEqual(JSON.parse(w.stateOf('U1').facts), { 使用者: '- 喜歡貓' });
  assert.strictEqual(w.rows('Events').length, 0);
  assert.strictEqual(w.stateOf('U1').history.length, 8);
  assert.ok(w.logs().some((l) => l.code === 'FOLD_ERASE_REJECTED'));
});

test('新事實總長超過 LONG_TERM_MAX_CHARS → 保留舊事實,只記錄事件(進度照常前進)', () => {
  const w = createWorld({ props: Object.assign({ LONG_TERM_MAX_CHARS: '200' }, P) });
  w.setState('U1', { facts: { 使用者: '- 舊事實' }, meta: { folds: 1 }, history: [{ r: 'u', t: 'q1', ts: w.now }, { r: 'm', t: 'a1', ts: w.now }, { r: 'u', t: 'q2', ts: w.now }, { r: 'm', t: 'a2', ts: w.now }, { r: 'u', t: 'q3', ts: w.now }, { r: 'm', t: 'a3', ts: w.now }] });
  w.geminiQueue.push(g.text('a4'), fold([{ date: '2026-11-03', text: '事件照記' }], { user: ['字'.repeat(250)] }));
  w.post(w.ev.text('U1', 'q4'));
  assert.deepStrictEqual(JSON.parse(w.stateOf('U1').facts), { 使用者: '- 舊事實' });
  assert.deepStrictEqual(cols(w, 'Events', 4), ['事件照記']);
  assert.deepStrictEqual(hist(w), ['q3', 'a3', 'q4', 'a4']);
  assert.ok(w.logs().some((l) => l.code === 'FOLD_OVER_LIMIT'));
});

test('模型省略「更早的摘要」時保留舊的摘要', () => {
  const w = createWorld({ props: P });
  w.setState('U1', { facts: { 使用者: '- a', 更早的摘要: '很久以前的事' }, meta: { folds: 1 }, history: [{ r: 'u', t: 'q1', ts: w.now }, { r: 'm', t: 'a1', ts: w.now }, { r: 'u', t: 'q2', ts: w.now }, { r: 'm', t: 'a2', ts: w.now }, { r: 'u', t: 'q3', ts: w.now }, { r: 'm', t: 'a3', ts: w.now }] });
  w.geminiQueue.push(g.text('a4'), fold([], { user: ['b'] }));
  w.post(w.ev.text('U1', 'q4'));
  assert.deepStrictEqual(JSON.parse(w.stateOf('U1').facts), { 使用者: '- b', 更早的摘要: '很久以前的事' });
});

test('同一聊天室同時只允許一個整理(快取旗標,短時效);整理完旗標釋放', () => {
  const w = createWorld({ props: P });
  chat(w, 3);
  w.cachePut('fold:U1', '1', 120);
  w.geminiQueue.push(g.text('a4'));
  w.post(w.ev.text('U1', 'q4'));
  assert.ok(!w.req.gemini().some(isFold), '旗標存在時不整理');
  w.advance(121 * 1000); // 旗標過期
  w.geminiQueue.push(g.text('a5'), fold([{ date: '2026-11-03', text: '事件' }], { user: ['x'] }));
  w.post(w.ev.text('U1', 'q5'));
  assert.ok(w.req.gemini().some(isFold));
  assert.strictEqual(w.cacheGet('fold:U1'), null, '整理完旗標已釋放');
});

test('整理期間另一則訊息到達:兩邊都不遺失,只移出被整理的最舊幾輪', () => {
  const w = createWorld({ props: P });
  chat(w, 3);
  let fired = false;
  w.beforeGemini = (req) => {
    if (!isFold(req) || fired) return;
    fired = true;
    w.geminiQueue.unshift(g.text('aB')); // 巢狀的這則自己的回覆,不能搶走整理的回應
    w.post(w.ev.text('U1', 'qB'));
  };
  w.geminiQueue.push(g.text('a4'), fold([{ date: '2026-11-03', text: '事件' }], { user: ['x'] }));
  w.post(w.ev.text('U1', 'q4'));
  w.beforeGemini = null;
  assert.deepStrictEqual(hist(w), ['q3', 'a3', 'qB', 'aB', 'q4', 'a4']);
  assert.deepStrictEqual(cols(w, 'Archive', 3), ['q1', 'a1', 'q2', 'a2']);
});

test('整理期間該聊天室被 /忘記 → 整理結果作廢(不寫入任何事件或歸檔)', () => {
  const w = createWorld({ props: P });
  chat(w, 3);
  let fired = false;
  w.beforeGemini = (req) => {
    if (!isFold(req) || fired) return;
    fired = true;
    w.post(w.ev.text('U1', '/忘記'));
    w.post(w.ev.text('U1', '/忘記'));
  };
  w.geminiQueue.push(g.text('a4'), fold([{ date: '2026-11-03', text: '不該出現的事件' }], { user: ['不該出現'] }));
  w.post(w.ev.text('U1', 'q4'));
  w.beforeGemini = null;
  assert.strictEqual(w.rows('Events').slice(1).length, 0);
  assert.strictEqual(w.rows('Archive').slice(1).length, 0);
  assert.strictEqual(w.stateOf('U1').facts, '');
  assert.ok(w.logs().some((l) => l.code === 'FOLD_STALE'));
});

test('汙染回合的回覆以佔位文字取代(送去整理的、寫進歸檔的都不含網頁內容)', () => {
  const w = createWorld({ props: P });
  const t = w.now;
  w.setState('U1', { history: [
    { r: 'u', t: '查天氣', ts: t }, { r: 'm', t: '網頁說今天 30 度-WEBSECRET', ts: t, p: 1, q: ['台北天氣'] },
    { r: 'u', t: '再查一個', ts: t }, { r: 'm', t: '另一個網頁內容-WEBSECRET2', ts: t, p: 1 },
    { r: 'u', t: 'q3', ts: t }, { r: 'm', t: 'a3', ts: t },
  ] });
  w.geminiQueue.push(g.text('a4'), fold([{ date: '2026-11-03', text: '查過天氣' }], {}));
  w.post(w.ev.text('U1', 'q4'));
  const req = w.req.gemini().find(isFold).body.contents[0].parts[0].text;
  assert.ok(req.includes('助理:(那天查過:台北天氣;網頁內容未納入)'));
  assert.ok(req.includes('助理:(那天用到網頁內容;網頁內容未納入)'));
  assert.ok(!req.includes('WEBSECRET'));
  const arch = w.rows('Archive').slice(1);
  assert.ok(!JSON.stringify(arch).includes('WEBSECRET'));
  assert.deepStrictEqual(arch.map((r) => r[4]), [0, 1, 0, 1]);
  assert.strictEqual(arch[1][3], '(那天查過:台北天氣;網頁內容未納入)');
});

test('剩餘預算不足(低於 MIN_TURN_S)時略過整理,下一次再試', () => {
  const w = createWorld({ props: Object.assign({ TIME_BUDGET_S: '30', MIN_TURN_S: '12' }, P) });
  chat(w, 3);
  w.geminiQueue.push(g.delay(20000, g.text('a4')));
  w.post(w.ev.text('U1', 'q4'));
  assert.ok(!w.req.gemini().some(isFold));
  assert.strictEqual(w.stateOf('U1').history.length, 8);
});

test('FOLD_BATCH_TURNS 大於可整理的輪數時,至少留下 1 輪原文', () => {
  const w = createWorld({ props: { HISTORY_MAX_TURNS: '3', FOLD_BATCH_TURNS: '10', GEMINI_MODEL_AUX: 'aux-model' } });
  chat(w, 3);
  w.geminiQueue.push(g.text('a4'), fold([{ date: '2026-11-03', text: '事件' }], { user: ['x'] }));
  w.post(w.ev.text('U1', 'q4'));
  assert.deepStrictEqual(hist(w), ['q4', 'a4']);
  assert.deepStrictEqual(cols(w, 'Archive', 3), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
});

test('MEMORY_ENABLED=false:不整理,歷史只保留最近 HISTORY_MAX_TURNS 輪(丟掉最舊的)', () => {
  const w = createWorld({ props: Object.assign({ MEMORY_ENABLED: 'false' }, P) });
  chat(w, 5);
  assert.ok(!w.req.gemini().some(isFold));
  assert.deepStrictEqual(hist(w), ['q3', 'a3', 'q4', 'a4', 'q5', 'a5']);
});

test('整理一直失敗時,State 的歷史有安全上限(HISTORY_MAX_TURNS 的 3 倍),不會無限成長', () => {
  const w = createWorld({ props: { HISTORY_MAX_TURNS: '2', FOLD_BATCH_TURNS: '1' } });
  w.geminiFallback = (req) => (isFold(req) ? g.text('not json') : g.text('ok'));
  for (let i = 1; i <= 12; i++) w.post(w.ev.text('U1', 'q' + i));
  const h = hist(w);
  assert.strictEqual(h.length, 12); // 6 輪 = 2 × 3
  assert.strictEqual(h[0], 'q7');
  assert.ok(w.logs().some((l) => l.code === 'HISTORY_CAP_DROP'));
});

test('送給模型的原文窗口只有最近 HISTORY_MAX_TURNS 輪(State 裡更舊、尚未整理的不送)', () => {
  const w = createWorld({ props: P });
  chat(w, 5); // 整理都失敗(預設 OK 不是 JSON),State 累積了 5 輪
  w.post(w.ev.text('U1', 'q6'));
  const last = w.req.gemini().filter((r) => !isFold(r)).at(-1);
  assert.deepStrictEqual(last.body.contents.map((c) => c.parts[0].text), ['q3', 'a3', 'q4', 'a4', 'q5', 'a5', 'q6']);
});

test('群組同樣會整理(以群組為單位)', () => {
  const w = createWorld({ props: P });
  w.addUser('C1', { kind: 'group' });
  for (let i = 1; i <= 3; i++) { w.geminiQueue.push(g.text('a' + i)); w.post(w.ev.groupText('C1', 'U5', 'q' + i)); }
  w.geminiQueue.push(g.text('a4'), fold([{ date: '2026-11-03', text: '群組事件' }], { shared: ['一起聚餐'] }));
  w.post(w.ev.groupText('C1', 'U5', 'q4'));
  assert.deepStrictEqual(cols(w, 'Events', 0), ['C1']);
  assert.deepStrictEqual(JSON.parse(w.stateOf('C1').facts), { 共同經歷: '- 一起聚餐' });
});
