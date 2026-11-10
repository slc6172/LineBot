// 群組:只依 LINE 文字訊息的「提及資訊」判斷自己是否被 @(不看文字裡有沒有寫 @Bot)。
function selfMentionees_(msg) {
  var list = msg && msg.mention && Array.isArray(msg.mention.mentionees) ? msg.mention.mentionees : [];
  return list.filter(function (m) { return m && m.isSelf === true; });
}

function isSelfMentioned_(msg) {
  return selfMentionees_(msg).length > 0;
}

// 移除文字中對機器人的 @ 字樣。索引依 LINE 提供的 index/length(UTF-16);若該段不是以 @ 開頭,改以碼位計算再試一次,
// 兩種都對不上就不動(寧可留著 @ 字樣也不亂刪別的字)。
function stripSelfMentions_(text, msg) {
  var out = String(text);
  var ms = selfMentionees_(msg).filter(function (m) { return typeof m.index === 'number' && typeof m.length === 'number'; })
    .sort(function (a, b) { return b.index - a.index; });
  ms.forEach(function (m) {
    if (out.slice(m.index, m.index + m.length).charAt(0) === '@') {
      out = out.slice(0, m.index) + out.slice(m.index + m.length);
      return;
    }
    var cps = Array.from(out);
    if (cps.slice(m.index, m.index + m.length).join('').charAt(0) === '@') {
      out = cps.slice(0, m.index).concat(cps.slice(m.index + m.length)).join('');
    }
  });
  return out.replace(/[ \t\u3000]+/g, ' ').trim();
}
