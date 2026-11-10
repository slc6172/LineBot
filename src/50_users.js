// 白名單:Users 表整張讀出放進快取;檢查在快取命中時不碰試算表。
function isTrueCell_(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

function loadUsers(rc) {
  var c = Cache.get(rc, 'users');
  if (c) {
    try { return JSON.parse(c); } catch (e) { /* 重建 */ }
  }
  var t = readTable_(rc, 'Users');
  if (!t.exists) logOnce(rc, 'users-missing', 3600, 'ERROR', 'USERS_SHEET_MISSING', '', '');
  var map = {};
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var id = String(r[0]).trim();
    if (id && isTrueCell_(r[3])) map[id] = String(r[1]).trim() || 'user';
  }
  Cache.put(rc, 'users', JSON.stringify(map), rc.cfg.USERS_CACHE_TTL_S);
  return map;
}
