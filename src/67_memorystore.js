// 長期記憶的儲存:facts 在 State(JSON,區段名 → 文字);Events / Archive 是獨立的表,只在整理時追加。
var MEM_CACHE_PREFIX = 'mem:';
var ARCHIVE_ITEM_CHARS = 300;       // 快取與檢索語料內每筆歸檔訊息的長度(省空間;片段本來就只有幾百字)
var ARCHIVE_CELL_MAX = 20000;       // 寫入歸檔的單格上限(遠低於 50,000)
var MEM_CACHE_TTL_S = 21600;

function parseFacts_(st) {
  if (!st || !st.facts) return {};
  try {
    var o = JSON.parse(st.facts);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}

function factsString_(facts) {
  return Object.keys(facts).length ? JSON.stringify(facts) : '';
}

function memoryEnabledFor_(rc, chat) {
  return rc.cfg.MEMORY_ENABLED && chat && chat.meta && chat.meta.folds > 0;
}

// 日期欄(純文字,但若被人工改成日期格式也能讀)→ YYYY-MM-DD
function dateCell_(rc, v) {
  if (v && typeof v === 'object' && typeof v.getTime === 'function') return Utilities.formatDate(v, rc.cfg.TIMEZONE, 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

function readArchiveTail_(rc, limit) {
  var sh = openSpreadsheet_(rc).getSheetByName('Archive');
  if (!sh || limit < 1) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var start = Math.max(2, last - limit + 1);
  return timed_(rc, 'sheet.read Archive(tail)', function () { return sh.getRange(start, 1, last - start + 1, 5).getValues(); });
}

// → {events:[{date,time,text}], archive:[{ts,role,text,polluted}]}(都只含這個聊天室、舊的在前)。
// 從來沒整理過的聊天室(meta.folds 為 0)必然沒有事件與歸檔,連試算表都不用讀。
function loadMemoryData_(rc, chat) {
  if (!memoryEnabledFor_(rc, chat)) return { events: [], archive: [] };
  var key = MEM_CACHE_PREFIX + chat.chatId;
  var c = Cache.get(rc, key);
  if (c) { try { return JSON.parse(c); } catch (e) { /* 重建 */ } }
  var data = { events: [], archive: [] };
  var ev = readTable_(rc, 'Events');
  for (var i = 1; i < ev.values.length; i++) {
    var r = ev.values[i];
    if (String(r[0]) === chat.chatId) data.events.push({ date: dateCell_(rc, r[1]), time: String(r[2] || ''), text: String(r[4]) });
  }
  readArchiveTail_(rc, rc.cfg.ARCHIVE_SCAN_LIMIT).forEach(function (r) {
    if (String(r[0]) === chat.chatId) {
      data.archive.push({ ts: Number(r[1]), role: String(r[2]), text: String(r[3]).slice(0, ARCHIVE_ITEM_CHARS), polluted: Number(r[4]) === 1 });
    }
  });
  var json = JSON.stringify(data);
  if (utf8Len_(json) > CACHE_FIELD_MAX_BYTES || !Cache.put(rc, key, json, MEM_CACHE_TTL_S)) Cache.remove(rc, key);
  return data;
}

function invalidateMemory_(rc, chatId) {
  Cache.remove(rc, MEM_CACHE_PREFIX + chatId);
}

// 在鎖內把整批列寫在表尾(setValues + 已知列號;不用 appendRow)
function appendRows_(rc, name, rows) {
  if (!rows.length) return;
  var sh = ensureSheet_(rc, name);
  var width = SHEET_HEADERS[name].length;
  var last = Math.max(1, sh.getLastRow());
  ensureDimensions_(sh, last + rows.length, width);
  var range = sh.getRange(last + 1, 1, rows.length, width);
  if (TEXT_SHEETS[name]) range.setNumberFormat('@');
  range.setValues(rows);
}

// 在鎖內:把表中屬於某聊天室的列物理刪除(整張表讀出、過濾、覆寫,再刪掉多出來的尾端列)。回傳刪除列數。
function removeChatRows_(rc, name, chatId) {
  var t = readTable_(rc, name);
  if (!t.exists || t.values.length < 2) return 0;
  var kept = [];
  for (var i = 1; i < t.values.length; i++) if (String(t.values[i][0]) !== chatId) kept.push(t.values[i]);
  var removed = t.values.length - 1 - kept.length;
  if (!removed) return 0;
  var sh = openSpreadsheet_(rc).getSheetByName(name);
  if (kept.length) {
    var range = sh.getRange(2, 1, kept.length, t.values[0].length);
    if (TEXT_SHEETS[name]) range.setNumberFormat('@');
    range.setValues(kept);
  }
  sh.deleteRows(2 + kept.length, removed);
  return removed;
}
