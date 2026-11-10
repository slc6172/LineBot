// 入口與請求生命週期。
var EVENT_LOOP_LIMIT_S = 270;

function doGet(e) {
  return ContentService.createTextOutput('Webhook Verified');
}

function createRequestContext() {
  var loaded = loadConfig(PropertiesService.getScriptProperties().getProperties());
  var cfg = loaded.cfg;
  var secrets = [];
  CONFIG_SECRET_KEYS.forEach(function (k) { if (cfg[k]) secrets.push(cfg[k]); });
  return {
    cfg: cfg, configIssues: loaded.issues, secrets: secrets, logs: [], t0: Clock.now(),
    ss: null, stateTable: null
  };
}

function doPost(e) {
  var rc = createRequestContext();
  try {
    processRequest_(rc, e);
  } catch (err) {
    try { logAdd(rc, 'ERROR', 'UNHANDLED', '', err && err.name ? err.name : 'Error'); } catch (x) { /* 忽略 */ }
  }
  finalizeLogs_(rc);
  return ContentService.createTextOutput('');
}

// 還沒寫出的日誌(例如沒有寫入階段的請求)在請求結束時一次寫出
function finalizeLogs_(rc) {
  if (!rc.logs.length && !rc.pushUsed && !imageEffectsPending_(rc)) return;
  try { writePhase(rc, function () { applyPushUsage_(rc); applyImageEffects_(rc); }); } catch (e) { /* 忽略 */ }
}

function processRequest_(rc, e) {
  var given = e && e.parameter ? e.parameter.k : '';
  if (!rc.cfg.WEBHOOK_KEY || given !== rc.cfg.WEBHOOK_KEY) {
    logOnce(rc, 'badkey', 600, 'STATUS', 'BAD_KEY', '', '');
    return;
  }
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (x) {
    logOnce(rc, 'badbody', 600, 'STATUS', 'BAD_BODY', '', '');
    return;
  }
  reportConfig_(rc);
  var events = body && Array.isArray(body.events) ? body.events : [];
  for (var i = 0; i < events.length; i++) {
    if ((Clock.now() - rc.t0) / 1000 >= EVENT_LOOP_LIMIT_S) {
      logAdd(rc, 'STATUS', 'EVENT_LOOP_TIMEOUT', '', 'skipped ' + (events.length - i));
      break;
    }
    handleEvent_(rc, events[i]);
  }
}

// 設定問題:每小時最多記一次(避免每個請求都寫日誌)
function reportConfig_(rc) {
  var cfg = rc.cfg;
  var missing = ['GEMINI_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'TINYFISH_API_KEY'];
  if (cfg.IMAGE_ENABLED) missing.push('CF_API_TOKEN', 'CF_ACCOUNT_ID', 'IMAGE_DRIVE_FOLDER_ID');
  missing.forEach(function (k) {
    if (!cfg[k]) logOnce(rc, 'cfg-missing:' + k, 3600, 'STATUS', 'KEY_MISSING', '', k);
  });
  rc.configIssues.forEach(function (k) {
    logOnce(rc, 'cfg-range:' + k, 3600, 'STATUS', 'CONFIG_RANGE', '', k);
  });
}

function isDuplicateEvent_(rc, ev) {
  var id = ev.webhookEventId;
  if (!id) return false;
  var key = 'ev:' + id;
  if (Cache.get(rc, key)) return true;
  Cache.put(rc, key, '1', 600);
  return false;
}

var NOT_CONFIGURED_REPLY = '機器人還沒設定完成,請聯絡管理員。';

// LINE 來源 → 聊天室。group 與 room 在本系統視為同一類「群組型聊天室」(kind: 'group')。
function chatOfSource_(src) {
  if (src.type === 'user' && src.userId) return { id: src.userId, kind: 'user' };
  if (src.type === 'group' && src.groupId) return { id: src.groupId, kind: 'group' };
  if (src.type === 'room' && src.roomId) return { id: src.roomId, kind: 'group' };
  return null;
}

function isRegistered_(users, chat) {
  var k = users[chat.id];
  return chat.kind === 'user' ? k === 'user' : k === 'group' || k === 'room';
}

function handleEvent_(rc, ev) {
  if (!ev || ev.type !== 'message' || !ev.message) return;
  var chat = chatOfSource_(ev.source || {});
  if (!chat) return;
  var mtype = ev.message.type;
  if (mtype === 'text' ? typeof ev.message.text !== 'string' : (mtype !== 'image' || typeof ev.message.id !== 'string')) return;
  // 群組內沒 @ 的文字:完全忽略(不去重、不查白名單、不寫任何東西)
  if (chat.kind === 'group' && mtype === 'text' && !isSelfMentioned_(ev.message)) return;
  if (isDuplicateEvent_(rc, ev)) return;

  var ectx = { t0: Clock.now(), chatId: chat.id, replyToken: ev.replyToken, kind: chat.kind, allowPush: false, senderId: (ev.source && ev.source.userId) || '' };
  var users = loadUsers(rc);
  if (!isRegistered_(users, chat)) {
    if (chat.kind === 'group' && mtype === 'image') return; // 未登記群組傳圖:完全忽略
    logOnce(rc, 'stranger:' + chat.id, 3600, 'STATUS', 'STRANGER', chat.id, '');
    sendReply(rc, ectx, buildReplyMessages(chat.kind === 'user'
      ? '尚未開通。你的 ID 是 ' + chat.id
      : '此群組尚未開通,群組 ID 是 ' + chat.id));
    return;
  }
  if (mtype === 'image') { handleImage_(rc, ectx, ev.message.id); return; }
  var text = chat.kind === 'group' ? stripSelfMentions_(ev.message.text, ev.message) : ev.message.text;
  if (chat.kind === 'group' && !text) return; // 只有 @ 沒有內容
  var cmd = commandOf_(text);
  if (cmd) { handleCommand_(rc, ectx, cmd, users); return; }
  ectx.allowPush = true;
  handleChatText_(rc, ectx, text);
}

// 一對一傳圖:回「收到,想問什麼?」(不呼叫 AI),只把圖片 ID 與時間記進 State(最多 IMAGE_PENDING_MAX 個,丟最舊的)
function handleImage_(rc, ectx, messageId) {
  if (ectx.kind === 'user') sendReply(rc, ectx, buildReplyMessages(IMAGE_ACK_REPLY)); // 群組傳圖不回覆(避免洗版)
  writePhase(rc, function () {
    var st = loadChatLocked(rc, ectx.chatId, ectx.kind);
    var pending = validPending_(rc, st.meta.pending, Clock.now()).concat([{ id: messageId, ts: ectx.t0 }]);
    st.meta.pending = pending.slice(-rc.cfg.IMAGE_PENDING_MAX);
    st.updatedAt = Clock.now();
    saveChat(rc, st);
    applyPushUsage_(rc);
  });
}

function handleChatText_(rc, ectx, userText) {
  if (!rc.cfg.GEMINI_API_KEY) {
    sendReply(rc, ectx, buildReplyMessages(NOT_CONFIGURED_REPLY));
    return;
  }
  var chat = loadChat(rc, ectx.chatId, ectx.kind);
  var att = fetchPendingImages_(rc, ectx, validPending_(rc, chat.meta.pending, ectx.t0));
  var r = runChatTurn(rc, ectx, chat, userText, att);
  var replyText = r.ok ? markdownToPlain(r.text) : ERROR_REPLIES[r.kind];
  var notices = r.ok ? imageNotice_(att) + r.tw.imageNotices.map(function (n) { return '\n\n(附註:' + n + '。)'; }).join('') : '';
  sendReply(rc, ectx, buildReplyMessages(replyText + notices, r.ok ? r.tw.images : []));
  if (!r.ok) return; // 失敗的回合不消耗待提問圖片,使用者重問仍會帶圖

  var userEntry = { r: 'u', t: (att.parts.length ? '[圖片] ' : '') + userText, ts: ectx.t0 };
  var modelEntry = { r: 'm', t: replyText, ts: Clock.now() };
  if (r.tw.polluted) { modelEntry.p = 1; modelEntry.q = r.tw.queries; } // 汙染回合:用到網頁內容
  // 整理(若需要):在 reply 之後、取鎖之前做模型呼叫;結果與本回合在同一個寫入階段寫入
  var plan = planFold_(rc, ectx, chat, [userEntry, modelEntry]);
  try {
    var foldResult = plan ? requestFold_(rc, ectx, chat, plan) : null;
    writePhase(rc, function () {
      var st = loadChatLocked(rc, ectx.chatId, ectx.kind);
      modelEntry.ts = Clock.now();
      st.history.push(userEntry, modelEntry);
      if (plan && foldResult) applyFold_(rc, ectx, st, plan, foldResult);
      enforceHistoryLimit_(rc, st);
      // 只清掉已消耗與已過期的待提問圖片(回答期間才到的新圖要保留)
      var left = validPending_(rc, st.meta.pending, Clock.now()).filter(function (p) { return att.ids.indexOf(p.id) < 0; });
      if (left.length) st.meta.pending = left; else delete st.meta.pending;
      st.lastAt = Clock.now();
      st.updatedAt = st.lastAt;
      saveChat(rc, st);
      applyPushUsage_(rc);
      applyImageEffects_(rc);
    });
  } finally {
    if (plan) Cache.remove(rc, 'fold:' + ectx.chatId);
  }
}
