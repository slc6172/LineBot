// 整理(fold):尚未整理的原文超過 HISTORY_MAX_TURNS 輪 → 在 reply 送出之後,用輔助模型與結構化輸出,
// 把最舊的幾輪整理成「日誌事件」與「完整的新版長期事實」。模型呼叫不持鎖;結果在鎖內與本回合的寫入一起完成。
var FOLD_FLAG_TTL_S = 120;
var FOLD_MAX_OUTPUT_TOKENS = 4096; // 整理的 JSON 不能被對話用的 MAX_OUTPUT_TOKENS 截斷
var HISTORY_HARD_CAP_FACTOR = 3;   // 整理一直失敗時,State 裡的原文最多留 HISTORY_MAX_TURNS 的幾倍

var FOLD_SYSTEM =
  '你是記憶整理助手。根據「目前的長期記憶」與「要併入的新對話」,整理出兩樣東西:\n' +
  '1. events:這批新對話裡發生的事件,每項一句話(80 字內)並附 YYYY-MM-DD 日期,最多 10 項。這是只增不改的日誌。\n' +
  '2. facts:長期記憶的『完整新版本』(會整組取代舊版),分成 user(關於使用者:喜好、家人、工作、習慣)、' +
  'shared(你們一起經歷或約定的事)、followups(待跟進的事)、earlier_summary(更早的摘要,可再濃縮;沒有就不要寫)。\n' +
  '刪除過時或被推翻的項目,合併重複的,留下長期有用的。總長度要控制在上限以內,太長就壓縮。' +
  '只記對話裡真的說過的內容,不要編造。用繁體中文。\n' +
  '新對話中每一行開頭方括號裡的是那句話的日期。事件、計畫與時間請以「絕對日期」記錄(例如「2026-10-12 前後有面試」),' +
  '把「下週」「明天」「上個月」這類相對說法依該句話的日期換算成日期,不要原樣照抄相對說法。';

var FOLD_LIST_ = { type: 'array', items: { type: 'string' } };
var FOLD_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, text: { type: 'string', description: '一句話,80 字內' } }, required: ['date', 'text'] },
      description: '這批對話裡發生的事件,最多 10 項'
    },
    facts: {
      type: 'object',
      properties: { user: FOLD_LIST_, shared: FOLD_LIST_, followups: FOLD_LIST_, earlier_summary: { type: 'string', description: '更早的摘要,沒有就省略' } },
      required: ['user', 'shared', 'followups']
    }
  },
  required: ['events', 'facts']
};

function turnsOf_(history) {
  var n = 0;
  history.forEach(function (e) { if (e.r === 'u') n++; });
  return n;
}

// 送給模型的原文窗口:最近 HISTORY_MAX_TURNS 輪(更舊、尚未整理的只供檢索)
function windowHistory_(history, maxTurns) {
  var h = history.slice(-maxTurns * 2);
  while (h.length && h[0].r !== 'u') h.shift();
  return h;
}

function dateOfMs_(rc, ms) {
  return Utilities.formatDate(new Date(ms), rc.cfg.TIMEZONE, 'yyyy-MM-dd');
}

// 汙染回合的回覆(用到網頁內容)只留佔位文字:網頁內容永遠不進長期記憶
function foldText_(e) {
  if (e.r !== 'm' || !e.p) return e.t;
  return e.q && e.q.length ? '(那天查過:' + e.q.join('、') + ';網頁內容未納入)' : '(那天用到網頁內容;網頁內容未納入)';
}

// 要不要整理、整理哪幾輪。至少留下 1 輪原文;剩餘預算不足或已有整理在進行時略過。
function planFold_(rc, ectx, chat, newEntries) {
  if (!rc.cfg.MEMORY_ENABLED) return null;
  var all = chat.history.concat(newEntries);
  var turns = turnsOf_(all);
  if (turns <= rc.cfg.HISTORY_MAX_TURNS) return null;
  if (remainingS_(rc, ectx) < rc.cfg.MIN_TURN_S) return null;
  if (Cache.get(rc, 'fold:' + ectx.chatId)) return null;
  var n = Math.min(rc.cfg.FOLD_BATCH_TURNS, turns - 1);
  return { old: all.slice(0, n * 2) };
}

// 呼叫輔助模型並檢查結果。回傳 {events, facts(null=保留舊事實)} 或 null(狀態完全不動,下次請求再試)。
function requestFold_(rc, ectx, chat, plan) {
  Cache.put(rc, 'fold:' + ectx.chatId, '1', FOLD_FLAG_TTL_S);
  var facts = parseFacts_(chat);
  var limit = rc.cfg.LONG_TERM_MAX_CHARS;
  var size = 0;
  FACT_SECTIONS.forEach(function (sec) { size += String(facts[sec] || '').length; });
  var shown = FACT_SECTIONS.filter(function (sec) { return String(facts[sec] || '').trim(); })
    .map(function (sec) { return '〔' + sec + '〕\n' + facts[sec]; }).join('\n') || '無';
  var lines = plan.old.map(function (e) {
    return '[' + dateOfMs_(rc, e.ts || ectx.t0) + '] ' + (e.r === 'u' ? '使用者:' : '助理:') + foldText_(e);
  });
  var body = {
    systemInstruction: { parts: [{ text: FOLD_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: '【目前的長期記憶】(共 ' + size + ' 字,上限 ' + limit + ' 字)\n' + shown + '\n\n【要併入的新對話】\n' + lines.join('\n') }] }],
    generationConfig: {
      temperature: 0.2, maxOutputTokens: FOLD_MAX_OUTPUT_TOKENS, responseMimeType: 'application/json', responseJsonSchema: FOLD_SCHEMA,
      thinkingConfig: { thinkingLevel: rc.cfg.THINKING_LEVEL }
    }
  };
  var r = geminiGenerate(rc, ectx, rc.cfg.GEMINI_MODEL_AUX, body);
  if (!r.ok) { logAdd(rc, 'STATUS', 'FOLD_FAILED', ectx.chatId, r.kind); return null; }
  var data = null;
  try { data = JSON.parse(r.text); } catch (e) { data = null; }
  var norm = normalizeFold_(data, dateOfMs_(rc, plan.old[0].ts || ectx.t0));
  if (!norm) { logAdd(rc, 'STATUS', 'FOLD_INVALID', ectx.chatId, ''); return null; }
  var hadOld = ['使用者', '共同經歷', '待跟進'].some(function (sec) { return String(facts[sec] || '').trim(); });
  var keptNew = Object.keys(norm.facts).filter(function (k) { return k !== '更早的摘要'; });
  if (!keptNew.length && hadOld) { logAdd(rc, 'STATUS', 'FOLD_ERASE_REJECTED', ectx.chatId, ''); return null; }
  var newFacts = norm.facts;
  if (!newFacts['更早的摘要'] && String(facts['更早的摘要'] || '').trim()) newFacts['更早的摘要'] = facts['更早的摘要'];
  var total = 0;
  Object.keys(newFacts).forEach(function (k) { total += newFacts[k].length; });
  if (total > limit) { logAdd(rc, 'STATUS', 'FOLD_OVER_LIMIT', ectx.chatId, total + '>' + limit); newFacts = null; }
  return { events: norm.events, facts: newFacts };
}

// 在鎖內套用整理結果:歸檔被移出的原文、追加事件、(若有)換新版事實、前進進度。
// 若 State 最舊的原文已不是當初整理的那些(例如被 /忘記 清掉),整份結果作廢。
function applyFold_(rc, ectx, st, plan, result) {
  var old = plan.old;
  var same = st.history.length >= old.length && old.every(function (e, i) {
    var h = st.history[i];
    return h.r === e.r && h.ts === e.ts && h.t === e.t;
  });
  if (!same) { logAdd(rc, 'STATUS', 'FOLD_STALE', ectx.chatId, ''); return false; }
  appendRows_(rc, 'Archive', old.map(function (e) {
    return [st.chatId, e.ts || 0, e.r, String(foldText_(e)).slice(0, ARCHIVE_CELL_MAX), e.p ? 1 : 0];
  }));
  appendRows_(rc, 'Events', result.events.map(function (e) { return [st.chatId, e.date, '', '事件', e.text]; }));
  st.history = st.history.slice(old.length);
  if (result.facts) st.facts = factsString_(result.facts);
  st.meta.folds = (st.meta.folds || 0) + 1;
  invalidateMemory_(rc, st.chatId);
  return true;
}

// 原文數量的上限:記憶關閉時只留最近 HISTORY_MAX_TURNS 輪;開啟時整理失敗也有安全上限,不會無限成長
function enforceHistoryLimit_(rc, st) {
  var max = rc.cfg.HISTORY_MAX_TURNS;
  if (!rc.cfg.MEMORY_ENABLED) { trimHistory_(st.history, max); return; }
  var cap = max * HISTORY_HARD_CAP_FACTOR;
  var before = turnsOf_(st.history);
  if (before > cap) {
    trimHistory_(st.history, cap);
    logAdd(rc, 'STATUS', 'HISTORY_CAP_DROP', st.chatId, (before - cap) + ' turns');
  }
}
