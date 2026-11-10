// LINE 用戶端:reply(失敗處理與預算內才啟用的 push)。
var LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
var LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

function lineHeaders_(rc) {
  return { Authorization: 'Bearer ' + rc.cfg.LINE_CHANNEL_ACCESS_TOKEN };
}

function lineOk_(res) {
  return !res.thrown && res.code >= 200 && res.code < 300;
}

// 只取 LINE 回應的 message 欄位(結構化錯誤欄位),不含任何使用者內容
function lineErrorDetail_(res) {
  if (res.thrown) return 'EXC';
  var j = res.json();
  var m = j && typeof j.message === 'string' ? ' ' + j.message.slice(0, 100) : '';
  return 'HTTP ' + res.code + m;
}

function lineReply(rc, replyToken, messages) {
  return Http.fetch(rc, LINE_REPLY_URL, {
    method: 'post', contentType: 'application/json', headers: lineHeaders_(rc),
    payload: JSON.stringify({ replyToken: replyToken, messages: messages })
  });
}

var SYSTEM_ROW_ID = '_system';

function monthKey_(rc, nowMs) {
  return Utilities.formatDate(new Date(nowMs), rc.cfg.TIMEZONE, 'yyyy-MM');
}

function pushUsedThisMonth_(rc, sys) {
  var p = sys.meta && sys.meta.push;
  return p && p.m === monthKey_(rc, Clock.now()) ? p.n : 0;
}

// reply 失敗後的補送:只有 PUSH_MONTHLY_BUDGET > 0 且本月未達上限才會 push。用量在寫入階段記入 _system 列。
function tryPush_(rc, ectx, messages) {
  var budget = rc.cfg.PUSH_MONTHLY_BUDGET;
  if (budget <= 0 || !ectx.allowPush) return false;
  var sys = loadChat(rc, SYSTEM_ROW_ID, 'system');
  if (pushUsedThisMonth_(rc, sys) + (rc.pushUsed || 0) >= budget) {
    logOnce(rc, 'push-budget:' + monthKey_(rc, Clock.now()), 3600, 'STATUS', 'PUSH_BUDGET_EXHAUSTED', '', '');
    return false;
  }
  var res = Http.fetch(rc, LINE_PUSH_URL, {
    method: 'post', contentType: 'application/json', headers: lineHeaders_(rc),
    payload: JSON.stringify({ to: ectx.chatId, messages: messages })
  });
  if (!lineOk_(res)) {
    logAdd(rc, 'ERROR', 'LINE_PUSH_FAILED', ectx.chatId, lineErrorDetail_(res));
    return false;
  }
  rc.pushUsed = (rc.pushUsed || 0) + 1;
  return true;
}

// 在寫入階段(持鎖)把本請求用掉的 push 次數記入 _system 列
function applyPushUsage_(rc) {
  if (!rc.pushUsed) return;
  var sys = loadChatLocked(rc, SYSTEM_ROW_ID, 'system');
  sys.meta.push = { m: monthKey_(rc, Clock.now()), n: pushUsedThisMonth_(rc, sys) + rc.pushUsed };
  sys.updatedAt = Clock.now();
  saveChat(rc, sys);
  rc.pushUsed = 0;
}

// 送出 reply;失敗時記錄錯誤日誌,必要時改用 push。回傳是否送達。
function sendReply(rc, ectx, messages) {
  var res = lineReply(rc, ectx.replyToken, messages);
  if (lineOk_(res)) return true;
  logAdd(rc, 'ERROR', 'LINE_REPLY_FAILED', ectx.chatId, lineErrorDetail_(res));
  return tryPush_(rc, ectx, messages);
}

// ---- 圖片先傳後問:待提問圖片只記 {id, ts};文字進來時才現場下載(不存位元組) ----
var LINE_CONTENT_URL_PREFIX = 'https://api-data.line.me/v2/bot/message/';
var IMAGE_MAX_BYTES = 10 * 1024 * 1024;
var IMAGE_DL_CAP_S = 20;
var IMAGE_MIME_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
var IMAGE_ACK_REPLY = '收到,想問什麼?';

function validPending_(rc, list, nowMs) {
  var ttl = rc.cfg.IMAGE_PENDING_TTL_S * 1000;
  return (Array.isArray(list) ? list : []).filter(function (p) { return p && typeof p.id === 'string' && nowMs - p.ts <= ttl; });
}

// 一次 fetchAll 下載全部待提問圖片。回傳 {parts, ids, failed, tooBig}:ids 是這次處理(視為已消耗)的全部圖片
function fetchPendingImages_(rc, ectx, pending) {
  var out = { parts: [], ids: pending.map(function (p) { return p.id; }), failed: 0, tooBig: 0 };
  if (!pending.length) return out;
  var t = Math.floor(Math.min(IMAGE_DL_CAP_S, remainingS_(rc, ectx) - rc.cfg.BUDGET_RESERVE_S));
  if (t < 1) { out.failed = pending.length; return out; }
  var reqs = pending.map(function (p) {
    return { url: LINE_CONTENT_URL_PREFIX + encodeURIComponent(p.id) + '/content', method: 'get', headers: lineHeaders_(rc), timeoutSeconds: t };
  });
  Http.fetchAll(rc, reqs).forEach(function (res) {
    if (!lineOk_(res)) { out.failed++; return; }
    var type = (Http.header(res, 'content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    if (IMAGE_MIME_OK.indexOf(type) < 0) { out.failed++; return; }
    var bytes = Http.bytes(res);
    var size = Math.max(Number(Http.header(res, 'content-length')) || 0, bytes.length);
    if (size > IMAGE_MAX_BYTES) { out.tooBig++; return; }
    out.parts.push({ inlineData: { mimeType: type, data: Utilities.base64Encode(bytes) } });
  });
  return out;
}

function imageNotice_(att) {
  var bits = [];
  if (att.failed) bits.push(att.failed + ' 張圖片無法取得');
  if (att.tooBig) bits.push(att.tooBig + ' 張圖片超過 10MB,已略過');
  return bits.length ? '\n\n(附註:' + bits.join(';') + ',這次沒有參考到。)' : '';
}
