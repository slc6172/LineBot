'use strict';
// 假的 GAS 世界:用 Node vm 載入 src/*.js,提供假的全域物件。
// 每次 doPost 都建立全新的 vm context(像 GAS 每次執行重新載入全域),
// 但 world 內的試算表、快取、屬性、時鐘、請求紀錄跨請求共用。

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const RealDate = Date;
const SRC_DIR = path.join(__dirname, '..', 'src');
const SCRIPTS = fs.readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => new vm.Script(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'), { filename: f }));

const CELL_LIMIT = 50000;
const CACHE_VALUE_LIMIT = 100 * 1024;

function makeFakeDate() {
  function FD(...a) {
    if (!a.length) throw new Error('new Date() without args: use Clock.now()');
    return new RealDate(...a);
  }
  FD.now = () => { throw new Error('Date.now(): use Clock.now()'); };
  FD.UTC = RealDate.UTC;
  FD.parse = RealDate.parse;
  FD.prototype = RealDate.prototype;
  return FD;
}

class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  setNumberFormat(fmt) { if (fmt === '@') this.sheet.plainText = true; return this; }
  getValues() {
    const w = this.sheet.w;
    w.ops.push('read:' + this.sheet.name);
    w.stats.reads++; w.stats.readsByName[this.sheet.name] = (w.stats.readsByName[this.sheet.name] || 0) + 1;
    w.advance(w.latency.getValues || 0);
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.data[this.r - 1 + i] || [];
      const o = [];
      for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; o.push(v === undefined || v === null ? '' : v); }
      out.push(o);
    }
    return out;
  }
  setValues(vals) {
    const w = this.sheet.w;
    if (!Array.isArray(vals) || vals.length !== this.nr) throw new Error('shape mismatch (rows)');
    for (const row of vals) {
      if (row.length !== this.nc) throw new Error('shape mismatch (cols)');
      for (const v of row) {
        if (typeof v === 'string' && v.length > CELL_LIMIT) throw new Error('セルの文字数が上限を超えています');
        // 使用者內容不得被試算表當成公式:要嘛設成純文字格式,要嘛不能以 = + - @ 開頭
        if (typeof v === 'string' && /^[=+\-@]/.test(v) && !this.sheet.plainText) throw new Error('formula injection risk in ' + this.sheet.name + ': ' + v.slice(0, 20));
      }
    }
    w.ops.push('write:' + this.sheet.name);
    w.stats.writes++; w.stats.writesByName[this.sheet.name] = (w.stats.writesByName[this.sheet.name] || 0) + 1;
    w.advance(w.latency.setValues || 0);
    for (let i = 0; i < this.nr; i++) {
      const ri = this.r - 1 + i;
      while (this.sheet.data.length <= ri) this.sheet.data.push([]);
      const row = this.sheet.data[ri];
      for (let j = 0; j < this.nc; j++) {
        const ci = this.c - 1 + j;
        while (row.length <= ci) row.push('');
        row[ci] = vals[i][j];
      }
    }
    return this;
  }
}

class FakeSheet {
  constructor(w, name) { this.w = w; this.name = name; this.data = []; this.maxRows = 1000; this.maxCols = 26; }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if (this.data[i].some((c) => c !== '' && c != null)) return i + 1;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    for (const r of this.data) for (let j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] != null) { m = Math.max(m, j + 1); break; }
    return m;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > this.maxRows || c + nc - 1 > this.maxCols) {
      throw new Error('範囲がシートの寸法外です');
    }
    return new FakeRange(this, r, c, nr, nc);
  }
  insertRowsAfter(after, n) { this.w.stats.writes++; this.maxRows += n; }
  insertColumnsAfter(after, n) { this.w.stats.writes++; this.maxCols += n; }
  deleteRows(start, n) {
    this.w.stats.writes++; this.w.stats.deleteRows++;
    this.data.splice(start - 1, n);
    this.maxRows = Math.max(1, this.maxRows - n);
  }
  clear() { this.w.stats.writes++; this.data = []; }
  appendRow(vals) {
    this.w.stats.appendRow++;
    this.data[this.getLastRow()] = vals.slice();
  }
}

class FakeSpreadsheet {
  constructor(w) { this.w = w; }
  getSheetByName(n) { return this.w.sheets[n] || null; }
  insertSheet(n) { this.w.stats.writes++; return (this.w.sheets[n] = new FakeSheet(this.w, n)); }
  getSheets() { return Object.values(this.w.sheets); }
}

function mkResp(status, body, headers, bytes) {
  if (bytes) {
    return { getResponseCode: () => status, getContentText: () => '', getHeaders: () => headers || {}, getContent: () => Array.from(bytes), getBlob: () => ({ getBytes: () => Array.from(bytes) }) };
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body === undefined ? {} : body);
  return {
    getResponseCode: () => status,
    getContentText: () => text,
    getHeaders: () => headers || {},
    getContent: () => Array.from(Buffer.from(text)),
    getBlob: () => ({ getBytes: () => Array.from(Buffer.from(text)) }),
  };
}

// ---- Gemini 劇本的小工具(測試用) ----
// Cloudflare 回應的小工具(測試用)。錯誤訊息刻意用日文:程式不得依賴訊息文字
const cf = {
  ok: (bytes) => ({ status: 200, body: { success: true, errors: [], result: { image: Buffer.from(bytes).toString('base64') } } }),
  err: (code, status) => ({ status: status || 400, body: { success: false, errors: [{ code, message: 'エラーが発生しました' }], result: null } }),
};

const g = {
  text: (t) => ({ status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: 'STOP' }] } }),
  maxTokens: (t) => ({ status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: 'MAX_TOKENS' }] } }),
  // 錯誤訊息文字刻意用日文:程式不得依賴訊息文字分類
  status: (code, msg) => ({ status: code, body: { error: { code, message: msg || 'エラーが発生しました', status: 'ERR' } } }),
  blockedPrompt: () => ({ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }),
  blockedFinish: () => ({ status: 200, body: { candidates: [{ finishReason: 'SAFETY' }] } }),
  // 模型要求呼叫函式。calls: [{name, args, id?, extra?}];extra 會原樣併入該 part(例如 thoughtSignature)
  calls: (calls, extraPart) => ({ status: 200, body: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: calls.map((c, i) => Object.assign({ functionCall: Object.assign({ name: c.name, args: c.args }, c.id === undefined ? {} : { id: c.id }) }, c.extra || {})) } }] } }),
  call: (name, args, id, extra) => g.calls([{ name, args, id, extra }]),
  throws: (delayMs) => ({ throws: true, delayMs: delayMs || 0 }),
  delay: (ms, item) => Object.assign({}, item, { delayMs: ms }),
};

function createWorld(initial) {
  initial = initial || {};
  const w = {
    now: Date.UTC(2026, 10, 3, 2, 0, 0), // 2026-11-03 10:00 台北,星期二
    props: Object.assign({
      LINE_CHANNEL_ACCESS_TOKEN: 'LINE-TOKEN-SECRET',
      GEMINI_API_KEY: 'GEMINI-KEY-SECRET',
      TINYFISH_API_KEY: 'TINYFISH-KEY-SECRET',
      WEBHOOK_KEY: 'hook-key',
      SPREADSHEET_ID: 'SSID',
    }, initial.props || {}),
    cacheMap: new Map(),
    sheets: {},
    requests: [],
    stats: null,
    latency: {},
    lockBusy: false,
    lockHeld: false,
    geminiQueue: [],
    images: {},
    cfHandler: null,
    cfImageBytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('FAKEJPEGBODY'.repeat(50))]),
    drive: { files: {}, folders: { FOLDER_IMG_0123456789: true }, failSharing: false, failCreate: false, missing: {}, n: 0, rootCreates: 0 },
    otherHandler: null,
    lineContentHandler: null,
    tfSearchHandler: null,
    tfFetchHandler: null,
    searchResults: [
      { position: 1, site_name: '氣象署', title: '台北天氣預報', snippet: '今天多雲時晴,氣溫 24 度。', url: 'https://www.cwa.example.gov/taipei' },
      { position: 2, site_name: '新聞網', title: '週末降雨機率', snippet: '週末北部有雨。', url: 'https://news.example.com/weather' },
      { position: 3, site_name: '論壇', title: '討論串', snippet: '大家怎麼看天氣', url: 'https://forum.example.org/t/1' },
    ],
    pageText: '# 台北天氣\n\n今天 24 度,週末有雨。',
    geminiFallback: () => g.text('OK'),
    beforeGemini: null,
    lineReplyHandler: null,
    linePushHandler: null,
    _seq: 0,
  };
  w.ops = [];
  // 讀取階段 = 彼此相連、中間沒有任何寫入/外部呼叫/取鎖的讀取
  w.readPhases = () => { let n = 0; let prev = ''; for (const o of w.ops) { const isRead = o.startsWith('read:'); if (isRead && !prev.startsWith('read:')) n++; prev = o; } return n; };
  w.resetStats = () => {
    w.ops = [];
    w.stats = { reads: 0, writes: 0, appendRow: 0, openById: 0, deleteRows: 0, lockAcquires: 0, cachePuts: 0, readsByName: {}, writesByName: {} };
  };
  w.resetStats();
  w.advance = (ms) => { w.now += ms; };

  // ---- 試算表 ----
  w.sheet = (name) => w.sheets[name] || (w.sheets[name] = new FakeSheet(w, name));
  w.setRows = (name, rows) => { const s = w.sheet(name); s.data = rows.map((r) => r.slice()); };
  w.rows = (name) => (w.sheets[name] ? w.sheets[name].data.map((r) => r.slice()) : []);
  w.addUser = (id, o) => {
    o = o || {};
    const s = w.sheet('Users');
    if (!s.data.length) s.data.push(['id', 'kind', 'note', 'enabled', 'added_at']);
    s.data.push([id, o.kind || 'user', o.note || '', o.enabled === false ? false : true, '']);
  };
  w.setUserEnabled = (id, enabled) => {
    const s = w.sheet('Users');
    for (const r of s.data) if (r[0] === id) r[3] = enabled;
  };
  w.logs = () => w.rows('Logs').slice(1).map((r) => ({ time: r[0], level: r[1], code: r[2], chatId: r[3], detail: r[4] }));
  w.logCodes = () => w.logs().map((l) => l.code);
  // 直接放一個聊天室的狀態(獨立的編碼實作,測試用)。facts 為 {使用者:'- a\n- b', ...}
  w.setState = (chatId, o) => {
    o = o || {};
    const chunks = (str) => (str ? str.match(/[\s\S]{1,40000}/g).map((c) => '~' + c) : []);
    const f = chunks(o.facts ? JSON.stringify(o.facts) : '');
    const h = chunks(JSON.stringify(o.history || []));
    const row = [chatId, o.kind || 'user', o.updatedAt || w.now, o.lastAt || 0, JSON.stringify(o.meta || {}), f.length, h.length].concat(f, h);
    const s = w.sheet('State');
    if (!s.data.length) s.data.push(['chat_id', 'kind', 'updated_at', 'last_at', 'meta', 'facts_chunks', 'history_chunks']);
    s.maxCols = Math.max(s.maxCols, row.length);
    const i = s.data.findIndex((r) => r[0] === chatId);
    if (i >= 0) s.data[i] = row; else s.data.push(row);
    w.clearCache();
  };
  w.addEvents = (chatId, events) => {
    const s = w.sheet('Events'); s.plainText = true;
    if (!s.data.length) s.data.push(['chat_id', 'date', 'time', 'kind', 'text']);
    for (const e of events) s.data.push([chatId, e.date, e.time || '', e.kind || '事件', e.text]);
    w.clearCache();
  };
  w.addArchive = (chatId, rows) => {
    const s = w.sheet('Archive'); s.plainText = true;
    if (!s.data.length) s.data.push(['chat_id', 'ts', 'role', 'text', 'polluted']);
    for (const r of rows) s.data.push([chatId, r.ts, r.role || 'u', r.text, r.polluted ? 1 : 0]);
    w.clearCache();
  };
  w.stateRow = (chatId) => w.rows('State').find((r) => r[0] === chatId) || null;
  // 獨立解碼 State 列(測試用):回傳 {history, facts, meta, lastAt}
  w.stateOf = (chatId) => {
    const r = w.stateRow(chatId);
    if (!r) return null;
    const nf = Number(r[5]) || 0; const nh = Number(r[6]) || 0;
    const un = (cells) => cells.map((c) => String(c).slice(1)).join('');
    return { facts: un(r.slice(7, 7 + nf)), history: JSON.parse(un(r.slice(7 + nf, 7 + nf + nh)) || '[]'), meta: JSON.parse(r[4] || '{}'), lastAt: r[3] };
  };
  // 以台北時間設定假時鐘
  w.setTaipei = (y, mo, d, h, mi) => { w.now = Date.UTC(y, mo - 1, d, h - 8, mi || 0, 0); };

  // ---- 快取 ----
  w.cacheGet = (k) => {
    const e = w.cacheMap.get(k);
    if (!e) return null;
    if (e.exp <= w.now) { w.cacheMap.delete(k); return null; }
    return e.v;
  };
  w.cachePut = (k, v, ttl) => {
    if (Buffer.byteLength(String(v), 'utf8') > CACHE_VALUE_LIMIT) throw new Error('引数が大きすぎます: value');
    w.stats.cachePuts++;
    w.cacheMap.set(k, { v: String(v), exp: w.now + (ttl === undefined ? 600 : ttl) * 1000 });
  };
  w.clearCache = () => w.cacheMap.clear();
  w.cacheKeys = () => Array.from(w.cacheMap.keys());

  // ---- 外部請求 ----
  function parseBody(opts) {
    if (opts && typeof opts.payload === 'string') { try { return JSON.parse(opts.payload); } catch (e) { return opts.payload; } }
    return opts && opts.payload && typeof opts.payload === 'object' ? JSON.parse(JSON.stringify(opts.payload)) : opts && opts.payload; // 物件 payload 複製成外部世界的純資料
  }
  function routeOne(url, opts) {
    w.ops.push('fetch');
    const req = {
      url, method: ((opts && opts.method) || 'get').toLowerCase(), headers: (opts && opts.headers) || {},
      body: parseBody(opts), timeoutSeconds: opts && opts.timeoutSeconds, mute: !!(opts && opts.muteHttpExceptions), at: w.now,
    };
    w.requests.push(req);
    let item;
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      req.kind = 'gemini';
      if (w.beforeGemini) w.beforeGemini(req);
      item = w.geminiQueue.length ? w.geminiQueue.shift() : w.geminiFallback(req);
      if (typeof item === 'function') item = item(req);
    } else if (url.startsWith('https://api.search.tinyfish.ai')) {
      req.kind = 'tf-search';
      const q = /[?&]query=([^&]*)/.exec(url);
      req.query = q ? decodeURIComponent(q[1]) : null;
      req.params = {};
      (url.split('?')[1] || '').split('&').filter(Boolean).forEach((kv) => { const [k, v] = kv.split('='); req.params[k] = decodeURIComponent(v || ''); });
      item = w.tfSearchHandler ? w.tfSearchHandler(req) : { status: 200, body: { results: w.searchResults } };
    } else if (url === 'https://api.fetch.tinyfish.ai') {
      req.kind = 'tf-fetch';
      item = w.tfFetchHandler ? w.tfFetchHandler(req) : { status: 200, body: { results: [{ title: '頁面', text: w.pageText }] } };
    } else if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/')) {
      req.kind = 'cf-image';
      item = w.cfHandler ? w.cfHandler(req) : cf.ok(w.cfImageBytes);
    } else if (/^https:\/\/api-data\.line\.me\/v2\/bot\/message\/[^/]+\/content$/.test(url)) {
      req.kind = 'line-content';
      req.messageId = /message\/([^/]+)\/content/.exec(url)[1];
      const custom = w.images[req.messageId];
      if (w.lineContentHandler) item = w.lineContentHandler(req);
      else if (custom) item = typeof custom === 'function' ? custom(req) : custom;
      else item = { status: 200, bytes: Buffer.from('JPEGDATA-' + req.messageId), headers: { 'Content-Type': 'image/jpeg' } };
    } else if (url === 'https://api.line.me/v2/bot/message/reply') {
      req.kind = 'line-reply';
      item = w.lineReplyHandler ? w.lineReplyHandler(req) : { status: 200, body: {} };
    } else if (url === 'https://api.line.me/v2/bot/message/push') {
      req.kind = 'line-push';
      item = w.linePushHandler ? w.linePushHandler(req) : { status: 200, body: {} };
    } else {
      req.kind = 'other';
      item = w.otherHandler ? w.otherHandler(req) : { status: 404, body: { message: 'not found' } };
    }
    return { req, item };
  }
  function finish(req, item, delayCharged) {
    if (item.throws) throw new Error('接続エラー');
    return mkResp(item.status, item.body, item.headers, item.bytes);
  }
  w.fetch = (url, opts) => {
    const { req, item } = routeOne(url, opts);
    const delay = item.delayMs || 0;
    const tmo = req.timeoutSeconds ? req.timeoutSeconds * 1000 : Infinity;
    if (item.throws) { w.advance(Math.min(delay, tmo)); throw new Error('接続エラー'); }
    if (delay > tmo) { w.advance(tmo); throw new Error('タイムアウト'); }
    w.advance(delay);
    return finish(req, item);
  };
  w.fetchAll = (reqs) => {
    const routed = reqs.map((r) => routeOne(r.url, r));
    let maxDelay = 0;
    const out = routed.map(({ req, item }) => {
      const delay = item.delayMs || 0;
      const tmo = req.timeoutSeconds ? req.timeoutSeconds * 1000 : Infinity;
      if (item.throws || delay > tmo) { maxDelay = Math.max(maxDelay, Math.min(delay, tmo)); return { err: true }; }
      maxDelay = Math.max(maxDelay, delay);
      return { resp: finish(req, item) };
    });
    w.advance(maxDelay);
    if (out.some((o) => o.err)) throw new Error('接続エラー');
    w.stats.fetchAllCalls = (w.stats.fetchAllCalls || 0) + 1;
    return out.map((o) => o.resp);
  };
  w.req = {
    all: () => w.requests,
    gemini: () => w.requests.filter((r) => r.kind === 'gemini'),
    replies: () => w.requests.filter((r) => r.kind === 'line-reply'),
    content: () => w.requests.filter((r) => r.kind === 'line-content'),
    cf: () => w.requests.filter((r) => r.kind === 'cf-image'),
    other: () => w.requests.filter((r) => r.kind === 'other'),
    search: () => w.requests.filter((r) => r.kind === 'tf-search'),
    fetch: () => w.requests.filter((r) => r.kind === 'tf-fetch'),
    pushes: () => w.requests.filter((r) => r.kind === 'line-push'),
    external: () => w.requests,
  };
  w.replyTexts = () => w.req.replies().map((r) => r.body.messages.map((m) => m.text).join('\n'));
  w.lastReplyText = () => { const t = w.replyTexts(); return t[t.length - 1]; };

  // ---- 載入 / 執行 ----
  function fileApi(id, rec) {
    const api = {
      getId: () => id,
      setSharing: (a, p) => { if (w.drive.failSharing) throw new Error('管理員不允許公開分享'); rec.sharing = [a, p]; return api; },
      setTrashed: (t) => { rec.trashed = t; },
      getParents: () => {
        const ids = rec.parents || [];
        let i = 0;
        return { hasNext: () => i < ids.length, next: () => { const pid = ids[i++]; return { getId: () => pid }; } };
      },
    };
    return api;
  }
  function makeFile(blob, parentId) {
    if (w.drive.failCreate) throw new Error('Drive 容量不足');
    const id = 'drv' + (++w.drive.n);
    const rec = (w.drive.files[id] = { id, name: blob.name, mime: blob.mime, bytes: blob.bytes, sharing: null, trashed: false, parents: parentId ? [parentId] : [] });
    return fileApi(id, rec);
  }
  function globals() {
    const out = {
      console,
      Date: makeFakeDate(),
      Logger: { log() {} },
      ContentService: { createTextOutput: (s) => ({ getContent: () => s, getText: () => s }) },
      UrlFetchApp: { fetch: (u, o) => w.fetch(u, o), fetchAll: (rs) => w.fetchAll(rs) },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperties: () => Object.assign({}, w.props),
          getProperty: (k) => (k in w.props ? w.props[k] : null),
          setProperty: (k, v) => { w.props[k] = String(v); },
        }),
      },
      CacheService: {
        getScriptCache: () => ({
          get: (k) => { w.advance(w.latency.cacheGet || 0); return w.cacheGet(k); },
          put: (k, v, ttl) => { w.advance(w.latency.cachePut || 0); w.cachePut(k, v, ttl); },
          remove: (k) => { w.cacheMap.delete(k); },
        }),
      },
      LockService: {
        getScriptLock: () => ({
          waitLock: (ms) => {
            if (w.lockBusy) { w.advance(ms); throw new Error('ロックを取得できませんでした'); }
            w.advance(w.latency.lock || 0);
            w.stats.lockAcquires++; w.lockHeld = true; w.ops.push('lock');
          },
          releaseLock: () => { w.lockHeld = false; },
        }),
      },
      SpreadsheetApp: {
        openById: (id) => {
          if (id !== 'SSID') throw new Error('シートが見つかりません');
          w.stats.openById++;
          w.advance(w.latency.openById || 0);
          return new FakeSpreadsheet(w);
        },
      },
      DriveApp: {
        Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' },
        // 根目錄 createFile:生圖相關程式不應該再呼叫它(rootCreates 用來驗證)
        createFile: (blob) => {
          w.drive.rootCreates++;
          return makeFile(blob, null);
        },
        getFolderById: (fid) => {
          if (!w.drive.folders[fid]) throw new Error('找不到資料夾或沒有權限');
          return { getId: () => fid, createFile: (blob) => makeFile(blob, fid) };
        },
        getFileById: (id) => {
          const rec = w.drive.files[id];
          if (!rec || w.drive.missing[id]) throw new Error('找不到檔案');
          return fileApi(id, rec);
        },
      },
      Utilities: {
        sleep: (ms) => { w.advance(ms); },
        getUuid: () => 'uuid-' + (++w._seq),
        formatDate: (d, tz, fmt) => formatDate(d, tz, fmt),
        base64Decode: (str) => Array.from(Buffer.from(str, 'base64')).map((b) => (b > 127 ? b - 256 : b)),
        newBlob: (bytes, mime, name) => ({ bytes, mime, name, getBytes: () => bytes, getContentType: () => mime, getName: () => name }),
        base64Encode: (bytes) => Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString('base64'),
      },
    };
    return out;
  }
  w.load = () => {
    const ctx = vm.createContext(globals());
    for (const s of SCRIPTS) s.runInContext(ctx);
    ctx.Clock.now = () => w.now;
    ctx.Clock.sleep = (ms) => { w.advance(ms); };
    return ctx;
  };
  w.call = (fn, ...args) => {
    const ctx = w.load();
    const r = ctx[fn](...args);
    return r === undefined ? r : JSON.parse(JSON.stringify(r));
  };
  w.post = (events, o) => {
    o = o || {};
    const ctx = w.load();
    const key = o.key === undefined ? 'hook-key' : o.key;
    const e = {
      parameter: key === null ? {} : { k: key },
      postData: { contents: o.raw !== undefined ? o.raw : JSON.stringify({ destination: 'Ubot', events: [].concat(events) }) },
    };
    return ctx.doPost(e);
  };
  w.get = () => w.load().doGet({ parameter: {} });

  // ---- LINE 事件產生器 ----
  w.ev = {
    text: (userId, text, o) => {
      o = o || {};
      const n = ++w._seq;
      return {
        type: 'message', mode: 'active', timestamp: w.now, webhookEventId: o.id === undefined ? 'evt-' + n : o.id,
        deliveryContext: { isRedelivery: !!o.redelivery }, replyToken: o.replyToken || 'rt-' + n,
        source: o.source || { type: 'user', userId }, message: Object.assign({ type: 'text', id: 'm' + n, text }, o.mention ? { mention: o.mention } : {}),
      };
    },
    image: (userId, o) => {
      o = o || {};
      const n = ++w._seq;
      return { type: 'message', mode: 'active', timestamp: w.now, webhookEventId: o.eventId === undefined ? 'evt-' + n : o.eventId,
        deliveryContext: { isRedelivery: false }, replyToken: 'rt-' + n, source: o.source || { type: 'user', userId },
        message: { type: 'image', id: o.id || 'img-' + n, contentProvider: { type: 'line' } } };
    },
    // 群組文字;at=true 時在開頭加上「@Bot 」並附上「自己被 @」的提及資訊
    groupText: (groupId, userId, text, o) => {
      o = o || {};
      const source = o.room ? { type: 'room', roomId: groupId, userId } : { type: 'group', groupId, userId };
      if (o.at === false) return w.ev.text(userId, text, { source, id: o.id });
      const full = '@Bot ' + text;
      return w.ev.text(userId, full, { source, id: o.id, mention: o.mention || { mentionees: [{ index: 0, length: 4, type: 'user', userId: 'Ubot', isSelf: true }] } });
    },
    groupImage: (groupId, userId, o) => w.ev.image(userId, Object.assign({}, o, { source: { type: 'group', groupId, userId } })),
    sticker: (userId) => {
      const n = ++w._seq;
      return { type: 'message', timestamp: w.now, webhookEventId: 'evt-' + n, deliveryContext: { isRedelivery: false }, replyToken: 'rt-' + n,
        source: { type: 'user', userId }, message: { type: 'sticker', id: 'm' + n, packageId: '1', stickerId: '1' } };
    },
    follow: (userId) => {
      const n = ++w._seq;
      return { type: 'follow', timestamp: w.now, webhookEventId: 'evt-' + n, deliveryContext: { isRedelivery: false }, replyToken: 'rt-' + n, source: { type: 'user', userId } };
    },
  };

  // 預設:U1 在白名單
  if (initial.defaultUser !== false) w.addUser('U1');
  return w;
}

function formatDate(d, tz, fmt) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(new RealDate(d.getTime()));
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  const map = { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second, u: String(wd) };
  return fmt.replace(/yyyy|MM|dd|HH|mm|ss|u/g, (t) => map[t]);
}

module.exports = { createWorld, g, cf };
