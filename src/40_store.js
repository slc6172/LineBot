// 聊天室狀態:試算表(真相)+ 快取(加速)+ 全域鎖。
// State 一個聊天室一列:[chat_id, kind, updated_at, last_at, meta, facts_chunks, history_chunks, ...事實分塊, ...歷史分塊]
// 單格上限 50,000 字元 → 欄位序列化後以 CHUNK_MAX 切塊;每塊加上前綴避免試算表把內容誤判為數字或公式。
var STATE_FIXED_COLS = 7;
var CHUNK_MAX = 40000;
var CHUNK_PREFIX = '~';
var CACHE_FIELD_MAX_BYTES = 90 * 1024;
var STATE_CACHE_TTL_S = 21600;
var LOCK_WAIT_MS = 30000;

function chunkString_(s) {
  var out = [];
  for (var i = 0; i < s.length; i += CHUNK_MAX) out.push(CHUNK_PREFIX + s.slice(i, i + CHUNK_MAX));
  return out;
}

function unchunk_(cells) {
  return cells.map(function (c) { return String(c).slice(CHUNK_PREFIX.length); }).join('');
}

function newChatState_(chatId, kind) {
  return { chatId: chatId, kind: kind, row: 0, updatedAt: 0, lastAt: 0, meta: {}, facts: '', history: [], isNew: true };
}

function encodeStateRow_(st) {
  var f = st.facts ? chunkString_(st.facts) : [];
  var h = chunkString_(JSON.stringify(st.history || []));
  return [st.chatId, st.kind, st.updatedAt, st.lastAt, JSON.stringify(st.meta || {}), f.length, h.length].concat(f, h);
}

function decodeStateRow_(rc, row) {
  var nf = Number(row[5]) || 0;
  var nh = Number(row[6]) || 0;
  var st = newChatState_(String(row[0]), String(row[1]));
  st.isNew = false;
  st.updatedAt = Number(row[2]) || 0;
  st.lastAt = Number(row[3]) || 0;
  try { st.meta = JSON.parse(row[4] || '{}') || {}; } catch (e) { st.meta = {}; logAdd(rc, 'ERROR', 'STATE_CORRUPT', st.chatId, 'meta'); }
  st.facts = unchunk_(row.slice(STATE_FIXED_COLS, STATE_FIXED_COLS + nf));
  try { st.history = JSON.parse(unchunk_(row.slice(STATE_FIXED_COLS + nf, STATE_FIXED_COLS + nf + nh)) || '[]') || []; } catch (e2) {
    st.history = []; logAdd(rc, 'ERROR', 'STATE_CORRUPT', st.chatId, 'history');
  }
  return st;
}

function cachePutState_(rc, st) {
  var key = 'st:' + st.chatId;
  var json = JSON.stringify(st);
  if (utf8Len_(json) > CACHE_FIELD_MAX_BYTES) { Cache.remove(rc, key); return; }
  if (!Cache.put(rc, key, json, STATE_CACHE_TTL_S)) Cache.remove(rc, key);
}

function readStateTable_(rc) {
  if (!rc.stateTable) {
    var t = readTable_(rc, 'State');
    rc.stateTable = { values: t.values, lastRow: Math.max(1, t.lastRow) };
  }
  return rc.stateTable;
}

// 先看快取,沒有才讀試算表
function loadChat(rc, chatId, kind) {
  var c = Cache.get(rc, 'st:' + chatId);
  if (c) {
    try {
      var cached = JSON.parse(c);
      if (cached && cached.chatId === chatId) return cached;
    } catch (e) { /* 當作沒命中 */ }
  }
  var t = readStateTable_(rc);
  for (var i = 1; i < t.values.length; i++) {
    if (String(t.values[i][0]) === chatId) {
      var st = decodeStateRow_(rc, t.values[i]);
      st.row = i + 1;
      cachePutState_(rc, st);
      return st;
    }
  }
  return newChatState_(chatId, kind);
}

// 鎖內讀取最新狀態:先看快取;沒命中時不能沿用請求開頭讀到的表格快照(期間別的請求可能已寫入)。
// 只有「開頭讀表時這個聊天室就不存在,且表的最後一列沒變」才能確定仍是新聊天室而省下一次讀取。
function loadChatLocked(rc, chatId, kind) {
  var c = Cache.get(rc, 'st:' + chatId);
  if (c) {
    try {
      var cached = JSON.parse(c);
      if (cached && cached.chatId === chatId) return cached;
    } catch (e) { /* 當作沒命中 */ }
  }
  var t = rc.stateTable;
  if (t) {
    var inSnapshot = false;
    for (var i = 1; i < t.values.length; i++) if (String(t.values[i][0]) === chatId) { inSnapshot = true; break; }
    if (!inSnapshot) {
      var sh = openSpreadsheet_(rc).getSheetByName('State');
      var cur = sh ? sh.getLastRow() : 0;
      if (cur === t.lastRow || (!sh && t.lastRow === 1)) return newChatState_(chatId, kind);
    }
  }
  rc.stateTable = null; // 作廢快照,重新讀取最新內容
  return loadChat(rc, chatId, kind);
}

// 在鎖內配置新列:持鎖期間沒有別人能新增列,且 loadChatLocked 已確認這個聊天室不存在,所以 lastRow+1 一定安全
function allocateStateRow_(sh) {
  return sh.getLastRow() + 1;
}

// 在鎖內寫入一個聊天室的狀態
function saveChat(rc, st) {
  var sh = ensureSheet_(rc, 'State');
  var row = encodeStateRow_(st);
  var width = Math.max(row.length, sh.getLastColumn());
  while (row.length < width) row.push('');
  if (!st.row) st.row = allocateStateRow_(sh);
  ensureDimensions_(sh, st.row, width);
  timed_(rc, 'sheet.write State', function () { sh.getRange(st.row, 1, 1, width).setValues([row]); });
  if (rc.stateTable && st.row > rc.stateTable.lastRow) rc.stateTable.lastRow = st.row;
  st.isNew = false;
  cachePutState_(rc, st);
}

// 寫入階段:取鎖 → fn(內含重新讀取最新狀態與 saveChat)→ 一次批次寫日誌 → 放鎖。
// 取不到鎖:記錄錯誤、放棄寫入狀態,日誌以不持鎖的方式盡力寫出。
function writePhase(rc, fn) {
  var lock = Lock.acquire(rc, LOCK_WAIT_MS);
  if (!lock) {
    logAdd(rc, 'ERROR', 'LOCK_TIMEOUT', '', '');
    try { flushLogs_(rc); } catch (e) { /* 日誌失敗不影響回覆 */ }
    return false;
  }
  try {
    try { fn(); } catch (e2) { logAdd(rc, 'ERROR', 'COMMIT_FAILED', '', e2 && e2.name ? e2.name : 'Error'); }
    try { flushLogs_(rc); } catch (e3) { /* 忽略 */ }
  } finally {
    lock.release();
  }
  return true;
}

function trimHistory_(history, maxTurns) {
  var maxEntries = maxTurns * 2;
  while (history.length > maxEntries) history.shift();
  while (history.length && history[0].r !== 'u') history.shift();
  return history;
}
