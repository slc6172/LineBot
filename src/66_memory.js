// 長期記憶的純函式:檢索(bigram)、整理結果驗證、常駐區塊。沒有儲存、沒有時鐘。
var FACT_SECTIONS = ['使用者', '共同經歷', '待跟進', '更早的摘要'];
var FOLD_SECTION_KEYS = { user: '使用者', shared: '共同經歷', followups: '待跟進' };
var FUNCTION_CHARS_ = '的了在是我你他她它們這那有不也都就和與及嗎吧呢啊喔哦呀嘛跟說';
var MAX_EVENTS = 10;
var MAX_EVENT_CHARS = 80;

// ---- 檢索:相鄰兩字(bigram),濾掉含常用虛字的字組。純本機、不呼叫模型 ----
function bigrams_(text) {
  var seen = {};
  var out = [];
  var segs = String(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  segs.forEach(function (seg) {
    var chars = Array.from(seg);
    for (var i = 0; i + 1 < chars.length; i++) {
      var a = chars[i];
      var b = chars[i + 1];
      if (FUNCTION_CHARS_.indexOf(a) >= 0 || FUNCTION_CHARS_.indexOf(b) >= 0) continue;
      var g = a + b;
      if (!seen[g]) { seen[g] = true; out.push(g); }
    }
  });
  return out;
}

function snippetOf_(original, lowered, gram, limit) {
  if (original.length <= limit) return original;
  var start = Math.max(0, lowered.indexOf(gram) - Math.floor(limit / 4));
  var cut = original.slice(start, start + limit - 2);
  return (start ? '…' : '') + cut + (start + limit - 2 < original.length ? '…' : '');
}

// docs: [{text, date, label}](舊的在前)。每個字組權重 ln(1+N/df)/ln(1+N)(只在單一文件出現者恰為 1);
// 文件總分達 minScore 才算命中;分數高者優先,同分較新者優先。回傳 [{date, label, snippet}]
function retrieveDocs_(query, docs, k, snippetChars, minScore) {
  var qg = bigrams_(query);
  if (!qg.length || !docs.length) return [];
  var lowered = docs.map(function (d) { return d.text.toLowerCase(); });
  var matched = lowered.map(function (t) { return qg.filter(function (g) { return t.indexOf(g) >= 0; }); });
  var freq = {};
  matched.forEach(function (found) { found.forEach(function (g) { freq[g] = (freq[g] || 0) + 1; }); });
  var total = Math.log(1 + docs.length);
  var scored = [];
  docs.forEach(function (doc, order) {
    var found = matched[order];
    if (!found.length) return;
    var score = 0;
    found.forEach(function (g) { score += Math.log(1 + docs.length / freq[g]) / total; });
    if (score >= minScore - 1e-9) scored.push({ score: score, order: order, doc: doc, text: lowered[order], first: found[0] });
  });
  scored.sort(function (a, b) { return b.score - a.score || b.order - a.order; });
  return scored.slice(0, k).map(function (s) {
    return { date: s.doc.date, label: s.doc.label, snippet: snippetOf_(s.doc.text, s.text, s.first, snippetChars) };
  });
}

function retrievalBlock_(hits) {
  if (!hits.length) return '';
  var lines = hits.map(function (h) { return '- ' + (h.date ? h.date + ' ' : '') + h.label + ':' + h.snippet; });
  return '\n\n【可能相關的記憶】(從更早的對話與日誌找出的片段,不一定完全準確,請自然運用)\n' + lines.join('\n');
}

// ---- 整理(fold)結果驗證:API 只保證形狀,不保證內容 ----
function validDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s.trim() : '');
  if (!m) return false;
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// → {events:[{date,text}], facts:{區段名:文字}} 或 null(整份無效)
function normalizeFold_(data, fallbackDate) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!Array.isArray(data.events) || !data.facts || typeof data.facts !== 'object' || Array.isArray(data.facts)) return null;
  var raw = data.facts;
  for (var key in FOLD_SECTION_KEYS) if (!Array.isArray(raw[key])) return null;
  var events = [];
  data.events.forEach(function (item) {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) return;
    events.push({ date: validDate_(item.date) ? item.date.trim() : fallbackDate, text: item.text.trim().slice(0, MAX_EVENT_CHARS) });
  });
  var facts = {};
  for (var k in FOLD_SECTION_KEYS) {
    var lines = raw[k].filter(function (f) { return typeof f === 'string' && f.trim(); }).map(function (f) { return f.trim(); });
    if (lines.length) facts[FOLD_SECTION_KEYS[k]] = lines.map(function (l) { return '- ' + l; }).join('\n');
  }
  if (typeof raw.earlier_summary === 'string' && raw.earlier_summary.trim()) facts['更早的摘要'] = raw.earlier_summary.trim();
  return { events: events.slice(0, MAX_EVENTS), facts: facts };
}

// ---- 常駐區塊 ----
function factLines_(facts, section) {
  return String(facts[section] || '').split('\n').filter(function (l) { return l.trim(); });
}

// → [[區段, [放得下的行]]](依固定順序;標題不計字數;超過上限保留前面的區段與每區段前面的行)
function fitFacts_(facts, maxChars) {
  var fitted = [];
  var used = 0;
  for (var i = 0; i < FACT_SECTIONS.length; i++) {
    var kept = [];
    var lines = factLines_(facts, FACT_SECTIONS[i]);
    for (var j = 0; j < lines.length; j++) {
      if (used + lines[j].length + 1 > maxChars) break;
      kept.push(lines[j]);
      used += lines[j].length + 1;
    }
    if (kept.length) fitted.push([FACT_SECTIONS[i], kept]);
  }
  return fitted;
}

function longTermBlock_(facts, maxChars) {
  var lines = [];
  fitFacts_(facts, maxChars).forEach(function (f) { lines.push('〔' + f[0] + '〕'); f[1].forEach(function (l) { lines.push(l); }); });
  return lines.length ? '\n\n【長期記憶(自然運用,不要逐條複述)】\n' + lines.join('\n') : '';
}

// 沒放進常駐區塊的事實行(值得被檢索);依位置判斷,內容重複的行不會被誤判
function leftOutFactLines_(facts, maxChars) {
  var shownCount = {};
  fitFacts_(facts, maxChars).forEach(function (f) { shownCount[f[0]] = f[1].length; });
  var out = [];
  FACT_SECTIONS.forEach(function (sec) {
    factLines_(facts, sec).slice(shownCount[sec] || 0).forEach(function (l) { out.push(l); });
  });
  return out;
}

function latestThatFit_(events, maxChars) {
  var kept = [];
  var used = 0;
  for (var i = events.length - 1; i >= 0; i--) {
    var line = '- ' + (events[i].time ? events[i].time + ' ' : '') + events[i].text;
    if (used + line.length + 1 > maxChars) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept;
}

// 昨天與今天的日誌,各自限制字數,超過時保留最新的行
function journalBlock_(yesterday, today, yEvents, tEvents, maxChars) {
  var parts = [];
  [['昨天', yesterday, yEvents], ['今天', today, tEvents]].forEach(function (p) {
    var lines = latestThatFit_(p[2], maxChars);
    if (lines.length) parts.push(p[0] + ' ' + p[1] + ':\n' + lines.join('\n'));
  });
  return parts.length ? '\n\n【最近的日誌】\n' + parts.join('\n') : '';
}
