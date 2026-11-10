// TinyFish 搜尋與讀頁(純 HTTP)。失敗一律視為「連不上網」,不重試;不依賴錯誤訊息文字。
var TF_SEARCH_URL = 'https://api.search.tinyfish.ai';
var TF_FETCH_URL = 'https://api.fetch.tinyfish.ai';
var TF_SEARCH_CAP_S = 15;
var TF_FETCH_CAP_S = 25;

function tfTimeout_(rc, ectx, cap) {
  return Math.floor(Math.min(cap, remainingS_(rc, ectx) - rc.cfg.BUDGET_RESERVE_S));
}

// 預算不足時回傳 null(視為連不上網)
function tfSearchRequest_(rc, ectx, query) {
  var t = tfTimeout_(rc, ectx, TF_SEARCH_CAP_S);
  if (t < 1) return null;
  return {
    url: TF_SEARCH_URL + '?query=' + encodeURIComponent(query) + '&location=' + encodeURIComponent(rc.cfg.SEARCH_LOCATION) +
      '&language=' + encodeURIComponent(rc.cfg.SEARCH_LANGUAGE),
    method: 'get', headers: { 'X-API-Key': rc.cfg.TINYFISH_API_KEY }, timeoutSeconds: t
  };
}

function tfFetchRequest_(rc, ectx, pageUrl) {
  var t = tfTimeout_(rc, ectx, TF_FETCH_CAP_S);
  if (t < 1) return null;
  return {
    url: TF_FETCH_URL, method: 'post', contentType: 'application/json',
    headers: { 'X-API-Key': rc.cfg.TINYFISH_API_KEY }, payload: JSON.stringify({ urls: [pageUrl], format: 'markdown' }), timeoutSeconds: t
  };
}

function tfFailDetail_(res) {
  return res.thrown ? 'EXC' : 'HTTP ' + res.code;
}

// → {ok:true, results:[...]} 或 {ok:false, detail}
function tfParseSearch_(res) {
  if (!res || res.thrown) return { ok: false, detail: 'EXC' };
  if (res.code < 200 || res.code >= 300) return { ok: false, detail: tfFailDetail_(res) };
  var j = res.json();
  if (!j || !Array.isArray(j.results)) return { ok: false, detail: 'unreadable' };
  return { ok: true, results: j.results };
}

// → {ok:true, title, text} 或 {ok:false, detail}
function tfParseFetch_(res) {
  if (!res || res.thrown) return { ok: false, detail: 'EXC' };
  if (res.code < 200 || res.code >= 300) return { ok: false, detail: tfFailDetail_(res) };
  var j = res.json();
  var page = j && Array.isArray(j.results) ? j.results[0] : null;
  if (!page || typeof page.text !== 'string' || !page.text.trim()) return { ok: false, detail: 'empty' };
  return { ok: true, title: typeof page.title === 'string' ? page.title : '', text: page.text };
}
