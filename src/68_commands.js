// 指令:由程式直接處理,不呼叫模型,不寫進歷史。須文字完全符合(容許前後空白)。
function commandOf_(text) {
  var t = String(text).trim();
  if (t === '/記憶') return 'memory';
  if (t === '/忘記' || t === '/忘記 確認') return 'forget';
  return null;
}

function memorySummaryText_(rc, chat) {
  var facts = parseFacts_(chat);
  var parts = FACT_SECTIONS.filter(function (sec) { return String(facts[sec] || '').trim(); })
    .map(function (sec) { return '〔' + sec + '〕\n' + facts[sec]; });
  var count = loadMemoryData_(rc, chat).events.length;
  return (parts.length ? '目前的長期記憶:\n' + parts.join('\n') : '目前還沒有長期記憶。') + '\n\n日誌事件:' + count + ' 筆';
}

// 在鎖內清空一個聊天室:State 列、Events 與 Archive 中屬於它的列、相關快取
function forgetChat_(rc, chatId, kind) {
  var st = loadChatLocked(rc, chatId, kind);
  if (st.row) {
    var sh = ensureSheet_(rc, 'State');
    var width = Math.max(sh.getLastColumn(), STATE_FIXED_COLS);
    var blank = [];
    for (var i = 0; i < width; i++) blank.push('');
    sh.getRange(st.row, 1, 1, width).setValues([blank]);
  }
  Cache.remove(rc, 'st:' + chatId);
  invalidateMemory_(rc, chatId);
  rc.stateTable = null;
  removeChatRows_(rc, 'Events', chatId);
  removeChatRows_(rc, 'Archive', chatId);
}

function handleCommand_(rc, ectx, cmd, users) {
  var reply = function (text) { sendReply(rc, ectx, buildReplyMessages(text)); };
  if (cmd === 'memory') {
    reply(memorySummaryText_(rc, loadChat(rc, ectx.chatId, ectx.kind)));
    return;
  }
  // 群組內的 /忘記 需要發送者本人在 Users 內(個人聊天室的發送者就是聊天室本身,已在白名單)
  var sender = ectx.kind === 'group' ? ectx.senderId : ectx.chatId;
  if (!sender || users[sender] !== 'user') {
    reply('只有已登記的使用者才能在群組使用 /忘記。');
    return;
  }
  var ttl = rc.cfg.FORGET_CONFIRM_TTL_S;
  var key = 'forget:' + ectx.chatId + ':' + sender;
  if (!Cache.get(rc, key)) {
    Cache.put(rc, key, '1', ttl);
    reply('這會清空全部記憶與對話歷史,請在 ' + ttl + ' 秒內再輸入一次 /忘記 確認');
    return;
  }
  Cache.remove(rc, key);
  var done = writePhase(rc, function () { forgetChat_(rc, ectx.chatId, ectx.kind); });
  reply(done ? '已清空這個聊天室的記憶與對話歷史。' : '現在系統忙碌,沒能清空,請稍後再試一次。');
}
