// 提示詞組裝。原有 system prompt 規則(繁體中文、不評論知識截止日期等)原樣保留。
var SYSTEM_RULES =
  '使用繁體中文回答。請整理出簡潔、口語化、適合在 LINE 上閱讀的回答(不需要附上完整網址或大量原文)。' +
  '請直接根據對話內容回答問題,不要對自己的訓練資料時間、知識截止日、系統時間或「現在是否已超過資料庫日期」做任何說明、評論、驚訝或道歉,' +
  '也不要提到『誤判時間』、『系統模擬時間』之類的詞語。' +
  '請直接輸出純文字,不要使用 Markdown 語法(例如 **粗體**、# 標題、程式碼區塊);需要條列時用「・」或數字加句點。' +
  '對話中使用者訊息開頭的「[圖片]」表示他當時附了一張圖片(你現在看不到它),只是標記,不要複述。';

var GROUP_RULES = '這是一個多人群組的共用對話,你不知道每則訊息是誰說的,不要猜測或點名說話者;只回應被 @ 的這一則訊息。';

var TIME_RULES =
  '請依現在的時間與對話間隔自然反應(例如早晚問候、很久沒聊時打個招呼),但不要逐項報時,除非使用者詢問時間;' +
  '不要把很久以前的對話當成剛剛才發生的事;訊息前面系統加上的「(距上一句約…)」是時間註記,僅供你判斷,請不要複述。';

var WEEKDAY_ZH = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
var MINUTE_MS = 60 * 1000;
var HOUR_MS = 60 * MINUTE_MS;
var DAY_MS = 24 * HOUR_MS;
var GAP_CONTINUOUS_MS = 30 * MINUTE_MS; // 「接續」與「隔了一陣子」的分界(固定值,與 GAP_MARKER_MINUTES 無關)

function periodOfDay_(hour) {
  if (hour < 5) return '凌晨';
  if (hour < 11) return '早上';
  if (hour < 13) return '中午';
  if (hour < 18) return '下午';
  if (hour < 23) return '晚上';
  return '深夜';
}

function gapLevel_(ms) {
  if (ms < GAP_CONTINUOUS_MS) return { name: '接續', hint: '對話是接續的,自然接著聊即可。' };
  if (ms < 6 * HOUR_MS) return { name: '隔了一陣子', hint: '和上一則訊息隔了一陣子,可以自然接話,但不要假設對方還停在原本的情境。' };
  if (ms < DAY_MS) return { name: '過了半天以上', hint: '已經過了半天以上,可以簡短問候,別把先前的話題當成剛剛才說的事。' };
  if (ms < 7 * DAY_MS) return { name: '隔了好幾天', hint: '隔了好幾天,自然地打個招呼,先前的話題當作之前聊過的事。' };
  return { name: '很久沒聊', hint: '很久沒聊了,用重逢的口氣問候,不要把舊話題當成剛剛的事。' };
}

function formatGap_(ms) {
  if (ms < MINUTE_MS) return '不到 1 分鐘';
  if (ms < HOUR_MS) return Math.floor(ms / MINUTE_MS) + ' 分鐘';
  if (ms < DAY_MS) return Math.floor(ms / HOUR_MS) + ' 小時';
  var days = Math.floor(ms / DAY_MS);
  if (days < 60) return days + ' 天';
  return Math.floor(days / 30) + ' 個月';
}

// 以設定的時區拆出 年/月/日/時/分/星期(1=週一)
function localParts_(rc, ms) {
  var p = Utilities.formatDate(new Date(ms), rc.cfg.TIMEZONE, 'yyyy-MM-dd-HH-mm-u').split('-');
  return { y: p[0], mo: p[1], d: p[2], h: Number(p[3]), mi: p[4], wd: Number(p[5]) };
}

function buildTimeBlock_(rc, chat, nowMs) {
  var t = localParts_(rc, nowMs);
  var zone = rc.cfg.TIMEZONE === 'Asia/Taipei' ? '台北時間' : rc.cfg.TIMEZONE;
  var hh = (t.h < 10 ? '0' : '') + t.h;
  var out = '現在是 ' + t.y + '年' + t.mo + '月' + t.d + '日 (' + WEEKDAY_ZH[t.wd] + ') ' + hh + ':' + t.mi +
    '(' + periodOfDay_(t.h) + '),' + zone + '。';
  if (chat && chat.lastAt) {
    var gap = Math.max(0, nowMs - chat.lastAt);
    var lv = gapLevel_(gap);
    out += '距離上一則訊息:約 ' + formatGap_(gap) + '〔' + lv.name + '〕。' + lv.hint;
  } else {
    out += '這是和使用者的第一次對話。';
  }
  return out;
}

function buildSystemPrompt(rc, chat, nowMs, userText) {
  return buildTimeBlock_(rc, chat, nowMs) + SYSTEM_RULES + TIME_RULES + (searchEnabled_(rc) ? SEARCH_HELP : '') + imageHelp_(rc, nowMs) +
    (chat && chat.kind === 'group' ? GROUP_RULES : '') +
    memoryBlocks_(rc, chat, userText || '', nowMs);
}

// 歷史 → Gemini contents。使用者訊息若與前一句相隔達 GAP_MARKER_MINUTES,送出的內容前加時間註記(原文不改)。
function historyToContents_(rc, history) {
  var gapMs = rc.cfg.GAP_MARKER_MINUTES * MINUTE_MS;
  return history.map(function (e, i) {
    var text = e.t;
    if (e.r === 'u' && i > 0 && e.ts && history[i - 1].ts) {
      var gap = e.ts - history[i - 1].ts;
      if (gap >= gapMs) text = '(距上一句約 ' + formatGap_(gap) + ') ' + text;
    }
    return { role: e.r === 'u' ? 'user' : 'model', parts: [{ text: text }] };
  });
}
