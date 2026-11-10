// 記憶區塊(接在 system prompt 後面):常駐的長期事實與今天/昨天日誌,加上依使用者訊息檢索出的舊片段。
var ROLE_LABEL_ = { u: '更早的對話·使用者', m: '更早的對話·我' };

function dateKey_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : 0;
}

// 候選語料(舊的在前,同分時較新者優先):沒放進常駐區塊的事實行、不在今天/昨天的日誌事件、
// 歸檔訊息(最近 ARCHIVE_SCAN_LIMIT 筆)、State 內早於原文窗口但尚未整理的訊息。汙染回合的回覆不進語料。
function recall_(rc, chat, facts, data, userText, today, yesterday) {
  if (rc.cfg.RETRIEVAL_K < 1 || Array.from(userText).length < rc.cfg.RETRIEVAL_MIN_MESSAGE_CHARS) return [];
  var docs = [];
  leftOutFactLines_(facts, rc.cfg.LONG_TERM_MAX_CHARS).forEach(function (l) {
    docs.push({ text: l, date: '', label: '長期記憶', key: 0 });
  });
  data.events.forEach(function (e) {
    if (e.date !== today && e.date !== yesterday) docs.push({ text: e.text, date: e.date, label: '日誌', key: dateKey_(e.date) });
  });
  data.archive.forEach(function (a) {
    if (!a.polluted) docs.push({ text: a.text, date: a.ts ? dateOfMs_(rc, a.ts) : '', label: ROLE_LABEL_[a.role] || '更早的對話', key: a.ts || 0 });
  });
  var inWindow = windowHistory_(chat.history, rc.cfg.HISTORY_MAX_TURNS).length;
  chat.history.slice(0, chat.history.length - inWindow).forEach(function (e) {
    if (e.r === 'm' && e.p) return;
    docs.push({ text: e.t, date: e.ts ? dateOfMs_(rc, e.ts) : '', label: ROLE_LABEL_[e.r] || '更早的對話', key: e.ts || 0 });
  });
  docs.sort(function (a, b) { return a.key - b.key; });
  return retrieveDocs_(userText, docs, rc.cfg.RETRIEVAL_K, rc.cfg.RETRIEVAL_SNIPPET_CHARS, rc.cfg.RETRIEVAL_MIN_SCORE);
}

function memoryBlocks_(rc, chat, userText, nowMs) {
  if (!rc.cfg.MEMORY_ENABLED) return '';
  var facts = parseFacts_(chat);
  var data = loadMemoryData_(rc, chat);
  var today = dateOfMs_(rc, nowMs);
  var yesterday = dateOfMs_(rc, nowMs - DAY_MS);
  var on = function (d) { return data.events.filter(function (e) { return e.date === d; }); };
  return longTermBlock_(facts, rc.cfg.LONG_TERM_MAX_CHARS) +
    journalBlock_(yesterday, today, on(yesterday), on(today), rc.cfg.RECENT_NOTES_MAX_CHARS) +
    retrievalBlock_(recall_(rc, chat, facts, data, userText, today, yesterday));
}
