// 設定:一次讀出全部 Script Properties,套用預設值與範圍檢查。
var CONFIG_SECRET_KEYS = [
  'LINE_CHANNEL_ACCESS_TOKEN', 'GEMINI_API_KEY', 'TINYFISH_API_KEY',
  'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'WEBHOOK_KEY', 'SPREADSHEET_ID'
];

var MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;
var DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,100}$/; // Google Drive 資料夾/檔案 ID

// t: int | num | bool | enum | re(字串須符合正規表示式) | list
var CONFIG_SPEC = [
  { k: 'GEMINI_MODEL', t: 're', re: MODEL_RE, d: 'gemini-3.5-flash-lite' },
  { k: 'GEMINI_MODEL_AUX', t: 're', re: MODEL_RE, d: null }, // null = 同 GEMINI_MODEL
  { k: 'THINKING_LEVEL', t: 'enum', o: ['minimal', 'low', 'medium', 'high'], d: 'low' },
  { k: 'MAX_OUTPUT_TOKENS', t: 'int', min: 64, max: 8192, d: 1024 },
  { k: 'TIME_BUDGET_S', t: 'num', min: 10, max: 240, d: 60 },
  { k: 'BUDGET_RESERVE_S', t: 'num', min: 1, max: 30, d: 5 },
  { k: 'MIN_TURN_S', t: 'num', min: 1, max: 60, d: 12 },
  { k: 'MAX_TOOL_TURNS', t: 'int', min: 0, max: 6, d: 3 },
  { k: 'HISTORY_MAX_TURNS', t: 'int', min: 1, max: 100, d: 20 },
  { k: 'FOLD_BATCH_TURNS', t: 'int', min: 1, max: 50, d: 10 },
  { k: 'MEMORY_ENABLED', t: 'bool', d: true },
  { k: 'LONG_TERM_MAX_CHARS', t: 'int', min: 200, max: 10000, d: 2000 },
  { k: 'RECENT_NOTES_MAX_CHARS', t: 'int', min: 0, max: 3000, d: 600 },
  { k: 'RETRIEVAL_K', t: 'int', min: 0, max: 10, d: 3 },
  { k: 'RETRIEVAL_SNIPPET_CHARS', t: 'int', min: 20, max: 1000, d: 200 },
  { k: 'RETRIEVAL_MIN_MESSAGE_CHARS', t: 'int', min: 1, max: 20, d: 3 },
  { k: 'RETRIEVAL_MIN_SCORE', t: 'num', min: 0, max: 5, d: 0.6 },
  { k: 'ARCHIVE_SCAN_LIMIT', t: 'int', min: 0, max: 50000, d: 5000 },
  { k: 'SEARCH_MAX_RESULTS', t: 'int', min: 1, max: 10, d: 5 },
  { k: 'SEARCH_LOCATION', t: 're', re: /^[A-Z]{2}$/, d: 'TW' },
  { k: 'SEARCH_LANGUAGE', t: 're', re: /^[a-z]{2,3}$/, d: 'zh' },
  { k: 'SEARCH_BLOCKED_DOMAINS', t: 'list', d: [] },
  { k: 'IMAGE_ENABLED', t: 'bool', d: false },
  { k: 'CF_IMAGE_MODEL', t: 're', re: MODEL_RE, d: 'flux-2-klein-9b' },
  { k: 'IMAGE_DRIVE_FOLDER_ID', t: 're', re: DRIVE_ID_RE, d: '' }, // 生圖專用 Drive 資料夾;未設定 = 生圖停用
  { k: 'IMAGE_WIDTH', t: 'int', min: 256, max: 2048, d: 576 },
  { k: 'IMAGE_HEIGHT', t: 'int', min: 256, max: 2048, d: 1024 },
  { k: 'IMAGE_MAX_PER_DAY', t: 'int', min: 0, max: 1000, d: 6 },
  { k: 'IMAGE_COOLDOWN_S', t: 'int', min: 0, max: 3600, d: 30 },
  { k: 'IMAGE_MIN_BUDGET_S', t: 'num', min: 1, max: 120, d: 20 },
  { k: 'IMAGE_RETENTION_DAYS', t: 'int', min: 1, max: 3650, d: 30 },
  { k: 'IMAGE_PENDING_TTL_S', t: 'int', min: 30, max: 3600, d: 600 },
  { k: 'IMAGE_PENDING_MAX', t: 'int', min: 1, max: 10, d: 3 },
  { k: 'USERS_CACHE_TTL_S', t: 'int', min: 1, max: 21600, d: 300 },
  { k: 'FORGET_CONFIRM_TTL_S', t: 'int', min: 5, max: 600, d: 60 },
  { k: 'GAP_MARKER_MINUTES', t: 'int', min: 1, max: 1440, d: 30 },
  { k: 'TIMEZONE', t: 're', re: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/, d: 'Asia/Taipei' },
  { k: 'PUSH_MONTHLY_BUDGET', t: 'int', min: 0, max: 100000, d: 0 },
  { k: 'LOG_MAX_ROWS', t: 'int', min: 50, max: 100000, d: 1000 },
  { k: 'DEBUG_TIMING', t: 'bool', d: false }
];

function configTrim_(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

// 回傳 undefined = 未設定;null = 設了但不合法;其他 = 解析後的值
function configParse_(spec, raw) {
  var s = configTrim_(raw);
  if (s === '') return undefined;
  if (spec.t === 'int' || spec.t === 'num') {
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    var n = Number(s);
    if (spec.t === 'int' && Math.floor(n) !== n) return null;
    if (n < spec.min || n > spec.max) return null;
    return n;
  }
  if (spec.t === 'bool') {
    var l = s.toLowerCase();
    if (l === 'true') return true;
    if (l === 'false') return false;
    return null;
  }
  if (spec.t === 'enum') return spec.o.indexOf(s) >= 0 ? s : null;
  if (spec.t === 're') return spec.re.test(s) ? s : null;
  if (spec.t === 'list') {
    return s.split(/[\s,]+/).filter(function (x) { return x; }).map(function (x) { return x.toLowerCase(); });
  }
  return null;
}

function loadConfig(props) {
  var cfg = {};
  var issues = [];
  CONFIG_SECRET_KEYS.forEach(function (k) { cfg[k] = configTrim_(props[k]); });
  CONFIG_SPEC.forEach(function (spec) {
    var v = configParse_(spec, props[spec.k]);
    if (v === undefined) {
      cfg[spec.k] = spec.d;
    } else if (v === null) {
      issues.push(spec.k);
      cfg[spec.k] = spec.d;
    } else {
      cfg[spec.k] = v;
    }
  });
  if (cfg.GEMINI_MODEL_AUX === null) cfg.GEMINI_MODEL_AUX = cfg.GEMINI_MODEL;
  return { cfg: cfg, issues: issues };
}
