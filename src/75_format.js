// 回覆格式化:Markdown 轉純文字、依 LINE 限制分段、組合 reply 訊息。
var LINE_TEXT_MAX = 5000;
var LINE_REPLY_MAX_MESSAGES = 5;
var TRUNCATED_MARK = '…(內容過長)';
var EMPTY_REPLY_TEXT = '(沒有內容)';

function markdownToPlain(text) {
  var s = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
  var saved = [];
  function stash(str) { saved.push(str); return '\u0000' + (saved.length - 1) + '\u0000'; }

  // 程式碼先收起來,避免其中的符號被當成 Markdown
  s = s.replace(/```[^\n]*\n([\s\S]*?)(?:\n```|```|$)/g, function (m, code) { return stash(code.replace(/\n$/, '')); });
  s = s.replace(/`([^`\n]+)`/g, function (m, code) { return stash(code); });

  var HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  var TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  s = s.split('\n').map(function (line) {
    if (HR.test(line)) return '';
    var t = line.trim();
    if (t.charAt(0) === '|' && t.indexOf('|', 1) > 0) {
      if (TABLE_SEP.test(t)) return null;
      return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }).join(' | ');
    }
    var h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) return h[1];
    var q = /^\s{0,3}(?:>\s?)+(.*)$/.exec(line);
    if (q) return q[1];
    var b = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (b) return b[1] + '・' + b[2];
    return line;
  }).filter(function (l) { return l !== null; }).join('\n');

  s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, label, url) {
    return !label || label === url ? url : label + '(' + url + ')';
  });
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '$1');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, '$1$2');
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '$1');
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?!\w)/g, '$1$2');

  s = s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return saved[Number(i)]; });
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// 在 window 內找最後一個自然邊界(段落 > 換行 > 句尾 > 空白),太靠前(<30%)的不採用;找不到就硬切
function findCut_(rest, max) {
  var win = rest.slice(0, max);
  var minPos = Math.floor(max * 0.3);
  var i = win.lastIndexOf('\n\n');
  if (i >= minPos) return i + 2;
  i = win.lastIndexOf('\n');
  if (i >= minPos) return i + 1;
  var best = -1;
  var re = /[。！？!?；;]/g;
  var m;
  while ((m = re.exec(win)) !== null) best = m.index;
  if (best >= minPos) return best + 1;
  i = win.lastIndexOf(' ');
  if (i >= minPos) return i + 1;
  return max;
}

// 回傳 {parts, truncated}:每段不超過 max 字;超過 limit 段就截斷並在最後標示
function splitText_(text, max, limit) {
  var parts = [];
  var rest = String(text);
  while (rest.length > max) {
    var cut = findCut_(rest, max);
    parts.push(rest.slice(0, cut).replace(/\s+$/, ''));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  parts.push(rest);
  var truncated = false;
  if (parts.length > limit) {
    truncated = true;
    parts = parts.slice(0, limit);
    var last = parts[limit - 1];
    if (last.length + TRUNCATED_MARK.length > max) last = last.slice(0, max - TRUNCATED_MARK.length);
    parts[limit - 1] = last + TRUNCATED_MARK;
  }
  return { parts: parts, truncated: truncated };
}

// 文字訊息在前、圖片訊息在後;一次 reply 最多 5 則(圖片佔掉的名額不給文字)
function buildReplyMessages(text, images) {
  images = images || [];
  var body = String(text === undefined || text === null ? '' : text).trim() || EMPTY_REPLY_TEXT;
  var limit = Math.max(1, LINE_REPLY_MAX_MESSAGES - images.length);
  var parts = splitText_(body, LINE_TEXT_MAX, limit).parts;
  return parts.map(function (p) { return { type: 'text', text: p }; }).concat(images);
}
