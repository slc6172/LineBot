'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

test('白名單內的一對一聊天室:文字進、Gemini 回覆出、LINE reply 送出', () => {
  const w = createWorld();
  w.geminiQueue.push(g.text('你好,我是機器人'));
  w.post(w.ev.text('U1', '哈囉'));

  assert.deepStrictEqual(w.replyTexts(), ['你好,我是機器人']);
  const gem = w.req.gemini();
  assert.strictEqual(gem.length, 1);
  assert.strictEqual(gem[0].body.contents.at(-1).parts[0].text, '哈囉');
});

test('機器人記得最近的對話:第二則訊息送出的內容含第一回合', () => {
  const w = createWorld();
  w.geminiQueue.push(g.text('第一個回答'));
  w.post(w.ev.text('U1', '第一個問題'));
  w.post(w.ev.text('U1', '第二個問題'));

  const contents = w.req.gemini()[1].body.contents;
  assert.deepStrictEqual(contents.map((c) => [c.role, c.parts[0].text]), [
    ['user', '第一個問題'], ['model', '第一個回答'], ['user', '第二個問題'],
  ]);
});

test('system prompt 保留原有規則(繁體中文、不評論知識截止日期)與台北今天日期', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', 'hi'));
  const sys = w.req.gemini()[0].body.systemInstruction.parts[0].text;
  assert.match(sys, /使用繁體中文回答/);
  assert.match(sys, /知識截止日/);
  assert.match(sys, /2026年11月03日 \(星期二\)/);
});
