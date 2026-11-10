// 生圖:使用者主動要求(「畫一張…」)→ 模型呼叫 generate_image(英文提示詞)→ Cloudflare Workers AI → 存 Drive → 隨 reply 送出。
// 只有 JPEG/PNG 能用(LINE 限制);額度/冷卻/暫停是三種獨立的狀態;計數與 Images 記錄在鎖內的同一個寫入階段更新。
var CF_BASE = 'https://api.cloudflare.com/client/v4/accounts/';
var CF_MODEL_PREFIX = '@cf/black-forest-labs/';
var IMAGE_CALL_CAP_S = 40;
var IMAGE_PAUSE_S = 21600; // 設定錯誤時暫停 6 小時(以快取時效實作;快取上限剛好 6 小時)
var IMAGE_PAUSE_KEY = 'img:pause';
var IMAGE_PROMPT_MAX = 2000;
var LINE_PREVIEW_MAX_BYTES = 1000000;
var IMAGE_CLEANUP_BATCH = 5;
var IMAGE_DRIVE_FOLDER_PROPERTY = 'IMAGE_DRIVE_FOLDER_ID';
var CF_PAUSE_CODES = [5035, 5007, 5004];
var CF_CAPACITY_CODES = [3040, 3007];

var IMAGE_HELP =
  '使用者明確要求畫圖(例如「畫一張…」)時,呼叫 generate_image,把使用者的需求寫成具體的英文提示詞(描述主體、風格、構圖);' +
  '每次對話最多畫一張。圖片畫好後會隨你的回覆一起送出,請用一兩句話說明,不要貼網址。';
var IMAGE_UNAVAILABLE_NOTES = {
  quota: '今天的生圖額度已用完,使用者要求畫圖時請婉拒,並說明明天再試。',
  cooldown: '剛畫過圖,生圖冷卻中,使用者要求畫圖時請婉拒,並請他稍後再試。',
  paused: '今天不方便生圖,使用者要求畫圖時請婉拒。'
};
var IMAGE_NOTICES = {
  quota: '今天的生圖額度用完了,請明天再試',
  cooldown: '剛畫過圖,請稍後再試',
  paused: '生圖功能暫時無法使用,請稍後再試',
  budget: '時間不夠,這次沒有生圖',
  capacity: '生圖現在比較忙,請稍後再試',
  long: '提示詞太長,請縮短後再試',
  timeout: '生圖逾時了,請稍後再試',
  format: '產生的圖片格式不支援,請再試一次',
  drive: '圖片已產生但無法儲存,請稍後再試'
};

// ---- 純函式 ----
// 以檔頭判斷格式(位元組可為 GAS 的有號數)。只有 JPEG 與 PNG 能用。
function imageKind_(bytes) {
  if (!bytes || bytes.length < 3) return null;
  var b = function (i) { return bytes[i] & 255; };
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpg';
  if (bytes.length >= 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return 'png';
  return null;
}

// 圖片網址格式集中在這裡。drive.google.com/uc?export=view 伺服器端回 200 但 LINE 不顯示,不可用。
function imageUrl_(fileId, which) {
  var id = encodeURIComponent(fileId);
  return which === 'backup' ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000' : 'https://lh3.googleusercontent.com/d/' + id;
}

// 原圖與預覽圖同網址;預覽圖超過 LINE 的 1MB 上限時,預覽改用備援格式
function driveImageUrls_(fileId, sizeBytes) {
  var main = imageUrl_(fileId, 'main');
  return { original: main, preview: sizeBytes > LINE_PREVIEW_MAX_BYTES ? imageUrl_(fileId, 'backup') : main };
}

function utcDay_(ms) {
  return Utilities.formatDate(new Date(ms), 'UTC', 'yyyy-MM-dd');
}

function nextUtcMidnight_(ms) {
  var d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// ---- 可用性 ----
function imageConfigured_(rc) {
  // 沒設定圖片資料夾就視為未啟用:避免先花掉 Cloudflare 額度、之後才在 Drive 失敗。
  return rc.cfg.IMAGE_ENABLED && !!rc.cfg.CF_API_TOKEN && !!rc.cfg.CF_ACCOUNT_ID && !!rc.cfg.IMAGE_DRIVE_FOLDER_ID && rc.cfg.MAX_TOOL_TURNS > 0;
}

// _system 列(全域計數)。列不存在時也放進快取(負向快取),熱請求才不會每次去讀試算表。
function loadSystem_(rc) {
  if (!rc.sysState) {
    var st = loadChat(rc, SYSTEM_ROW_ID, 'system');
    if (st.isNew) cachePutState_(rc, st);
    rc.sysState = st;
  }
  return rc.sysState;
}

function imageFx_(rc) {
  if (!rc.imageFx) rc.imageFx = { generated: [], blockedUntil: 0, lastAt: 0 };
  return rc.imageFx;
}

// → 'ok' | 'paused' | 'quota' | 'cooldown' | 'budget'(ectx 為 null 時不看預算)
function imageStatus_(rc, ectx, nowMs) {
  if (Cache.get(rc, IMAGE_PAUSE_KEY)) return 'paused';
  var img = loadSystem_(rc).meta.image || {};
  var fx = imageFx_(rc);
  var used = (img.day === utcDay_(nowMs) ? img.n || 0 : 0) + fx.generated.length;
  if (nowMs < Math.max(img.blockedUntil || 0, fx.blockedUntil) || used >= rc.cfg.IMAGE_MAX_PER_DAY) return 'quota';
  var last = Math.max(img.lastAt || 0, fx.lastAt);
  if (rc.cfg.IMAGE_COOLDOWN_S > 0 && nowMs - last < rc.cfg.IMAGE_COOLDOWN_S * 1000) return 'cooldown';
  if (ectx && remainingS_(rc, ectx) < rc.cfg.IMAGE_MIN_BUDGET_S) return 'budget';
  return 'ok';
}

// system prompt 的生圖說明:可用 → 用法;暫時不可用 → 請模型婉拒;功能沒開 → 完全不提
function imageHelp_(rc, nowMs) {
  if (!imageConfigured_(rc)) return '';
  var st = imageStatus_(rc, null, nowMs);
  return st === 'ok' ? IMAGE_HELP : (IMAGE_UNAVAILABLE_NOTES[st] || '');
}

// ---- Cloudflare ----
// → {ok:true, bytes, kind} 或 {ok:false, kind:'quota'|'pause'|'capacity'|'long'|'timeout'|'format'|'other', status, code}
function cfGenerate_(rc, ectx, prompt) {
  var t = Math.floor(Math.min(IMAGE_CALL_CAP_S, remainingS_(rc, ectx) - rc.cfg.BUDGET_RESERVE_S));
  if (t < 1) return { ok: false, kind: 'timeout', status: 0, code: 0 };
  var res = Http.fetch(rc, CF_BASE + encodeURIComponent(rc.cfg.CF_ACCOUNT_ID) + '/ai/run/' + CF_MODEL_PREFIX + rc.cfg.CF_IMAGE_MODEL, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + rc.cfg.CF_API_TOKEN },
    payload: { prompt: prompt, width: String(rc.cfg.IMAGE_WIDTH), height: String(rc.cfg.IMAGE_HEIGHT) }, // GAS 物件 payload(已驗證可用)
    timeoutSeconds: t
  });
  if (res.thrown) return { ok: false, kind: 'timeout', status: 0, code: 0 };
  var j = res.json();
  var code = j && Array.isArray(j.errors) && j.errors[0] ? Number(j.errors[0].code) || 0 : 0;
  if (res.code < 400 && j && j.success === true && j.result && typeof j.result.image === 'string' && j.result.image) {
    var bytes = null;
    try { bytes = Utilities.base64Decode(j.result.image); } catch (e) { bytes = null; }
    var kind = bytes ? imageKind_(bytes) : null;
    if (!kind) return { ok: false, kind: 'format', status: res.code, code: 0 };
    return { ok: true, bytes: bytes, kind: kind };
  }
  var k = code === 3036 ? 'quota' : CF_PAUSE_CODES.indexOf(code) >= 0 ? 'pause' : CF_CAPACITY_CODES.indexOf(code) >= 0 ? 'capacity' : code === 3006 ? 'long' : 'other';
  return { ok: false, kind: k, status: res.code, code: code };
}

// ---- Drive ----
// 圖片專用資料夾。ID 由 loadConfig 讀自 Script Properties(IMAGE_DRIVE_FOLDER_ID,格式已驗證);
// 未設定時直接拒絕,絕不回退到 Drive 根目錄。
function imageDriveFolderId_(rc) {
  var id = rc && rc.cfg ? String(rc.cfg.IMAGE_DRIVE_FOLDER_ID || '').trim() : '';
  if (!id) throw new Error(IMAGE_DRIVE_FOLDER_PROPERTY + ' 未設定');
  return id;
}

// 所有圖片建立與清理都以此資料夾為界。若 ID 錯誤、資料夾不存在或無權限,讓呼叫端安全失敗。
function imageDriveFolder_(rc) {
  var folderId = imageDriveFolderId_(rc);
  var folder = DriveApp.getFolderById(folderId);
  if (!folder || typeof folder.createFile !== 'function') throw new Error('指定的圖片資料夾無法使用');
  if (typeof folder.getId === 'function' && String(folder.getId()) !== folderId) {
    throw new Error('指定的圖片資料夾 ID 不符');
  }
  return folder;
}

// 確認檔案確實位於指定資料夾(不因 Images 表有檔案 ID 就直接刪除)。
function imageFileInFolder_(file, folderId) {
  try {
    var parents = file.getParents();
    while (parents.hasNext()) {
      var parent = parents.next();
      if (parent && String(parent.getId()) === String(folderId)) return true;
    }
  } catch (e) { /* 無法確認位置時一律視為不屬於指定資料夾 */ }
  return false;
}

// 檔名只含時間戳(不含使用者的提示詞)。失敗時回傳 {ok:false},已建立的檔案會丟垃圾桶。
function saveToDrive_(bytes, kind, nowMs, rc) {
  var file = null;
  try {
    var blob = Utilities.newBlob(bytes, kind === 'png' ? 'image/png' : 'image/jpeg', 'img-' + nowMs + (kind === 'png' ? '.png' : '.jpg'));
    file = imageDriveFolder_(rc).createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return { ok: true, id: file.getId() };
  } catch (e) {
    if (file) { try { file.setTrashed(true); } catch (e2) { /* 忽略 */ } }
    return { ok: false };
  }
}

// ---- generate_image 的執行 ----
function imageFail_(tw, notice) {
  tw.imageNotices.push(notice);
  return { error: notice + '。系統會在回覆後附上說明,請不要編造圖片,簡短地回應使用者即可。' };
}

function cfFailure_(rc, ectx, tw, r, nowMs) {
  var fx = imageFx_(rc);
  if (r.kind === 'quota') {
    fx.blockedUntil = nextUtcMidnight_(nowMs);
    logAdd(rc, 'STATUS', 'IMAGE_QUOTA_EXHAUSTED', ectx.chatId, 'until ' + new Date(fx.blockedUntil).toISOString());
    return imageFail_(tw, IMAGE_NOTICES.quota);
  }
  if (r.kind === 'pause') {
    Cache.put(rc, IMAGE_PAUSE_KEY, '1', IMAGE_PAUSE_S);
    logAdd(rc, 'ERROR', 'IMAGE_PAUSED', ectx.chatId, 'code ' + r.code);
    return imageFail_(tw, IMAGE_NOTICES.paused);
  }
  if (r.kind === 'capacity') {
    logAdd(rc, 'STATUS', 'IMAGE_BUSY', ectx.chatId, 'code ' + r.code);
    return imageFail_(tw, IMAGE_NOTICES.capacity);
  }
  if (r.kind === 'long') return imageFail_(tw, IMAGE_NOTICES.long);
  if (r.kind === 'timeout') {
    logAdd(rc, 'STATUS', 'IMAGE_TIMEOUT', ectx.chatId, '');
    return imageFail_(tw, IMAGE_NOTICES.timeout);
  }
  if (r.kind === 'format') {
    logAdd(rc, 'ERROR', 'IMAGE_FAILED', ectx.chatId, 'format');
    return imageFail_(tw, IMAGE_NOTICES.format);
  }
  logAdd(rc, 'ERROR', 'IMAGE_FAILED', ectx.chatId, 'HTTP ' + r.status + (r.code ? ' code ' + r.code : ''));
  return imageFail_(tw, '生圖失敗(HTTP ' + r.status + (r.code ? ',Cloudflare 錯誤代碼 ' + r.code : '') + ')');
}

function runImageCall_(rc, ectx, tw, args) {
  if (tw.imageTried) return { error: '每回合至多只能生一張圖' };
  var prompt = args && typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt || prompt.length > IMAGE_PROMPT_MAX) return { error: '提示詞不合法:需要 1 到 ' + IMAGE_PROMPT_MAX + ' 字的描述' };
  tw.imageTried = true;
  var now = Clock.now();
  var st = imageStatus_(rc, ectx, now);
  if (st !== 'ok') return imageFail_(tw, IMAGE_NOTICES[st]);
  var r = cfGenerate_(rc, ectx, prompt);
  if (!r.ok && r.kind === 'capacity' && remainingS_(rc, ectx) - rc.cfg.BUDGET_RESERVE_S >= rc.cfg.IMAGE_MIN_BUDGET_S) {
    Clock.sleep(1000);
    r = cfGenerate_(rc, ectx, prompt); // 暫時沒容量:預算足夠才重試一次
  }
  if (!r.ok) return cfFailure_(rc, ectx, tw, r, now);
  var saved = saveToDrive_(r.bytes, r.kind, now, rc);
  if (!saved.ok) {
    logAdd(rc, 'ERROR', 'IMAGE_DRIVE_FAILED', ectx.chatId, '');
    return imageFail_(tw, IMAGE_NOTICES.drive);
  }
  var urls = driveImageUrls_(saved.id, r.bytes.length);
  tw.images.push({ type: 'image', originalContentUrl: urls.original, previewImageUrl: urls.preview });
  var fx = imageFx_(rc);
  fx.generated.push({ id: saved.id, ts: now });
  fx.lastAt = now;
  return { result: '圖片已產生,會隨你的回覆一起送出。請用一兩句話跟使用者說明,不要貼網址,也不要描述圖片裡看不到的細節。' };
}

// ---- 寫入階段(鎖內):額度與冷卻計數、Images 記錄、保留期清理 ----
function imageEffectsPending_(rc) {
  return !!(rc.imageFx && (rc.imageFx.generated.length || rc.imageFx.blockedUntil));
}

function applyImageEffects_(rc) {
  if (!imageEffectsPending_(rc)) return;
  var fx = rc.imageFx;
  var now = Clock.now();
  var sys = loadChatLocked(rc, SYSTEM_ROW_ID, 'system');
  var img = sys.meta.image || {};
  var today = utcDay_(now);
  if (img.day !== today) { img.day = today; img.n = 0; }
  img.n = (img.n || 0) + fx.generated.length;
  if (fx.generated.length) img.lastAt = fx.lastAt;
  if (fx.blockedUntil) img.blockedUntil = Math.max(img.blockedUntil || 0, fx.blockedUntil);
  sys.meta.image = img;
  sys.updatedAt = now;
  saveChat(rc, sys);
  if (fx.generated.length) {
    appendRows_(rc, 'Images', fx.generated.map(function (f) { return [f.id, f.ts, 0]; }));
    trashExpiredImages_(rc, now);
  }
  rc.sysState = null;
  rc.imageFx = { generated: [], blockedUntil: 0, lastAt: 0 };
}

// 每次成功生圖時,順便把超過 IMAGE_RETENTION_DAYS 的檔案丟垃圾桶(一次至多 5 個)。
// 只處理目前指定資料夾中的檔案;舊版留在根目錄或其他資料夾的檔案一律跳過。
function trashExpiredImages_(rc, nowMs) {
  var t = readTable_(rc, 'Images');
  if (!t.exists) return;
  var folderId;
  try {
    var folder = imageDriveFolder_(rc);
    folderId = String(folder.getId());
  } catch (e) { return; }
  var sh = openSpreadsheet_(rc).getSheetByName('Images');
  var cutoff = nowMs - rc.cfg.IMAGE_RETENTION_DAYS * DAY_MS;
  var done = 0;
  for (var i = 1; i < t.values.length && done < IMAGE_CLEANUP_BATCH; i++) {
    var r = t.values[i];
    if (Number(r[2]) === 1 || !(Number(r[1]) < cutoff)) continue;
    try {
      var file = DriveApp.getFileById(String(r[0]));
      if (!imageFileInFolder_(file, folderId)) continue;
      file.setTrashed(true);
      sh.getRange(i + 1, 3, 1, 1).setValues([[1]]);
      done++;
    } catch (e) {
      // 檔案已不存在/不可存取時不會刪除任何檔案;沿用舊行為標記為已處理,避免每次重掃。
      sh.getRange(i + 1, 3, 1, 1).setValues([[1]]);
      done++;
    }
  }
}
