'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const MSG = {
  blocked: '這個問題被安全機制擋下了,換個問法再試試吧。',
  busy: '現在太多人在用,請稍後再試。',
  timeout: '處理逾時了,請稍後再試。',
  other: '抱歉,發生錯誤,請稍後再試。',
};

test('金鑰走 x-goog-api-key 標頭(前後空白與換行被去除),網址不含金鑰', () => {
  const w = createWorld({ props: { GEMINI_API_KEY: '  KEY-123\n', LINE_CHANNEL_ACCESS_TOKEN: ' LTOKEN \n' } });
  w.post(w.ev.text('U1', 'hi'));
  const req = w.req.gemini()[0];
  assert.strictEqual(req.headers['x-goog-api-key'], 'KEY-123');
  assert.ok(!req.url.includes('KEY-123') && !req.url.includes('key='));
  assert.strictEqual(w.req.replies()[0].headers.Authorization, 'Bearer LTOKEN');
});

test('429 → 在預算內重試一次,第二次成功則使用者只看到正常回覆', () => {
  const w = createWorld();
  w.geminiQueue.push(g.status(429), g.text('重試後成功'));
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.req.gemini().length, 2);
  assert.deepStrictEqual(w.replyTexts(), ['重試後成功']);
});

test('429 兩次都失敗 → 使用者看到「太忙」那句話', () => {
  const w = createWorld();
  w.geminiQueue.push(g.status(429), g.status(429));
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.req.gemini().length, 2);
  assert.deepStrictEqual(w.replyTexts(), [MSG.busy]);
});

test('5xx 與網路例外屬暫時性失敗:各重試一次', () => {
  let w = createWorld();
  w.geminiQueue.push(g.status(503), g.text('好了'));
  w.post(w.ev.text('U1', 'hi'));
  assert.deepStrictEqual(w.replyTexts(), ['好了']);
  w = createWorld();
  w.geminiQueue.push(g.throws(), g.text('好了'));
  w.post(w.ev.text('U1', 'hi'));
  assert.deepStrictEqual(w.replyTexts(), ['好了']);
});

test('400 不重試,使用者看到一般錯誤句', () => {
  const w = createWorld();
  w.geminiQueue.push(g.status(400));
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.req.gemini().length, 1);
  assert.deepStrictEqual(w.replyTexts(), [MSG.other]);
});

test('被安全機制擋下(promptFeedback / 完成原因為安全類 / 沒有候選)→「被擋下」那句話', () => {
  for (const item of [g.blockedPrompt(), g.blockedFinish(), { status: 200, body: { candidates: [] } }]) {
    const w = createWorld();
    w.geminiQueue.push(item);
    w.post(w.ev.text('U1', 'hi'));
    assert.deepStrictEqual(w.replyTexts(), [MSG.blocked]);
    assert.strictEqual(w.req.gemini().length, 1, '被擋下不重試');
  }
});

test('錯誤分類不受錯誤訊息語言影響:日文與英文訊息分類結果相同', () => {
  const run = (msg) => {
    const out = {};
    for (const [name, code] of [['429', 429], ['500', 500], ['400', 400]]) {
      const w = createWorld();
      w.geminiQueue.push(g.status(code, msg), g.status(code, msg));
      w.post(w.ev.text('U1', 'hi'));
      out[name] = w.lastReplyText();
    }
    return out;
  };
  const ja = run('リクエストが多すぎます');
  const en = run('Too many requests / quota exceeded / safety blocked / timeout');
  assert.deepStrictEqual(ja, en);
  assert.strictEqual(ja['429'], MSG.busy);
  assert.strictEqual(ja['400'], MSG.other);
});

test('完成原因為長度上限 → 照常使用已產生的文字並記一筆狀態日誌', () => {
  const w = createWorld();
  w.geminiQueue.push(g.maxTokens('講到一半'));
  w.post(w.ev.text('U1', 'hi'));
  assert.deepStrictEqual(w.replyTexts(), ['講到一半']);
  assert.ok(w.logs().some((l) => l.level === '狀態' && l.code === 'GEMINI_MAX_TOKENS'));
});

test('回應含思考簽章等額外欄位的 parts 也能取出文字', () => {
  const w = createWorld();
  w.geminiQueue.push({ status: 200, body: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '想想', thought: true }, { text: '答案', thoughtSignature: 'abc' }] } }] } });
  w.post(w.ev.text('U1', 'hi'));
  assert.deepStrictEqual(w.replyTexts(), ['答案']);
});

test('每次呼叫的 timeoutSeconds = min(單次上限, 剩餘預算 − 保留秒數)', () => {
  let w = createWorld();
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.req.gemini()[0].timeoutSeconds, 40); // min(40, 60-5)
  w = createWorld({ props: { TIME_BUDGET_S: '20', BUDGET_RESERVE_S: '5' } });
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.req.gemini()[0].timeoutSeconds, 15); // min(40, 20-5)
});

test('逾時且剩餘預算不足 → 不重試,使用者看到「逾時」那句話', () => {
  const w = createWorld({ props: { TIME_BUDGET_S: '20', BUDGET_RESERVE_S: '5' } });
  w.geminiQueue.push(g.delay(60000, g.text('太慢了')));
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.req.gemini().length, 1);
  assert.deepStrictEqual(w.replyTexts(), [MSG.timeout]);
});

test('第二次呼叫的 timeoutSeconds 會隨已用掉的預算縮小', () => {
  const w = createWorld({ props: { TIME_BUDGET_S: '60' } });
  w.geminiQueue.push(g.throws(20000), g.text('ok'));
  w.post(w.ev.text('U1', 'hi'));
  const [a, b] = w.req.gemini();
  assert.strictEqual(a.timeoutSeconds, 40);
  assert.ok(b.timeoutSeconds < a.timeoutSeconds, 'b=' + b.timeoutSeconds);
});

test('出錯時不把這回合寫進歷史', () => {
  const w = createWorld();
  w.geminiQueue.push(g.status(400));
  w.post(w.ev.text('U1', '失敗的問題'));
  w.post(w.ev.text('U1', '下一題'));
  const sent = w.req.gemini().at(-1).body.contents.map((c) => c.parts[0].text);
  assert.deepStrictEqual(sent, ['下一題']);
});

test('缺少 Gemini 金鑰:不呼叫 Gemini,回固定說明並記一筆狀態日誌', () => {
  const w = createWorld({ props: { GEMINI_API_KEY: '' } });
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.req.gemini().length, 0);
  assert.strictEqual(w.replyTexts().length, 1);
  assert.ok(w.logs().some((l) => l.code === 'KEY_MISSING' && l.detail.includes('GEMINI_API_KEY')));
});

test('金鑰不出現在任何請求網址、任何日誌列、任何回覆中', () => {
  const w = createWorld();
  const secrets = ['GEMINI-KEY-SECRET', 'LINE-TOKEN-SECRET', 'TINYFISH-KEY-SECRET', 'hook-key'];
  w.geminiQueue.push(g.status(429), g.status(429), g.status(500), g.throws(), g.blockedPrompt(), g.text('正常'));
  w.lineReplyHandler = (req) => (req.body.replyToken === 'rt-fail' ? { status: 400, body: { message: 'Invalid reply token' } } : { status: 200, body: {} });
  for (let i = 0; i < 4; i++) w.post(w.ev.text('U1', 'q' + i));
  w.post(w.ev.text('U1', 'x', { replyToken: 'rt-fail' }));
  w.post(w.ev.text('U9', '陌生人'));
  w.post(w.ev.text('U1', 'y'), { key: 'bad' });
  for (const r of w.requests) for (const s of secrets) assert.ok(!r.url.includes(s), 'URL 含金鑰');
  for (const l of w.logs()) for (const s of secrets) assert.ok(!JSON.stringify(l).includes(s), '日誌含金鑰');
  for (const t of w.replyTexts()) for (const s of secrets) assert.ok(!t.includes(s), '回覆含金鑰');
});

test('出錯的回合不進入寫入階段:沒有提交失敗的日誌', () => {
  const w = createWorld();
  w.geminiQueue.push(g.status(400));
  w.post(w.ev.text('U1', 'hi'));
  assert.ok(!w.logs().some((l) => l.code === 'COMMIT_FAILED'));
  assert.strictEqual(w.stateRow('U1'), null);
});
