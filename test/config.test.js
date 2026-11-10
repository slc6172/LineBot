'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld } = require('./world');

test('缺少非必要金鑰(搜尋金鑰):該功能停用、有狀態日誌、其他功能不受影響', () => {
  const w = createWorld({ props: { TINYFISH_API_KEY: '' } });
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.replyTexts().length, 1);
  assert.strictEqual(w.req.gemini().length, 1);
  const l = w.logs().find((x) => x.code === 'KEY_MISSING');
  assert.ok(l);
  assert.strictEqual(l.level, '狀態');
  assert.strictEqual(l.detail, 'TINYFISH_API_KEY');
});

test('缺金鑰的狀態日誌每小時最多記一次', () => {
  const w = createWorld({ props: { TINYFISH_API_KEY: '' } });
  w.post(w.ev.text('U1', 'a'));
  w.post(w.ev.text('U1', 'b'));
  assert.strictEqual(w.logs().filter((x) => x.code === 'KEY_MISSING').length, 1);
});

test('生圖關閉時不因缺少 Cloudflare 金鑰而記日誌;開啟後才記', () => {
  let w = createWorld();
  w.post(w.ev.text('U1', 'hi'));
  assert.ok(!w.logs().some((l) => /CF_/.test(l.detail)));
  w = createWorld({ props: { IMAGE_ENABLED: 'true' } });
  w.post(w.ev.text('U1', 'hi'));
  assert.ok(w.logs().some((l) => l.code === 'KEY_MISSING' && l.detail === 'CF_API_TOKEN'));
});

test('設定值超出範圍(IMAGE_MAX_PER_DAY=-3)→ 使用預設值並記一筆狀態日誌,不影響對話', () => {
  const w = createWorld({ props: { IMAGE_MAX_PER_DAY: '-3' } });
  w.post(w.ev.text('U1', 'hi'));
  assert.strictEqual(w.replyTexts().length, 1);
  const l = w.logs().find((x) => x.code === 'CONFIG_RANGE');
  assert.ok(l);
  assert.strictEqual(l.level, '狀態');
  assert.strictEqual(l.detail, 'IMAGE_MAX_PER_DAY');
});

test('loadConfig 預設值(取自 spec 設定表)', () => {
  const w = createWorld();
  const { cfg, issues } = w.call('loadConfig', {});
  assert.deepStrictEqual(issues, []);
  const expected = {
    GEMINI_MODEL: 'gemini-3.5-flash-lite', GEMINI_MODEL_AUX: 'gemini-3.5-flash-lite', THINKING_LEVEL: 'low', MAX_OUTPUT_TOKENS: 1024,
    TIME_BUDGET_S: 60, BUDGET_RESERVE_S: 5, MIN_TURN_S: 12, MAX_TOOL_TURNS: 3, HISTORY_MAX_TURNS: 20, FOLD_BATCH_TURNS: 10,
    MEMORY_ENABLED: true, LONG_TERM_MAX_CHARS: 2000, RECENT_NOTES_MAX_CHARS: 600, RETRIEVAL_K: 3, RETRIEVAL_SNIPPET_CHARS: 200,
    RETRIEVAL_MIN_MESSAGE_CHARS: 3, RETRIEVAL_MIN_SCORE: 0.6, ARCHIVE_SCAN_LIMIT: 5000, SEARCH_MAX_RESULTS: 5, SEARCH_LOCATION: 'TW',
    SEARCH_LANGUAGE: 'zh', IMAGE_ENABLED: false, IMAGE_DRIVE_FOLDER_ID: '', CF_IMAGE_MODEL: 'flux-2-klein-9b', IMAGE_WIDTH: 576, IMAGE_HEIGHT: 1024,
    IMAGE_MAX_PER_DAY: 6, IMAGE_COOLDOWN_S: 30, IMAGE_MIN_BUDGET_S: 20, IMAGE_RETENTION_DAYS: 30, IMAGE_PENDING_TTL_S: 600,
    IMAGE_PENDING_MAX: 3, USERS_CACHE_TTL_S: 300, FORGET_CONFIRM_TTL_S: 60, GAP_MARKER_MINUTES: 30, TIMEZONE: 'Asia/Taipei',
    PUSH_MONTHLY_BUDGET: 0, LOG_MAX_ROWS: 1000, DEBUG_TIMING: false,
  };
  for (const [k, v] of Object.entries(expected)) assert.strictEqual(cfg[k], v, k);
  assert.deepStrictEqual(cfg.SEARCH_BLOCKED_DOMAINS, []);
});

test('loadConfig 範圍檢查(表格式):超出範圍或型別錯誤 → 預設值 + 回報問題', () => {
  const w = createWorld();
  const cases = [
    ['IMAGE_MAX_PER_DAY', '-3', 6], ['IMAGE_MAX_PER_DAY', '1.5', 6], ['IMAGE_MAX_PER_DAY', 'abc', 6], ['IMAGE_MAX_PER_DAY', '2000', 6],
    ['TIME_BUDGET_S', '5', 60], ['TIME_BUDGET_S', '9999', 60], ['THINKING_LEVEL', 'extreme', 'low'], ['MEMORY_ENABLED', 'yes', true],
    ['GEMINI_MODEL', 'bad model/../x', 'gemini-3.5-flash-lite'], ['SEARCH_LOCATION', 'taiwan', 'TW'], ['PUSH_MONTHLY_BUDGET', '-1', 0],
    ['LOG_MAX_ROWS', '10', 1000], ['IMAGE_DRIVE_FOLDER_ID', 'https://drive.google.com/drive/folders/abc', ''], ['IMAGE_DRIVE_FOLDER_ID', 'short', ''], ['USERS_CACHE_TTL_S', '0', 300],
  ];
  for (const [k, raw, def] of cases) {
    const { cfg, issues } = w.call('loadConfig', { [k]: raw });
    assert.strictEqual(cfg[k], def, k + '=' + raw);
    assert.deepStrictEqual(issues, [k], k + '=' + raw);
  }
});

test('loadConfig 合法的自訂值被採用;空字串視為未設定(不算問題)', () => {
  const w = createWorld();
  const { cfg, issues } = w.call('loadConfig', {
    IMAGE_MAX_PER_DAY: ' 10 \n', IMAGE_ENABLED: 'TRUE', GEMINI_MODEL: 'gemini-x-1', TIME_BUDGET_S: '45.5', DEBUG_TIMING: '', SEARCH_BLOCKED_DOMAINS: 'A.com, b.com',
  });
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(cfg.IMAGE_MAX_PER_DAY, 10);
  assert.strictEqual(cfg.IMAGE_ENABLED, true);
  assert.strictEqual(cfg.TIME_BUDGET_S, 45.5);
  assert.strictEqual(cfg.DEBUG_TIMING, false);
  assert.strictEqual(cfg.GEMINI_MODEL_AUX, 'gemini-x-1', 'AUX 預設同對話模型');
  assert.deepStrictEqual(cfg.SEARCH_BLOCKED_DOMAINS, ['a.com', 'b.com']);
});

test('輔助模型可與對話模型分開設定', () => {
  const w = createWorld();
  const { cfg } = w.call('loadConfig', { GEMINI_MODEL: 'm-main', GEMINI_MODEL_AUX: 'm-aux' });
  assert.strictEqual(cfg.GEMINI_MODEL, 'm-main');
  assert.strictEqual(cfg.GEMINI_MODEL_AUX, 'm-aux');
});

test('對話使用 GEMINI_MODEL 設定的模型、MAX_OUTPUT_TOKENS 與 THINKING_LEVEL', () => {
  const w = createWorld({ props: { GEMINI_MODEL: 'my-model', MAX_OUTPUT_TOKENS: '2048', THINKING_LEVEL: 'minimal' } });
  w.post(w.ev.text('U1', 'hi'));
  const r = w.req.gemini()[0];
  assert.ok(r.url.includes('/models/my-model:generateContent'));
  assert.strictEqual(r.body.generationConfig.maxOutputTokens, 2048);
  assert.strictEqual(r.body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
});
