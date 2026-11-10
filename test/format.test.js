'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g } = require('./world');

const plain = (w, s) => w.call('markdownToPlain', s);

// ---------- 次縫:Markdown 轉純文字(表格式) ----------
test('markdownToPlain:各種 Markdown 符號被轉成純文字', () => {
  const w = createWorld();
  const cases = [
    ['**粗體**', '粗體'],
    ['__粗體__', '粗體'],
    ['這是 *斜體* 與 **粗體** 與 ***粗斜***', '這是 斜體 與 粗體 與 粗斜'],
    ['**粗體中有 *斜體* 巢狀**', '粗體中有 斜體 巢狀'],
    ['中文*斜體*中文', '中文斜體中文'],
    ['~~刪除線~~', '刪除線'],
    ['# 標題\n## 次標題\n###### 第六層\n內文', '標題\n次標題\n第六層\n內文'],
    ['- a\n* b\n+ c', '・a\n・b\n・c'],
    ['- 上層\n  - 巢狀\n    * 更深', '・上層\n  ・巢狀\n    ・更深'],
    ['* **粗** 項目', '・粗 項目'],
    ['1. 第一\n2. 第二', '1. 第一\n2. 第二'],
    ['```js\nconst a = **1**;\n```', 'const a = **1**;'],
    ['```\n純圍欄\n```', '純圍欄'],
    ['用 `npm test` 執行', '用 npm test 執行'],
    ['[官網](https://example.com)', '官網(https://example.com)'],
    ['![圖](https://x.test/y.png)', '圖(https://x.test/y.png)'],
    ['[https://a.test](https://a.test)', 'https://a.test'],
    ['> 引用一\n> 引用二', '引用一\n引用二'],
    ['上\n\n---\n\n下', '上\n\n下'],
    ['| 名稱 | 價格 |\n|---|---|\n| 蘋果 | 10 |', '名稱 | 價格\n蘋果 | 10'],
    ['snake_case_word 與 2 * 3 * 4', 'snake_case_word 與 2 * 3 * 4'],
    ['第一段\n\n\n\n\n第二段', '第一段\n\n第二段'],
    ['  前後空白  \n', '前後空白'],
    ['', ''],
  ];
  for (const [input, expected] of cases) assert.strictEqual(plain(w, input), expected, JSON.stringify(input));
});

test('markdownToPlain:程式碼內的符號不被當成 Markdown 處理', () => {
  const w = createWorld();
  assert.strictEqual(plain(w, '`**不要動**` 與 **要動**'), '**不要動** 與 要動');
});

// ---------- 次縫:分段 ----------
const split = (w, text, max, limit) => w.call('splitText_', text, max || 5000, limit || 5);

test('splitText_:短文字不分段', () => {
  assert.deepStrictEqual(split(createWorld(), '你好'), { parts: ['你好'], truncated: false });
});

test('splitText_:優先在段落邊界切開', () => {
  const w = createWorld();
  const r = split(w, 'A'.repeat(3000) + '\n\n' + 'B'.repeat(3000));
  assert.deepStrictEqual(r.parts, ['A'.repeat(3000), 'B'.repeat(3000)]);
});

test('splitText_:段落邊界優先於較晚出現的單一換行', () => {
  const w = createWorld();
  const r = split(w, 'A'.repeat(3000) + '\n\n' + 'B'.repeat(1500) + '\n' + 'C'.repeat(3000));
  assert.strictEqual(r.parts[0], 'A'.repeat(3000));
  assert.strictEqual(r.parts[1], 'B'.repeat(1500) + '\n' + 'C'.repeat(3000));
});

test('splitText_:沒有段落時在換行,再其次在句尾切開', () => {
  const w = createWorld();
  const lines = ('第一行' + 'x'.repeat(2500) + '\n') + ('第二行' + 'y'.repeat(2500) + '\n') + 'z'.repeat(1000);
  const r1 = split(w, lines);
  assert.ok(r1.parts[0].endsWith('x'.repeat(2500)) && r1.parts.length === 2, r1.parts.map((p) => p.length).join(','));
  const sentences = '這是一句話。'.repeat(1000); // 6000 字、無換行
  const r2 = split(w, sentences);
  assert.strictEqual(r2.parts.length, 2);
  assert.ok(r2.parts[0].endsWith('。'));
  assert.strictEqual(r2.parts.join(''), sentences);
});

test('splitText_:完全沒有自然邊界的長字串在上限處硬切,內容不遺失', () => {
  const w = createWorld();
  const r = split(w, '字'.repeat(12000));
  assert.deepStrictEqual(r.parts.map((p) => p.length), [5000, 5000, 2000]);
  assert.strictEqual(r.truncated, false);
});

test('splitText_:12000 字被切成 3 則,每則不超過 5000 字,切在句尾', () => {
  const w = createWorld();
  const para = (i) => ('第' + i + '段內容很長很長。').repeat(40) + '\n\n';
  let text = '';
  for (let i = 0; text.length < 12000; i++) text += para(i);
  text = text.slice(0, 12000).replace(/[^。\n]+$/, '');
  const r = split(w, text);
  assert.strictEqual(r.parts.length, 3);
  assert.ok(r.parts.every((p) => p.length <= 5000));
  assert.ok(r.parts.slice(0, -1).every((p) => /[。]$/.test(p)));
  assert.strictEqual(r.parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('splitText_:超過上限則數時截斷並標示', () => {
  const w = createWorld();
  const r = split(w, '字'.repeat(30000), 5000, 5);
  assert.strictEqual(r.parts.length, 5);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.parts.at(-1).endsWith('…(內容過長)'));
  assert.ok(r.parts.every((p) => p.length <= 5000));
});

// ---------- 次縫:訊息組合 ----------
const IMG = { type: 'image', originalContentUrl: 'https://i.test/o.jpg', previewImageUrl: 'https://i.test/p.jpg' };

test('buildReplyMessages:文字在前、圖片在後', () => {
  const w = createWorld();
  const m = w.call('buildReplyMessages', '這是你要的圖', [IMG]);
  assert.deepStrictEqual(m.map((x) => x.type), ['text', 'image']);
  assert.strictEqual(m[0].text, '這是你要的圖');
});

test('buildReplyMessages:附圖時文字至多 4 則(一次 reply 最多 5 則),超過時截斷並標示', () => {
  const w = createWorld();
  const m = w.call('buildReplyMessages', '字'.repeat(30000), [IMG]);
  assert.strictEqual(m.length, 5);
  assert.deepStrictEqual(m.map((x) => x.type), ['text', 'text', 'text', 'text', 'image']);
  assert.ok(m[3].text.endsWith('…(內容過長)'));
});

test('buildReplyMessages:沒有圖時文字最多 5 則;空文字有保底', () => {
  const w = createWorld();
  assert.strictEqual(w.call('buildReplyMessages', '字'.repeat(30000), []).length, 5);
  const empty = w.call('buildReplyMessages', '', []);
  assert.strictEqual(empty.length, 1);
  assert.ok(empty[0].text.length > 0);
});

// ---------- 主縫:doPost ----------
test('Gemini 輸出的 Markdown 在送出的 reply 中已轉成純文字', () => {
  const w = createWorld();
  w.geminiQueue.push(g.text('# 今日重點\n\n- **台北**:晴\n- [氣象署](https://cwa.test)\n\n```\n28 度\n```'));
  w.post(w.ev.text('U1', '天氣'));
  assert.strictEqual(w.lastReplyText(), '今日重點\n\n・台北:晴\n・氣象署(https://cwa.test)\n\n28 度');
});

test('12000 字的輸出以一次 reply 送出 3 則文字,每則不超過 5000 字', () => {
  const w = createWorld();
  w.geminiQueue.push(g.text(('這是一句比較長的話,用來測試分段。').repeat(700).slice(0, 12000)));
  w.post(w.ev.text('U1', '長文'));
  assert.strictEqual(w.req.replies().length, 1);
  const msgs = w.req.replies()[0].body.messages;
  assert.strictEqual(msgs.length, 3);
  assert.ok(msgs.every((m) => m.type === 'text' && m.text.length <= 5000));
});

test('超長輸出被截斷在 5 則並標示「…(內容過長)」', () => {
  const w = createWorld();
  w.geminiQueue.push(g.text('字'.repeat(30000)));
  w.post(w.ev.text('U1', '超長'));
  const msgs = w.req.replies()[0].body.messages;
  assert.strictEqual(msgs.length, 5);
  assert.ok(msgs[4].text.endsWith('…(內容過長)'));
});

test('歷史保存的是使用者實際看到的純文字,下一輪不會把 Markdown 餵回模型', () => {
  const w = createWorld();
  w.geminiQueue.push(g.text('**重點**:晴'));
  w.post(w.ev.text('U1', 'a'));
  w.post(w.ev.text('U1', 'b'));
  assert.strictEqual(w.req.gemini()[1].body.contents[1].parts[0].text, '重點:晴');
});

test('system prompt 含「直接輸出純文字」的要求', () => {
  const w = createWorld();
  w.post(w.ev.text('U1', 'hi'));
  const sys = w.req.gemini()[0].body.systemInstruction.parts[0].text;
  assert.match(sys, /直接輸出純文字/);
  assert.match(sys, /Markdown/);
});
