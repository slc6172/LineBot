// Gemini REST 用戶端:標頭金鑰、時間預算、錯誤分類(只看狀態碼與回應結構)。
var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
var GEMINI_CALL_CAP_S = 40;
var GEMINI_RETRY_BACKOFF_MS = 1000;
var GEMINI_RETRY_MIN_S = 3; // 退避後仍須剩下至少這麼多秒才重試
var GEMINI_SAFETY_FINISH = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'];

var ERROR_REPLIES = {
  blocked: '這個問題被安全機制擋下了,換個問法再試試吧。',
  busy: '現在太多人在用,請稍後再試。',
  timeout: '處理逾時了,請稍後再試。',
  other: '抱歉,發生錯誤,請稍後再試。'
};

// 從 parts 安全取出文字(相容 thoughtSignature 等額外欄位;略過思考內容)
function extractText_(parts) {
  var out = '';
  for (var i = 0; i < (parts || []).length; i++) {
    var p = parts[i];
    if (p && typeof p.text === 'string' && !p.thought) out += p.text;
  }
  return out;
}

function remainingS_(rc, ectx) {
  return rc.cfg.TIME_BUDGET_S - (Clock.now() - ectx.t0) / 1000;
}

function geminiOnce_(rc, ectx, model, body) {
  var timeoutS = Math.floor(Math.min(GEMINI_CALL_CAP_S, remainingS_(rc, ectx) - rc.cfg.BUDGET_RESERVE_S));
  if (timeoutS < 1) return { ok: false, kind: 'timeout', retry: false, code: 0 };
  var res = Http.fetch(rc, GEMINI_BASE + model + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': rc.cfg.GEMINI_API_KEY },
    payload: JSON.stringify(body),
    timeoutSeconds: timeoutS
  });
  if (res.thrown) return { ok: false, kind: 'timeout', retry: true, code: 0 };
  if (res.code === 429) return { ok: false, kind: 'busy', retry: true, code: 429 };
  if (res.code >= 500) return { ok: false, kind: 'busy', retry: true, code: res.code };
  if (res.code < 200 || res.code >= 300) return { ok: false, kind: 'other', retry: false, code: res.code };
  var json = res.json();
  if (!json) return { ok: false, kind: 'other', retry: true, code: res.code };
  if (json.promptFeedback && json.promptFeedback.blockReason) return { ok: false, kind: 'blocked', retry: false, code: res.code };
  var cand = json.candidates && json.candidates[0];
  if (!cand) return { ok: false, kind: 'blocked', retry: false, code: res.code };
  if (cand.finishReason && GEMINI_SAFETY_FINISH.indexOf(cand.finishReason) >= 0) return { ok: false, kind: 'blocked', retry: false, code: res.code };
  var parts = (cand.content && cand.content.parts) || [];
  var text = extractText_(parts);
  var calls = parts.filter(function (p) { return p && p.functionCall && typeof p.functionCall.name === 'string'; })
    .map(function (p) { return p.functionCall; });
  if (!text && !calls.length) return { ok: false, kind: 'other', retry: false, code: res.code };
  if (cand.finishReason === 'MAX_TOKENS') logAdd(rc, 'STATUS', 'GEMINI_MAX_TOKENS', ectx.chatId, '');
  return { ok: true, text: text, parts: parts, calls: calls, finishReason: cand.finishReason || '' };
}

// 429 與暫時性失敗在剩餘預算足夠時重試一次(短暫退避);否則直接回傳失敗
function geminiGenerate(rc, ectx, model, body) {
  var r = geminiOnce_(rc, ectx, model, body);
  if (!r.ok && r.retry) {
    var left = remainingS_(rc, ectx) - GEMINI_RETRY_BACKOFF_MS / 1000 - rc.cfg.BUDGET_RESERVE_S;
    if (left >= GEMINI_RETRY_MIN_S) {
      logAdd(rc, 'STATUS', 'GEMINI_RETRY', ectx.chatId, r.code ? 'HTTP ' + r.code : 'EXC');
      Clock.sleep(GEMINI_RETRY_BACKOFF_MS);
      r = geminiOnce_(rc, ectx, model, body);
    }
  }
  if (!r.ok) logGeminiFailure_(rc, ectx, r);
  return r;
}

function logGeminiFailure_(rc, ectx, r) {
  var detail = r.code ? 'HTTP ' + r.code : 'EXC';
  if (r.kind === 'blocked') logAdd(rc, 'STATUS', 'GEMINI_BLOCKED', ectx.chatId, detail);
  else if (r.kind === 'busy' && r.code === 429) logAdd(rc, 'STATUS', 'GEMINI_RATE_LIMIT', ectx.chatId, detail);
  else logAdd(rc, 'ERROR', 'GEMINI_FAILED', ectx.chatId, r.kind + ' ' + detail);
}
