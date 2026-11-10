// 時鐘包裝:正式碼一律透過這裡取得時間(測試會覆寫)。
var Clock = {
  now: function () { return Date.now(); },
  sleep: function (ms) { Utilities.sleep(ms); }
};
