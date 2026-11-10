'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, g, cf } = require('./world');

const HOUR = 3600 * 1000;
const IMG_PROPS = { IMAGE_ENABLED: 'true', CF_API_TOKEN: 'CF-TOKEN-SECRET', CF_ACCOUNT_ID: 'acc1234567890abcdef1234567890ab', IMAGE_COOLDOWN_S: '0', IMAGE_DRIVE_FOLDER_ID: 'FOLDER_IMG_0123456789' };
const FOLDER = 'FOLDER_IMG_0123456789';
const world = (extra) => createWorld({ props: Object.assign({}, IMG_PROPS, extra || {}) });
const draw = (prompt, id) => g.call('generate_image', { prompt: prompt === undefined ? 'a red apple on a white table' : prompt }, id || 'img1');
const sysOf = (req) => req.body.systemInstruction.parts[0].text;
const toolNames = (req) => (req.body.tools ? req.body.tools[0].functionDeclarations.map((d) => d.name) : []);
const responsesOf = (req) => req.body.contents.at(-1).parts.filter((p) => p.functionResponse).map((p) => p.functionResponse);
const resultText = (req, i) => { const r = responsesOf(req)[i || 0].response; return r.result !== undefined ? r.result : r.error; };
const sysRow = (w) => w.stateOf('_system');
const imgMeta = (w) => (sysRow(w) ? sysRow(w).meta.image : undefined);
const lastReplyMsgs = (w) => w.req.replies().at(-1).body.messages;
const bigJpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(n, 7)]);
// 用一次生圖(冷卻設 0)並回傳這次請求
function drawOnce(w, who) { w.geminiQueue.push(draw(), g.text('畫好了')); w.post(w.ev.text(who || 'U1', '畫一張蘋果')); }

// ---------- 次縫 ----------
test('imageKind_:以檔頭判斷格式(位元組可為 GAS 的有號數);只有 JPEG 與 PNG 能用', () => {
  const w = createWorld();
  const table = [
    [[0xff, 0xd8, 0xff, 0xe0], 'jpg'], [[-1, -40, -1, -32], 'jpg'], [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png'], [[-119, 80, 78, 71, 13, 10, 26, 10], 'png'],
    [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], null], [[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], null], [[1, 2, 3], null], [[], null], [[0xff, 0xd8], null], [[0xff, 0xd8, 0x00, 0x00], null], [[0xff, 0x00, 0xff], null],
  ];
  for (const [bytes, kind] of table) assert.strictEqual(w.call('imageKind_', bytes), kind, JSON.stringify(bytes));
});

test('driveImageUrls_:主格式 lh3,超過 1MB 的預覽改用備援格式 thumbnail;絕不使用 uc?export=view', () => {
  const w = createWorld();
  const small = w.call('driveImageUrls_', 'abc_123-XYZ', 66000);
  assert.deepStrictEqual(small, { original: 'https://lh3.googleusercontent.com/d/abc_123-XYZ', preview: 'https://lh3.googleusercontent.com/d/abc_123-XYZ' });
  const big = w.call('driveImageUrls_', 'abc_123-XYZ', 1000001);
  assert.strictEqual(big.original, 'https://lh3.googleusercontent.com/d/abc_123-XYZ');
  assert.strictEqual(big.preview, 'https://drive.google.com/thumbnail?id=abc_123-XYZ&sz=w1000');
  assert.strictEqual(w.call('driveImageUrls_', 'x', 1000000).preview.includes('lh3'), true, '剛好 1MB 仍用主格式');
  assert.ok(!JSON.stringify([small, big]).includes('export=view'));
  assert.strictEqual(w.call('imageUrl_', 'ID1', 'backup'), 'https://drive.google.com/thumbnail?id=ID1&sz=w1000');
  assert.strictEqual(w.call('imageUrl_', 'ID1', 'main'), 'https://lh3.googleusercontent.com/d/ID1');
});

// ---------- 基本流程 ----------
test('使用者要求畫圖 → generate_image → Cloudflare 請求(提示詞、寬、高、Bearer)→ 存 Drive 並設為連結可檢視 → 單一 reply 含文字與圖片(主格式網址)', () => {
  const w = world();
  w.geminiQueue.push(draw('a red apple on a white table'), g.text('蘋果畫好囉'));
  w.post(w.ev.text('U1', '畫一張蘋果'));

  const cfReq = w.req.cf();
  assert.strictEqual(cfReq.length, 1);
  assert.strictEqual(cfReq[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc1234567890abcdef1234567890ab/ai/run/@cf/black-forest-labs/flux-2-klein-9b');
  assert.strictEqual(cfReq[0].method, 'post');
  assert.strictEqual(cfReq[0].headers.Authorization, 'Bearer CF-TOKEN-SECRET');
  assert.deepStrictEqual(cfReq[0].body, { prompt: 'a red apple on a white table', width: '576', height: '1024' });

  const files = Object.values(w.drive.files);
  assert.strictEqual(files.length, 1);
  assert.deepStrictEqual(files[0].sharing, ['ANYONE_WITH_LINK', 'VIEW']);
  assert.strictEqual(files[0].mime, 'image/jpeg');
  assert.strictEqual(files[0].name, 'img-' + w.now + '.jpg', '檔名只有時間戳');

  assert.strictEqual(w.req.replies().length, 1, '單一 reply');
  const msgs = lastReplyMsgs(w);
  assert.deepStrictEqual(msgs.map((m) => m.type), ['text', 'image']);
  assert.strictEqual(msgs[0].text, '蘋果畫好囉');
  const url = 'https://lh3.googleusercontent.com/d/' + files[0].id;
  assert.deepStrictEqual([msgs[1].originalContentUrl, msgs[1].previewImageUrl], [url, url]);

  const toModel = resultText(w.req.gemini()[1]);
  assert.ok(!toModel.includes('http') && !toModel.includes(files[0].id), '給模型的結果不含網址');
});

test('使用 CF_IMAGE_MODEL、IMAGE_WIDTH、IMAGE_HEIGHT 設定', () => {
  const w = world({ CF_IMAGE_MODEL: 'flux-1-schnell', IMAGE_WIDTH: '512', IMAGE_HEIGHT: '768' });
  drawOnce(w);
  const r = w.req.cf()[0];
  assert.ok(r.url.endsWith('/ai/run/@cf/black-forest-labs/flux-1-schnell'));
  assert.deepStrictEqual([r.body.width, r.body.height], ['512', '768']);
});

test('成功條件:HTTP 正常且 success 為 true 且有圖;PNG 也可;GIF/WEBP/亂碼視為失敗(不存 Drive、不計數)', () => {
  let w = world();
  w.cfImageBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('PNGBODY')]);
  drawOnce(w);
  assert.match(Object.values(w.drive.files)[0].name, /\.png$/);
  assert.strictEqual(Object.values(w.drive.files)[0].mime, 'image/png');

  const failures = [
    cf.ok(Buffer.from('GIF89a-not-supported')), cf.ok(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.from('x')])),
    { status: 200, body: { success: false, errors: [{ code: 1000 }] } }, { status: 200, body: { success: true, result: {} } },
    { status: 500, body: 'oops' }, { throws: true },
  ];
  for (const f of failures) {
    w = world();
    w.cfHandler = () => f;
    drawOnce(w);
    assert.strictEqual(Object.keys(w.drive.files).length, 0);
    assert.ok(lastReplyMsgs(w).every((m) => m.type === 'text'));
    assert.strictEqual(imgMeta(w), undefined, '失敗不計數');
  }
});

test('圖片超過 1MB:預覽圖改用備援格式', () => {
  const w = world();
  w.cfImageBytes = bigJpeg(1000001);
  drawOnce(w);
  const m = lastReplyMsgs(w)[1];
  const id = Object.keys(w.drive.files)[0];
  assert.strictEqual(m.originalContentUrl, 'https://lh3.googleusercontent.com/d/' + id);
  assert.strictEqual(m.previewImageUrl, 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000');
});

test('附圖時文字至多 4 則(一次 reply 最多 5 則)', () => {
  const w = world();
  w.geminiQueue.push(draw(), g.text('字'.repeat(30000)));
  w.post(w.ev.text('U1', '畫一張'));
  const msgs = lastReplyMsgs(w);
  assert.deepStrictEqual(msgs.map((m) => m.type), ['text', 'text', 'text', 'text', 'image']);
});

test('每回合至多一張:同一輪兩個呼叫或之後的輪次再呼叫,都只有一次 Cloudflare 請求', () => {
  let w = world();
  w.geminiQueue.push(g.calls([{ name: 'generate_image', args: { prompt: 'first picture' }, id: 'a' }, { name: 'generate_image', args: { prompt: 'second picture' }, id: 'b' }]), g.text('好了'));
  w.post(w.ev.text('U1', '畫兩張'));
  assert.strictEqual(w.req.cf().length, 1);
  assert.ok(responsesOf(w.req.gemini()[1])[1].response.error);
  assert.strictEqual(lastReplyMsgs(w).filter((m) => m.type === 'image').length, 1);

  w = world();
  w.geminiQueue.push(draw('first picture', 'a'), draw('second picture', 'b'), g.text('好了'));
  w.post(w.ev.text('U1', '畫兩張'));
  assert.strictEqual(w.req.cf().length, 1);
});

test('提示詞不合法(缺少、非字串、空白、超過 2000 字)→ 工具錯誤,沒有 Cloudflare 請求', () => {
  for (const args of [{}, { prompt: 5 }, { prompt: '   ' }, { prompt: 'x'.repeat(2001) }]) {
    const w = world();
    w.geminiQueue.push(g.call('generate_image', args, 'a'), g.text('ok'));
    w.post(w.ev.text('U1', '畫'));
    assert.strictEqual(w.req.cf().length, 0, JSON.stringify(args).slice(0, 40));
    assert.ok(responsesOf(w.req.gemini()[1])[0].response.error);
  }
});

test('隱私:檔名只含時間戳;日誌與回覆不含提示詞;金鑰不出現在日誌與網址', () => {
  const w = world();
  w.cfHandler = () => cf.err(7000, 400);
  w.geminiQueue.push(draw('SECRET-PROMPT-WORDS unicorn'), g.text('失敗了'));
  w.post(w.ev.text('U1', '畫'));
  w.cfHandler = null;
  w.geminiQueue.push(draw('SECRET-PROMPT-WORDS dragon'), g.text('成功'));
  w.post(w.ev.text('U1', '再畫'));
  for (const f of Object.values(w.drive.files)) assert.ok(!f.name.includes('SECRET'));
  assert.ok(!JSON.stringify(w.rows('Logs')).includes('SECRET-PROMPT-WORDS'));
  assert.ok(!JSON.stringify(w.rows('Logs')).includes('CF-TOKEN-SECRET'));
  for (const r of w.requests) assert.ok(!r.url.includes('CF-TOKEN-SECRET'));
  for (const t of w.replyTexts()) assert.ok(!t.includes('CF-TOKEN-SECRET'));
});

// ---------- 可用性:宣告與否 ----------
test('可用時才宣告 generate_image(並說明用法);沒開、缺金鑰時既不宣告也不提', () => {
  let w = world();
  w.post(w.ev.text('U1', 'hi'));
  const r = w.req.gemini()[0];
  assert.ok(toolNames(r).includes('generate_image'));
  assert.match(sysOf(r), /generate_image/);

  for (const props of [{ IMAGE_ENABLED: 'false' }, { CF_API_TOKEN: '' }, { CF_ACCOUNT_ID: '' }]) {
    w = world(props);
    w.post(w.ev.text('U1', 'hi'));
    const q = w.req.gemini()[0];
    assert.ok(!toolNames(q).includes('generate_image'), JSON.stringify(props));
    assert.ok(!/generate_image|生圖/.test(sysOf(q)), JSON.stringify(props));
  }
});

test('生圖不依賴搜尋:沒有 TINYFISH_API_KEY 也能生圖,且只宣告 generate_image', () => {
  const w = world({ TINYFISH_API_KEY: '' });
  w.geminiQueue.push(draw(), g.text('畫好了'));
  w.post(w.ev.text('U1', '畫一張'));
  assert.deepStrictEqual(toolNames(w.req.gemini()[0]), ['generate_image']);
  assert.strictEqual(w.req.cf().length, 1);
});

test('MAX_TOOL_TURNS=0 時不宣告任何工具(含生圖)', () => {
  const w = world({ MAX_TOOL_TURNS: '0' });
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.req.gemini()[0].body.tools, undefined);
});

// ---------- 額度 ----------
test('每日第 7 張 → 被拒絕並告知明天再試,沒有 Cloudflare 請求;跨過 UTC 午夜後額度重置', () => {
  const w = world();
  for (let i = 0; i < 6; i++) drawOnce(w);
  assert.strictEqual(w.req.cf().length, 6);
  assert.deepStrictEqual(imgMeta(w).n, 6);
  assert.strictEqual(imgMeta(w).day, '2026-11-03');

  // 第 7 張:額度用完 → 不再宣告,提示詞要求婉拒
  w.post(w.ev.text('U1', '再畫一張'));
  const seven = w.req.gemini().at(-1);
  assert.ok(!toolNames(seven).includes('generate_image'));
  assert.match(sysOf(seven), /生圖額度已用完.*明天再試/);
  // 模型硬要呼叫:被拒絕
  w.geminiQueue.push(draw(), g.text('抱歉'));
  w.post(w.ev.text('U1', '畫第七張'));
  assert.strictEqual(w.req.cf().length, 6);
  const refused = w.req.gemini().at(-1);
  assert.match(resultText(refused), /明天再試/);
  assert.match(w.lastReplyText(), /今天的生圖額度用完了,請明天再試/);

  // 跨過 UTC 午夜(台灣早上 8 點)後重置
  w.now = Date.UTC(2026, 10, 4, 0, 0, 1);
  drawOnce(w);
  assert.strictEqual(w.req.cf().length, 7);
  assert.deepStrictEqual([imgMeta(w).day, imgMeta(w).n], ['2026-11-04', 1]);
});

test('IMAGE_MAX_PER_DAY 可調整;失敗不計數(成功存圖後才計數)', () => {
  const w = world({ IMAGE_MAX_PER_DAY: '1' });
  w.cfHandler = () => cf.err(7000, 400);
  drawOnce(w);
  assert.strictEqual(imgMeta(w), undefined);
  w.cfHandler = null;
  drawOnce(w);
  assert.strictEqual(imgMeta(w).n, 1);
  w.post(w.ev.text('U1', '再畫'));
  assert.ok(!toolNames(w.req.gemini().at(-1)).includes('generate_image'));
});

test('額度以全域計算:不同使用者共用同一個每日額度', () => {
  const w = world({ IMAGE_MAX_PER_DAY: '2' });
  w.addUser('U2');
  drawOnce(w, 'U1');
  drawOnce(w, 'U2');
  w.post(w.ev.text('U1', '再畫'));
  assert.ok(!toolNames(w.req.gemini().at(-1)).includes('generate_image'));
  assert.strictEqual(imgMeta(w).n, 2);
});

test('計數與時間在同一個寫入階段更新(鎖內、沒有 appendRow)', () => {
  const w = world();
  w.post(w.ev.text('U1', '暖機'));
  w.resetStats();
  drawOnce(w);
  assert.strictEqual(w.stats.lockAcquires, 1);
  assert.strictEqual(w.stats.appendRow, 0);
  assert.ok(imgMeta(w).lastAt > 0);
});

// ---------- 冷卻 ----------
test('冷卻內再要求 → 告知稍後再試,沒有 Cloudflare 請求;冷卻過後可再畫', () => {
  const w = world({ IMAGE_COOLDOWN_S: '30' });
  drawOnce(w);
  w.advance(10 * 1000);
  w.post(w.ev.text('U1', '再畫'));
  const mid = w.req.gemini().at(-1);
  assert.ok(!toolNames(mid).includes('generate_image'));
  assert.match(sysOf(mid), /冷卻中/);
  w.geminiQueue.push(draw(), g.text('抱歉'));
  w.post(w.ev.text('U1', '硬要畫'));
  assert.strictEqual(w.req.cf().length, 1);
  assert.match(w.lastReplyText(), /稍後再試/);
  w.advance(31 * 1000);
  drawOnce(w);
  assert.strictEqual(w.req.cf().length, 2);
});

// ---------- 預算 ----------
test('剩餘預算低於 IMAGE_MIN_BUDGET_S → 不開始生圖並告知', () => {
  const w = world({ TIME_BUDGET_S: '30', IMAGE_MIN_BUDGET_S: '20' });
  w.geminiQueue.push(g.delay(15000, draw()), g.text('抱歉'));
  w.post(w.ev.text('U1', '畫一張'));
  assert.strictEqual(w.req.cf().length, 0);
  assert.match(w.lastReplyText(), /時間不夠/);
  assert.strictEqual(imgMeta(w), undefined);
});

test('Cloudflare 呼叫的 timeoutSeconds 不超過剩餘預算', () => {
  const w = world({ TIME_BUDGET_S: '60', BUDGET_RESERVE_S: '5' });
  w.geminiQueue.push(g.delay(10000, draw()), g.text('ok'));
  w.post(w.ev.text('U1', '畫一張'));
  const t = w.req.cf()[0].timeoutSeconds;
  assert.ok(t >= 1 && t <= 40 && t <= 60 - 10 - 5, 'timeout=' + t);
});

// ---------- Cloudflare 錯誤碼 ----------
test('3036(當日免費額度用盡)→ 記錄額度用盡至下個 00:00 UTC、當日停用、告知明天再試', () => {
  const w = world();
  w.cfHandler = () => cf.err(3036, 429);
  drawOnce(w);
  assert.strictEqual(imgMeta(w).blockedUntil, Date.UTC(2026, 10, 4, 0, 0, 0));
  assert.ok(w.logs().some((l) => l.code === 'IMAGE_QUOTA_EXHAUSTED' && l.level === '狀態'));
  assert.match(w.lastReplyText(), /明天再試/);
  w.cfHandler = null;
  w.post(w.ev.text('U1', '再畫'));
  assert.ok(!toolNames(w.req.gemini().at(-1)).includes('generate_image'));
  w.now = Date.UTC(2026, 10, 4, 0, 0, 5);
  w.post(w.ev.text('U1', '現在呢'));
  assert.ok(toolNames(w.req.gemini().at(-1)).includes('generate_image'));
});

test('5035 / 5007 / 5004(設定錯誤)→ 暫停生圖 6 小時、有錯誤日誌、函式不再被宣告;6 小時後恢復', () => {
  for (const code of [5035, 5007, 5004]) {
    const w = world();
    w.cfHandler = () => cf.err(code, 400);
    drawOnce(w);
    const log = w.logs().find((l) => l.code === 'IMAGE_PAUSED');
    assert.ok(log && log.level === '錯誤' && log.detail.includes(String(code)));
    w.cfHandler = null;
    w.advance(3 * HOUR);
    w.post(w.ev.text('U1', '再畫'));
    const mid = w.req.gemini().at(-1);
    assert.ok(!toolNames(mid).includes('generate_image'));
    assert.match(sysOf(mid), /今天不方便生圖/);
    w.geminiQueue.push(draw(), g.text('抱歉'));
    w.post(w.ev.text('U1', '硬要畫'));
    assert.strictEqual(w.req.cf().length, 1, '暫停期間不送請求');
    w.advance(3 * HOUR + 2000);
    w.post(w.ev.text('U1', '現在呢'));
    assert.ok(toolNames(w.req.gemini().at(-1)).includes('generate_image'), '6 小時後恢復');
  }
});

test('3040 / 3007(暫時沒容量)且預算足夠 → 重試一次;兩次都失敗 → 告知稍後再試', () => {
  for (const code of [3040, 3007]) {
    let w = world();
    let n = 0;
    w.cfHandler = () => (++n === 1 ? cf.err(code, 503) : cf.ok(w.cfImageBytes));
    drawOnce(w);
    assert.strictEqual(w.req.cf().length, 2);
    assert.strictEqual(lastReplyMsgs(w).filter((m) => m.type === 'image').length, 1);
    assert.strictEqual(imgMeta(w).n, 1);

    w = world();
    w.cfHandler = () => cf.err(code, 503);
    drawOnce(w);
    assert.strictEqual(w.req.cf().length, 2);
    assert.match(w.lastReplyText(), /稍後再試/);
    assert.strictEqual(imgMeta(w), undefined);
  }
});

test('3040 且預算不足 → 不重試,告知稍後再試', () => {
  const w = world({ TIME_BUDGET_S: '40', IMAGE_MIN_BUDGET_S: '20' });
  w.cfHandler = () => g.delay(25000, cf.err(3040, 503)); // 第一次花 25 秒 → 剩 15 秒,低於 20 秒
  drawOnce(w);
  assert.strictEqual(w.req.cf().length, 1);
  assert.match(w.lastReplyText(), /稍後再試/);
});

test('3006(輸入過大)→ 告知提示詞太長;其他錯誤 → 回報 HTTP 狀態與 Cloudflare 錯誤代碼(不含 token)', () => {
  let w = world();
  w.cfHandler = () => cf.err(3006, 400);
  drawOnce(w);
  assert.match(w.lastReplyText(), /提示詞太長/);

  w = world();
  w.cfHandler = () => cf.err(7000, 400);
  drawOnce(w);
  assert.match(w.lastReplyText(), /HTTP 400/);
  assert.match(w.lastReplyText(), /7000/);
  assert.ok(!w.lastReplyText().includes('CF-TOKEN-SECRET'));
  assert.ok(w.logs().some((l) => l.code === 'IMAGE_FAILED' && l.level === '錯誤' && l.detail.includes('7000')));
});

test('錯誤分類只看狀態碼與錯誤代碼,不受錯誤訊息語言影響', () => {
  for (const msg of ['リクエストが多すぎます', 'quota exceeded', '額度用盡']) {
    const w = world();
    w.cfHandler = () => ({ status: 429, body: { success: false, errors: [{ code: 3036, message: msg }] } });
    drawOnce(w);
    assert.strictEqual(imgMeta(w).blockedUntil, Date.UTC(2026, 10, 4));
  }
});

test('網路例外或逾時 → 告知逾時,不計數', () => {
  const w = world();
  w.cfHandler = () => ({ throws: true });
  drawOnce(w);
  assert.match(w.lastReplyText(), /逾時/);
  assert.strictEqual(imgMeta(w), undefined);
});

// ---------- Drive ----------
test('Drive 設定分享失敗(例如被網域管理員限制)→ 圖片不送出、檔案丟垃圾桶、有錯誤日誌、不計數', () => {
  const w = world();
  w.drive.failSharing = true;
  drawOnce(w);
  assert.ok(Object.values(w.drive.files).every((f) => f.trashed));
  assert.ok(lastReplyMsgs(w).every((m) => m.type === 'text'));
  assert.match(w.lastReplyText(), /無法儲存/);
  assert.ok(w.logs().some((l) => l.code === 'IMAGE_DRIVE_FAILED' && l.level === '錯誤'));
  assert.strictEqual(imgMeta(w), undefined);
});

test('Drive 建立檔案失敗 → 同樣告知,不計數', () => {
  const w = world();
  w.drive.failCreate = true;
  drawOnce(w);
  assert.match(w.lastReplyText(), /無法儲存/);
  assert.strictEqual(imgMeta(w), undefined);
});

// ---------- 圖片專用資料夾 ----------
test('圖片建立在指定資料夾內,不碰 Drive 根目錄', () => {
  const w = world();
  drawOnce(w);
  const files = Object.values(w.drive.files);
  assert.strictEqual(files.length, 1);
  assert.deepStrictEqual(files[0].parents, [FOLDER]);
  assert.strictEqual(w.drive.rootCreates, 0);
});

test('未設定 IMAGE_DRIVE_FOLDER_ID → 生圖視為未啟用:不宣告工具、不呼叫 Cloudflare、不建檔,並記 KEY_MISSING', () => {
  const w = world({ IMAGE_DRIVE_FOLDER_ID: '' });
  w.geminiQueue.push(g.text('我現在不能畫圖'));
  w.post(w.ev.text('U1', '畫一張蘋果'));
  assert.ok(!toolNames(w.req.gemini()[0]).includes('generate_image'));
  assert.strictEqual(w.req.cf().length, 0);
  assert.strictEqual(Object.keys(w.drive.files).length, 0);
  assert.strictEqual(w.drive.rootCreates, 0);
  assert.ok(w.logs().some((l) => l.code === 'KEY_MISSING' && l.detail === 'IMAGE_DRIVE_FOLDER_ID'));
});

test('資料夾 ID 格式不合(例如貼成整段網址)→ CONFIG_RANGE,同樣視為未啟用', () => {
  const w = world({ IMAGE_DRIVE_FOLDER_ID: 'https://drive.google.com/drive/folders/' + FOLDER });
  w.geminiQueue.push(g.text('好'));
  w.post(w.ev.text('U1', '畫一張蘋果'));
  assert.ok(w.logs().some((l) => l.code === 'CONFIG_RANGE' && l.detail === 'IMAGE_DRIVE_FOLDER_ID'));
  assert.ok(!toolNames(w.req.gemini()[0]).includes('generate_image'));
  assert.strictEqual(w.req.cf().length, 0);
});

test('資料夾不存在或無權限 → 不回退根目錄、不建檔、告知無法儲存、不計數', () => {
  const w = world({ IMAGE_DRIVE_FOLDER_ID: 'WRONG_FOLDER_0123456789' });
  drawOnce(w);
  assert.strictEqual(Object.keys(w.drive.files).length, 0);
  assert.strictEqual(w.drive.rootCreates, 0);
  assert.match(w.lastReplyText(), /無法儲存/);
  assert.ok(w.logs().some((l) => l.code === 'IMAGE_DRIVE_FAILED'));
  assert.strictEqual(imgMeta(w), undefined);
});

test('保留期清理只處理指定資料夾內的檔案:根目錄或其他資料夾的舊檔一律跳過(不丟垃圾桶、Images 列維持未處理)', () => {
  const w = world();
  const DAY = 24 * HOUR;
  w.setRows('Images', [['file_id', 'created_at', 'trashed'],
    ['legacyRoot', w.now - 40 * DAY, 0], ['otherFolder', w.now - 40 * DAY - 1, 0], ['inFolder', w.now - 40 * DAY - 2, 0]]);
  w.drive.files.legacyRoot = { id: 'legacyRoot', trashed: false, parents: [] };
  w.drive.files.otherFolder = { id: 'otherFolder', trashed: false, parents: ['SOME_OTHER_FOLDER'] };
  w.drive.files.inFolder = { id: 'inFolder', trashed: false, parents: [FOLDER] };
  drawOnce(w);
  assert.deepStrictEqual(['legacyRoot', 'otherFolder', 'inFolder'].map((id) => w.drive.files[id].trashed), [false, false, true]);
  assert.deepStrictEqual(w.rows('Images').slice(1, 4).map((r) => r[2]), [0, 0, 1]);
});

// ---------- Images 表與保留期 ----------
test('成功生圖後 Images 表記錄檔案 ID 與建立時間', () => {
  const w = world();
  drawOnce(w);
  const rows = w.rows('Images');
  assert.deepStrictEqual(rows[0], ['file_id', 'created_at', 'trashed']);
  assert.deepStrictEqual(rows[1], [Object.keys(w.drive.files)[0], w.now, 0]);
});

test('超過 IMAGE_RETENTION_DAYS 的檔案在下一次成功生圖時被丟垃圾桶(一次至多 5 個),Images 表同步更新', () => {
  const w = world();
  const DAY = 24 * HOUR;
  const rows = [['file_id', 'created_at', 'trashed']];
  for (let i = 1; i <= 7; i++) rows.push(['old' + i, w.now - 40 * DAY - i, 0]);
  rows.push(['fresh', w.now - 5 * DAY, 0]);
  rows.push(['already', w.now - 90 * DAY, 1]);
  w.setRows('Images', rows);
  for (const id of ['old1', 'old2', 'old3', 'old4', 'old5', 'old6', 'old7', 'fresh', 'already']) w.drive.files[id] = { id, trashed: id === 'already', parents: [FOLDER] };
  drawOnce(w);
  const trashed = (id) => w.drive.files[id].trashed;
  assert.deepStrictEqual(['old1', 'old2', 'old3', 'old4', 'old5'].map(trashed), [true, true, true, true, true]);
  assert.deepStrictEqual(['old6', 'old7', 'fresh'].map(trashed), [false, false, false], '一次至多 5 個');
  const t = w.rows('Images').slice(1).map((r) => [r[0], r[2]]);
  assert.deepStrictEqual(t.slice(0, 7), [['old1', 1], ['old2', 1], ['old3', 1], ['old4', 1], ['old5', 1], ['old6', 0], ['old7', 0]]);
  drawOnce(w);
  assert.deepStrictEqual(['old6', 'old7'].map(trashed), [true, true], '下一次成功生圖繼續處理');
  assert.strictEqual(trashed(Object.keys(w.drive.files).find((id) => id.startsWith('drv'))), false, '新圖不會被丟掉');
});

test('檔案已不存在也視為已處理(不會每次重試),IMAGE_RETENTION_DAYS 可調整', () => {
  const w = world({ IMAGE_RETENTION_DAYS: '1' });
  w.setRows('Images', [['file_id', 'created_at', 'trashed'], ['gone', w.now - 2 * 24 * HOUR, 0]]);
  w.drive.missing.gone = true;
  w.drive.files.gone = { id: 'gone', trashed: false, parents: [FOLDER] };
  drawOnce(w);
  assert.strictEqual(w.rows('Images')[1][2], 1);
});

test('沒有成功生圖就不會讀 Images 表', () => {
  const w = world();
  w.setRows('Images', [['file_id', 'created_at', 'trashed'], ['old', 1, 0]]);
  w.cfHandler = () => cf.err(7000, 400);
  drawOnce(w);
  assert.strictEqual(w.stats.readsByName.Images, undefined);
});

// ---------- 其他 ----------
test('生圖成功但最後的模型呼叫失敗:圖片已存、額度仍被計數並記錄(不遺失)', () => {
  const w = world();
  w.geminiQueue.push(draw(), g.status(400));
  w.post(w.ev.text('U1', '畫一張'));
  assert.strictEqual(imgMeta(w).n, 1);
  assert.strictEqual(w.rows('Images').length, 2);
});

test('reply 失敗且 push 預算大於 0:push 的內容同樣含文字與圖片', () => {
  const w = world({ PUSH_MONTHLY_BUDGET: '5' });
  w.lineReplyHandler = () => ({ status: 400, body: { message: 'Invalid reply token' } });
  drawOnce(w);
  assert.deepStrictEqual(w.req.pushes()[0].body.messages.map((m) => m.type), ['text', 'image']);
});

test('熱請求(生圖已啟用):額度狀態來自快取,試算表讀取 0 次', () => {
  const w = world();
  w.post(w.ev.text('U1', '暖機'));
  w.post(w.ev.text('U1', '再暖機'));
  w.resetStats();
  w.post(w.ev.text('U1', '熱請求'));
  assert.strictEqual(w.stats.reads, 0);
  assert.ok(w.stats.lockAcquires <= 1);
});

test('群組也能生圖(以 @ 觸發),圖片隨 reply 送到群組', () => {
  const w = world();
  w.addUser('C1', { kind: 'group' });
  w.geminiQueue.push(draw(), g.text('畫好了'));
  w.post(w.ev.groupText('C1', 'U5', '畫一張蘋果'));
  assert.deepStrictEqual(lastReplyMsgs(w).map((m) => m.type), ['text', 'image']);
});

test('生圖與搜尋可在同一回合並存(先搜尋再生圖)', () => {
  const w = world();
  w.geminiQueue.push(g.call('web_search', { query: '蘋果品種' }, 's'), draw(), g.text('查完也畫好了'));
  w.post(w.ev.text('U1', '查蘋果品種再畫一張'));
  assert.strictEqual(w.req.search().length, 1);
  assert.strictEqual(w.req.cf().length, 1);
  assert.deepStrictEqual(lastReplyMsgs(w).map((m) => m.type), ['text', 'image']);
});

// ---------- 圖片網址健檢 ----------
const PNG_OK = { status: 200, body: 'x', headers: { 'Content-Type': 'image/png' } };

test('checkImageUrls:主格式與備援格式都正常 → 回報正常,並清掉測試檔', () => {
  const w = world();
  w.otherHandler = () => PNG_OK;
  const r = w.call('checkImageUrls');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.main.ok, true);
  assert.strictEqual(r.backup.ok, true);
  const urls = w.req.other().map((x) => x.url);
  assert.strictEqual(urls.length, 2);
  const id = Object.keys(w.drive.files)[0];
  assert.deepStrictEqual(urls, ['https://lh3.googleusercontent.com/d/' + id, 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000']);
  assert.ok(!urls.some((u) => u.includes('export=view')));
  assert.deepStrictEqual(w.drive.files[id].sharing, ['ANYONE_WITH_LINK', 'VIEW']);
  assert.strictEqual(w.drive.files[id].trashed, true);
});

test('checkImageUrls:任一格式失敗(非 200、內容不是圖片、例外)→ 回報是哪一個格式異常', () => {
  const bad = [
    () => ({ status: 403, body: 'denied' }), () => ({ status: 200, body: '<html>', headers: { 'Content-Type': 'text/html' } }), () => ({ throws: true }),
  ];
  for (const b of bad) {
    let w = world();
    w.otherHandler = (req) => (req.url.includes('lh3') ? b() : PNG_OK);
    let r = w.call('checkImageUrls');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual([r.main.ok, r.backup.ok], [false, true]);
    assert.match(r.summary, /主格式/);

    w = world();
    w.otherHandler = (req) => (req.url.includes('thumbnail') ? b() : PNG_OK);
    r = w.call('checkImageUrls');
    assert.deepStrictEqual([r.main.ok, r.backup.ok], [true, false]);
    assert.match(r.summary, /備援格式/);
  }
});

test('checkImageUrls:測試檔建立在指定資料夾;未設定資料夾 → 回報失敗且不碰根目錄', () => {
  let w = world();
  w.otherHandler = () => PNG_OK;
  w.call('checkImageUrls');
  assert.deepStrictEqual(Object.values(w.drive.files)[0].parents, [FOLDER]);
  assert.strictEqual(w.drive.rootCreates, 0);

  w = world({ IMAGE_DRIVE_FOLDER_ID: '' });
  const r = w.call('checkImageUrls');
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /IMAGE_DRIVE_FOLDER_ID/);
  assert.strictEqual(Object.keys(w.drive.files).length, 0);
  assert.strictEqual(w.drive.rootCreates, 0);
});

test('checkImageUrls:Drive 無法分享時回報失敗並清掉檔案', () => {
  const w = world();
  w.drive.failSharing = true;
  const r = w.call('checkImageUrls');
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /Drive/);
  assert.ok(Object.values(w.drive.files).every((f) => f.trashed));
});

test('只開生圖、沒有搜尋金鑰時:「幫我查…」不會呼叫 TinyFish,也不會把空金鑰送出去', () => {
  const w = world({ TINYFISH_API_KEY: '' });
  w.post(w.ev.text('U1', '幫我查一下台北天氣'));
  assert.strictEqual(w.req.search().length, 0);
  assert.strictEqual(w.req.gemini().length, 1);
  // 模型幻覺出搜尋函式呼叫時,工具回錯誤而不是送出請求
  w.geminiQueue.push(g.call('web_search', { query: '台北天氣' }, 'x'), g.text('ok'));
  w.post(w.ev.text('U1', '今天天氣如何'));
  assert.strictEqual(w.req.search().length, 0);
  assert.ok(responsesOf(w.req.gemini().at(-1))[0].response.error);
});
