// GAS 服務的薄轉接層:測試可整組替換。需要 rc 的呼叫都會(在 DEBUG_TIMING 開啟時)記錄耗時。
function timed_(rc, label, fn) {
  if (!rc || !rc.cfg || !rc.cfg.DEBUG_TIMING) return fn();
  var t = Clock.now();
  try { return fn(); } finally { logAdd(rc, 'DEBUG', 'TIMING', '', label + ' ' + (Clock.now() - t) + 'ms'); }
}

function utf8Len_(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

var Cache = {
  get: function (rc, k) {
    try { return timed_(rc, 'cache.get', function () { return CacheService.getScriptCache().get(k); }); } catch (e) { return null; }
  },
  put: function (rc, k, v, ttlS) {
    try {
      timed_(rc, 'cache.put', function () { CacheService.getScriptCache().put(k, v, Math.min(Math.max(1, Math.floor(ttlS)), 21600)); });
      return true;
    } catch (e) { return false; }
  },
  remove: function (rc, k) {
    try { CacheService.getScriptCache().remove(k); } catch (e) { /* 忽略 */ }
  }
};

var Lock = {
  // 取得全域鎖;取不到回傳 null
  acquire: function (rc, waitMs) {
    var l;
    try {
      l = LockService.getScriptLock();
      timed_(rc, 'lock.wait', function () { l.waitLock(waitMs); });
    } catch (e) { return null; }
    return { release: function () { try { l.releaseLock(); } catch (e2) { /* 忽略 */ } } };
  }
};

// 回傳統一格式:{code, thrown, text(), json(), raw}。例外一律視為 thrown(不依賴錯誤訊息文字)。
var Http = {
  wrap_: function (r) {
    var cached = null;
    return {
      thrown: false,
      code: r.getResponseCode(),
      raw: r,
      text: function () { if (cached === null) cached = r.getContentText(); return cached; },
      json: function () { try { return JSON.parse(this.text()); } catch (e) { return null; } }
    };
  },
  // 二進位內容(位元組陣列)與不分大小寫的標頭
  bytes: function (res) { return res.raw ? res.raw.getContent() : []; },
  header: function (res, name) {
    var h = res.raw && res.raw.getHeaders ? res.raw.getHeaders() : {};
    var want = name.toLowerCase();
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === want) return String(h[k]);
    return '';
  },
  thrown_: function () {
    return { thrown: true, code: 0, raw: null, text: function () { return ''; }, json: function () { return null; } };
  },
  opts_: function (opts) {
    var o = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.muteHttpExceptions = true;
    return o;
  },
  label_: function (url) {
    var m = /^https?:\/\/([^\/?#]+)/.exec(url);
    return m ? m[1] : 'http';
  },
  fetch: function (rc, url, opts) {
    return timed_(rc, 'http ' + Http.label_(url), function () {
      try { return Http.wrap_(UrlFetchApp.fetch(url, Http.opts_(opts || {}))); } catch (e) { return Http.thrown_(); }
    });
  },
  // reqs: [{url, ...opts}];以一次 fetchAll 並行送出
  fetchAll: function (rc, reqs) {
    var list = reqs.map(function (r) { return Http.opts_(r); });
    return timed_(rc, 'http fetchAll x' + reqs.length, function () {
      try { return UrlFetchApp.fetchAll(list).map(Http.wrap_); } catch (e) {
        return reqs.map(function () { return Http.thrown_(); });
      }
    });
  }
};

// ---- 試算表 ----
function openSpreadsheet_(rc) {
  if (!rc.ss) {
    if (!rc.cfg.SPREADSHEET_ID) throw new Error('no spreadsheet');
    rc.ss = timed_(rc, 'sheet.open', function () { return SpreadsheetApp.openById(rc.cfg.SPREADSHEET_ID); });
  }
  return rc.ss;
}

// 讀整張表(含標題列)。表不存在回傳 exists:false
function readTable_(rc, name) {
  var sh = openSpreadsheet_(rc).getSheetByName(name);
  if (!sh) return { exists: false, values: [], lastRow: 0 };
  var lastRow = sh.getLastRow();
  if (lastRow < 1) return { exists: true, values: [], lastRow: 0 };
  var values = timed_(rc, 'sheet.read ' + name, function () { return sh.getDataRange().getValues(); });
  return { exists: true, values: values, lastRow: lastRow };
}

var SHEET_HEADERS = {
  Users: ['id', 'kind', 'note', 'enabled', 'added_at'],
  State: ['chat_id', 'kind', 'updated_at', 'last_at', 'meta', 'facts_chunks', 'history_chunks'],
  Archive: ['chat_id', 'ts', 'role', 'text', 'polluted'],
  Events: ['chat_id', 'date', 'time', 'kind', 'text'],
  Images: ['file_id', 'created_at', 'trashed'],
  Logs: ['time', 'level', 'code', 'chat_id', 'detail']
};

// 含使用者內容的表設成純文字:避免 =IMPORTXML(...) 之類被當成公式、日期字串被轉成日期
var TEXT_SHEETS = { Archive: true, Events: true, Logs: true };

function createSheet_(ss, name) {
  var sh = ss.insertSheet(name);
  var h = SHEET_HEADERS[name];
  sh.getRange(1, 1, 1, h.length).setValues([h]);
  if (TEXT_SHEETS[name]) sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
  return sh;
}

function ensureSheet_(rc, name) {
  var ss = openSpreadsheet_(rc);
  return ss.getSheetByName(name) || createSheet_(ss, name);
}

function ensureDimensions_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}
