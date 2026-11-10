// 使用者自己的句子是否明令上網查?使用者的話可信,所以明確的命令可以跳過模型第一輪、直接搜尋。
// 只有「客套詞 + 觸發詞 + 可查的內容」才算;詢問(你可以上網查嗎)、否定(不要上網查)、單純提到搜尋、名詞(搜尋引擎)都不算。
var SEARCH_TRIGGERS_ = [
  '上網幫我查一下', '上網幫我查', '上網幫我搜尋一下', '上網幫我搜尋', '上網查一下', '上網搜尋一下', '上網查', '上網搜尋',
  '網路上查', '幫我上網查一下', '幫我上網查', '幫我上網搜尋', '幫我查一下', '幫我查', '幫我搜尋一下', '幫我搜尋',
  '幫忙查一下', '幫忙查', '查一下', '搜尋一下', '搜尋'
];
var SEARCH_HEAD_ = '請麻煩可以你先就快點再好嗯那對,\uff0c ';
var SEARCH_DEEP_RE_ = /(?:仔細|詳細|完整)地?(?=查|搜)/;
var QUERY_TRAILING_ = ' \t吧啦喔哦啊呀嘛~\uff5e!\uff01\u3002.\u2026,\uff0c?\uff1f';
var QUERY_LEADING_ = ' \t:\uff1a,\uff0c';
var MAX_QUERY_CHARS = 100;
var MIN_QUERY_CHARS = 2;

// 來自使用者或模型的查詢字串:去括號、收斂空白、100 字;太短回傳 null
function cleanQuery_(text) {
  if (typeof text !== 'string') return null;
  var q = text.replace(/[\[\]【】]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS).trim();
  return q.length >= MIN_QUERY_CHARS ? q : null;
}

function stripChars_(s, chars, fromStart) {
  var i = 0;
  var j = s.length;
  if (fromStart) { while (i < j && chars.indexOf(s.charAt(i)) >= 0) i++; } else { while (j > i && chars.indexOf(s.charAt(j - 1)) >= 0) j--; }
  return s.slice(i, j);
}

// 回傳 {query, deep} 或 null
function matchSearchRequest(text) {
  if (typeof text !== 'string') return null;
  var t = text.trim();
  var deep = SEARCH_DEEP_RE_.test(t);
  t = t.replace(new RegExp(SEARCH_DEEP_RE_.source, 'g'), '');
  var triggers = SEARCH_TRIGGERS_.concat(deep ? ['查'] : []).sort(function (a, b) { return b.length - a.length; });
  for (var i = 0; i < triggers.length; i++) {
    var trig = triggers[i];
    var at = t.indexOf(trig);
    if (at < 0) continue;
    var head = t.slice(0, at);
    var headOk = true;
    for (var k = 0; k < head.length; k++) if (SEARCH_HEAD_.indexOf(head.charAt(k)) < 0) { headOk = false; break; }
    if (!headOk) continue;
    var rest = t.slice(at + trig.length);
    if (trig === '搜尋' && [' ', ':', '\uff1a'].indexOf(rest.charAt(0)) < 0) continue; // 「搜尋引擎是什麼」不是命令
    var q = cleanQuery_(stripChars_(stripChars_(rest, QUERY_LEADING_, true), QUERY_TRAILING_, false));
    if (q !== null) return { query: q, deep: deep };
  }
  return null;
}
