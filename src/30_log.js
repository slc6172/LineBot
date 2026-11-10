// 日誌:記憶體內收集,請求結束時批次寫入 Logs 表。只記錯誤與狀態,不含使用者內容、模型回覆與金鑰。
var LOG_LEVEL_LABEL = { ERROR: '錯誤', STATUS: '狀態', DEBUG: '除錯' };
var LOG_ROTATE_BUFFER = 100;

function scrubSecrets_(rc, s) {
  s = String(s === undefined || s === null ? '' : s);
  (rc.secrets || []).forEach(function (v) {
    if (v && v.length >= 4) s = s.split(v).join('***');
  });
  return s.length > 200 ? s.slice(0, 200) : s;
}

function logAdd(rc, level, code, chatId, detail) {
  rc.logs.push({
    ts: Clock.now(), level: LOG_LEVEL_LABEL[level] || level, code: code,
    chatId: chatId || '', detail: scrubSecrets_(rc, detail)
  });
}

// 限頻日誌:同一個 key 在 ttlS 秒內只記一次
function logOnce(rc, key, ttlS, level, code, chatId, detail) {
  if (Cache.get(rc, 'lg:' + key)) return false;
  Cache.put(rc, 'lg:' + key, '1', ttlS);
  logAdd(rc, level, code, chatId, detail);
  return true;
}

// 批次寫入(呼叫端負責持鎖)。沒有日誌時完全不碰試算表。
function flushLogs_(rc) {
  if (!rc.logs.length) return;
  var pending = rc.logs;
  rc.logs = [];
  var sh = ensureSheet_(rc, 'Logs');
  var last = Math.max(1, sh.getLastRow());
  var rows = pending.map(function (l) {
    return [new Date(l.ts).toISOString(), l.level, l.code, l.chatId, l.detail];
  });
  var max = rc.cfg.LOG_MAX_ROWS;
  var total = (last - 1) + rows.length;
  if (total > max + LOG_ROTATE_BUFFER) {
    var del = Math.min(total - max, last - 1);
    if (del > 0) { sh.deleteRows(2, del); last -= del; }
  }
  ensureDimensions_(sh, last + rows.length, 5);
  // 日誌欄位含外部來源的文字(例如搜尋結果網域):寫入範圍一律設為純文字,避免被當成公式(舊部署的 Logs 表也適用)
  var range = sh.getRange(last + 1, 1, rows.length, 5);
  range.setNumberFormat('@');
  range.setValues(rows);
}
