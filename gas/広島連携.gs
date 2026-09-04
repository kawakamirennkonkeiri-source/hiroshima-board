/**
 * 広島連携GAS（発注書スプレッドシート → 電子黒板／資材管理アプリ）
 * ㈱カワカミ蓮根 広島DX（センターの仕組みを流用・小規模版）
 *
 * ★最重要ルール（模索段階のため）：
 *   CFG.ORDER_SS_ID（発注書スプレッドシート）に対しては、このファイル内のどの関数も
 *   「読み取り（getRange/getValues等）」しか行わない。setValue/appendRow等の書き込み系APIは
 *   一切呼ばない。書き込みは全て CFG.DATA_SS_ID（このアプリ専用の新規スプレッドシート）にだけ行う。
 *   ＝発注書スプレッドシートは完全に閲覧のみ。新しいシートの追加も含めて一切触らない。
 *
 *   「進捗シートに数字が飛ぶように」という要望は、まず DATA_SS_ID 側の「進捗テスト」シートで
 *   試験運用し、実際の発注書「進捗」シートの数字と見比べて問題なさそうだと確認できてから、
 *   本番の発注書「進捗」シートへの書き込み機能を追加する（＝2段階方式の第1段階のみ、今回実装）。
 *
 * すべて JSONP（?callback=xxx）で返すので、電子黒板(file:// or GitHub Pages)から直接読めます。
 */

// ===== 設定（ここだけ書き換える） =====
var CFG = {
  TZ: 'Asia/Tokyo',

  // 発注書（読み取り専用）
  ORDER_SS_ID: '1HAVPPVf1KAejD9us2JkGRqQQOvtlZE4c4UqnwMmpnC0',
  ORDER_MAIN_SHEET: '発注書',      // 収穫舟数などを表示するためだけに読む（書き込み絶対禁止）
  ORDER_PROGRESS_SHEET: '2026年進捗',  // 荷造数・残数・合計㎏数などを表示するためだけに読む（書き込み絶対禁止）
  // ※実際のタブ名は年度が変わると変化する可能性がある（2026年進捗→2027年進捗 等）。
  //   年度が変わったら debug (?type=debug の orderSheetNames) で実際のタブ名を確認し、ここを直す。

  // 「収穫舟数」に相当する見出しを探すためのキーワード（広島は「収穫 舟数」等スペース/改行が入るため
  //   比較前に正規化する。normText_ 参照）
  ORDER_FUNES_KEYWORD: '収穫舟数',

  // 電子黒板の表示対象にする列を選ぶキーワード（進捗シートの列見出しにこれらの文字が含まれていれば表示）
  //   ＝取引先ごとの列構成を事前に決め打ちせず、見出し文字列だけで拾う（見出しが変わっても壊れにくい）
  PROGRESS_KEYWORDS: ['荷造数', '残数', '合計', '舟数', '歩留', 'CS率', 'C率', 'S率'],

  // このアプリ専用データの保存先（新規作成済み）。書き込みは必ずここだけに行う。
  DATA_SS_ID: '1m7r5lk-Tgkn2UsvMxiGVRxF3qyaFHE0aIXa3AtIxa0w',
  PROGRESS_TEST_SHEET: '進捗テスト',      // ①「進捗シートへ数字を飛ばす」機能の試験運用ログ
  SEISAN_SHEET: '生産者記録',            // ② 生産者の持ち込み舟数・出来高
  SHIZAI_SHEET: '資材データ',            // ③ 資材管理アプリ：クラウド共有データ本体
  SHIZAI_BACKUP_SHEET: '資材バックアップ', // ③ 月末棚卸ごとの世代バックアップ（追記のみ）
  SHIZAI_STOCK_SHEET: '月末棚卸（実数）',  // ③ 人が読める実数の表

  MARK_PRESENT: '〇'
};

// ============================================================
// 入口：?type=... & ?callback=... で分岐（JSONP）
// ============================================================
function doGet(e){
  e = e || { parameter:{} };
  var type = e.parameter.type || '';
  var out;
  try{
    if(type === 'progress')          out = getProgressToday_(e.parameter);
    else if(type === 'funes')        out = getFunesToday_(e.parameter);
    else if(type === 'progressTestGet') out = progressTestGet_(e.parameter);
    else if(type === 'seisanGet')    out = seisanGet_(e.parameter);
    else if(type === 'nizukuri')     out = getNizukuriToday_(e.parameter);   // ⑤ 発注書「発注書」シート：本日の取引先別注文一覧
    else if(type === 'mainStats')    out = getMainStatsToday_(e.parameter);  // ① 発注書「発注書」7行目の集計列（荷造り舟数・収穫舟数等）
    else if(type === 'shizaiAlerts') out = getShizaiAlerts_();               // ④ 資材管理アプリの要確認アラート（簡易版）
    else if(type === 'shizaiLoad')   out = getShizaiState_();
    else if(type === 'shizaiMeta')   out = getShizaiMeta_();
    else if(type === 'shizaiBackupList') out = getShizaiBackupList_();
    else if(type === 'shizaiBackupGet')  out = getShizaiBackup_(e.parameter);
    else if(type === 'shizaiUsage')  out = getShizaiUsage_(e.parameter);
    else if(type === 'bundle')       out = getBundle_(e.parameter);
    else if(type === 'debug')        out = debugTop_();
    else out = { error:'type を progress / funes / progressTestGet / seisanGet / nizukuri / mainStats / shizaiAlerts / shizaiLoad / shizaiMeta / shizaiBackupList / shizaiBackupGet / shizaiUsage / bundle / debug のいずれかで指定してください' };
  }catch(err){
    out = { error: String(err && err.message || err) };
  }
  var body = JSON.stringify(out);
  if(e.parameter.callback){
    return ContentService.createTextOutput(e.parameter.callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 入口（書き込み・POST）：全て CFG.DATA_SS_ID にしか書かない
// ============================================================
function doPost(e){
  var out;
  try{
    var body = {};
    try{ body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }catch(_){ body = {}; }
    var action = body.action || (e && e.parameter && e.parameter.action) || '';
    if(action === 'progressTestSave')      out = progressTestSave_(body);
    else if(action === 'seisanSave')       out = seisanSave_(body);
    else if(action === 'shizaiSave')       out = saveShizaiState_(body);
    else if(action === 'shizaiBackupSave') out = saveShizaiBackup_(body);
    else out = { ok:false, error:'unknown action: ' + action };
  }catch(err){
    out = { ok:false, error:String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// ★ まとめ取得（黒板のポーリング用）：主要データを1回のリクエストで返す
// ============================================================
function getBundle_(params){
  function safe(fn){ try{ return fn(); }catch(e){ return { error: String(e && e.message || e) }; } }
  return {
    progress:     safe(function(){ return getProgressToday_(params); }),
    funes:        safe(function(){ return getFunesToday_(params); }),
    progressTest: safe(function(){ return progressTestGet_(params); }),
    seisan:       safe(function(){ return seisanGet_(params); }),
    nizukuri:     safe(function(){ return getNizukuriToday_(params); }),
    mainStats:    safe(function(){ return getMainStatsToday_(params); }),
    shizaiAlerts: safe(function(){ return getShizaiAlerts_(); })
  };
}

// ============================================================
// 共通ヘルパー：見出し文字列の正規化・日付セルの解釈・多段見出しの読み取り
//   広島の発注書は「収穫 舟数」「Mup 合計㎏数」のように空白/接頭語/kg・㎏表記のブレがあるため、
//   比較前に必ず正規化する。また日付列はDate型／「7月1日 (水)」のようなテキスト型の両対応にする。
// ============================================================
function normText_(s){
  return String(s == null ? '' : s)
    .replace(/\r\n|\r|\n/g, '')
    .replace(/[ \t　]/g, '')
    .trim();
}
function normUnit_(s){
  return normText_(s).replace(/kg|ｋｇ|Kg|KG/g, '㎏');
}
// セル1個から「月/日」を取り出す（Date型でも「7月1日 (水)」のようなテキストでもOK）
function cellMonthDay_(v){
  if(v instanceof Date){
    return { m: v.getMonth() + 1, d: v.getDate() };
  }
  var s = String(v == null ? '' : v);
  var m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if(m) return { m: Number(m[1]), d: Number(m[2]) };
  return null;
}
function todayMonthDay_(){
  var t = new Date();
  var s = Utilities.formatDate(t, CFG.TZ, 'M/d').split('/');
  return { m: Number(s[0]), d: Number(s[1]) };
}
function sameMonthDay_(a, b){ return !!a && !!b && a.m === b.m && a.d === b.d; }

// シートの中から「日付列」（月日パターンが一番多く見つかる列。先頭6列だけ調べる）と
// 「ヘッダー行数」（その列で最初に月日パターンが現れる行より上が見出し）を検出する
function detectDayColAndHeaderRows_(v){
  var dayCol = 0, best = -1;
  for(var c = 0; c < Math.min(6, v[0] ? v[0].length : 0); c++){
    var cnt = 0;
    for(var r = 0; r < v.length; r++){ if(cellMonthDay_(v[r][c])) cnt++; }
    if(cnt > best){ best = cnt; dayCol = c; }
  }
  var headerRows = v.length;
  for(var r2 = 0; r2 < v.length; r2++){ if(cellMonthDay_(v[r2][dayCol])){ headerRows = r2; break; } }
  return { dayCol: dayCol, headerRows: headerRows };
}

// 各列の「見出しラベル」を作る：ヘッダー行の範囲内で、その列にある空でないセルを上から順に
// つなげた文字列（多段見出し・結合セルでも、行位置を決め打ちせずに拾える）
function buildColumnLabels_(v, headerRows, dayCol){
  var width = 0;
  for(var r = 0; r < headerRows; r++){ if(v[r] && v[r].length > width) width = v[r].length; }
  var labels = [];
  for(var c = 0; c < width; c++){
    if(c === dayCol) continue;
    var parts = [];
    for(var r2 = 0; r2 < headerRows; r2++){
      var cell = v[r2] ? v[r2][c] : '';
      var t = normText_(cell);
      if(t) parts.push(t);
    }
    var label = parts.join('');
    if(label) labels.push({ c: c, label: label, labelU: normUnit_(label) });
  }
  return labels;
}

// 指定日（省略時は今日）に一致する行番号を返す（無ければ-1）
function findRowByDate_(v, dayCol, dateParam){
  var target = dateParam ? parseMonthDayParam_(dateParam) : todayMonthDay_();
  if(!target) return -1;
  for(var r = 0; r < v.length; r++){
    var md = cellMonthDay_(v[r][dayCol]);
    if(sameMonthDay_(md, target)) return r;
  }
  return -1;
}
// "2026-08-29" or "2026/8/29" or "8/29" 形式のパラメータから月日を取り出す
function parseMonthDayParam_(s){
  s = String(s || '').trim();
  var m = s.match(/(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if(m) return { m: Number(m[2]), d: Number(m[3]) };
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if(m) return { m: Number(m[1]), d: Number(m[2]) };
  return null;
}

// 発注書スプレッドシートを「読み取り専用」で開く（このファイル内では書き込みAPIを絶対に呼ばないこと）
function openOrderSheetReadOnly_(sheetName){
  var ss = SpreadsheetApp.openById(CFG.ORDER_SS_ID);
  return ss.getSheetByName(sheetName);
}

// ============================================================
// 進捗シート（発注書スプレッドシート内・読み取りのみ）：本日の荷造数・残数・合計㎏数などを表示用に返す
//   ?type=progress&date=2026-08-29（省略＝今日）
// ============================================================
function getProgressToday_(params){
  params = params || {};
  var sh = openOrderSheetReadOnly_(CFG.ORDER_PROGRESS_SHEET);
  if(!sh) return { error: 'シート「' + CFG.ORDER_PROGRESS_SHEET + '」が見つかりません（発注書スプレッドシート内）' };
  var v = sh.getDataRange().getValues();
  var meta = detectDayColAndHeaderRows_(v);
  var labels = buildColumnLabels_(v, meta.headerRows, meta.dayCol);
  var row = findRowByDate_(v, meta.dayCol, params.date);
  var keys = (CFG.PROGRESS_KEYWORDS || []).map(normUnit_);
  var columns = [];
  labels.forEach(function(lb){
    var hit = keys.some(function(k){ return lb.labelU.indexOf(k) >= 0; });
    if(!hit) return;
    var val = (row >= 0) ? v[row][lb.c] : '';
    columns.push({ c: lb.c, label: lb.label, value: (typeof val === 'number') ? val : (val || '') });
  });
  return {
    sheet: CFG.ORDER_PROGRESS_SHEET,
    date: params.date || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'),
    rowFound: row >= 0,
    columns: columns
  };
}

// ============================================================
// 発注書シート（読み取りのみ）：「収穫舟数」に相当する列を探して本日の値を返す（表示用）
//   広島は表記が「収穫 舟数」等ブレるため正規化して部分一致で探す。複数ヒットする場合は全部返す
//   （どれが本物か曖昧なままにせず、利用者が見て判断できるようにする）
// ============================================================
function getFunesToday_(params){
  params = params || {};
  var sh = openOrderSheetReadOnly_(CFG.ORDER_MAIN_SHEET);
  if(!sh) return { error: 'シート「' + CFG.ORDER_MAIN_SHEET + '」が見つかりません（発注書スプレッドシート内）' };
  var v = sh.getDataRange().getValues();
  var meta = detectDayColAndHeaderRows_(v);
  var labels = buildColumnLabels_(v, meta.headerRows, meta.dayCol);
  var row = findRowByDate_(v, meta.dayCol, params.date);
  var want = normUnit_(CFG.ORDER_FUNES_KEYWORD || '収穫舟数');
  var matches = [];
  labels.forEach(function(lb){
    if(lb.labelU.indexOf(want) < 0) return;
    var val = (row >= 0) ? v[row][lb.c] : '';
    matches.push({ c: lb.c, label: lb.label, value: (typeof val === 'number') ? val : (val || '') });
  });
  return {
    sheet: CFG.ORDER_MAIN_SHEET,
    date: params.date || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'),
    rowFound: row >= 0,
    matches: matches   // 2件以上あれば要確認（発注書に似た表が複数ある可能性）
  };
}

// ============================================================
// ①⑤ 発注書「発注書」シート：取引先ごとの本日の注文一覧＋集計値（読み取りのみ）
//   実際のシート構成（ユーザー確認済み・2026年度）：
//     取引先名の行＝先頭2〜3列のどこかに西暦(2026)がある行（例：A7セル）
//     区分の行　　＝取引先名の行の1つ下（土付き/土なし/洗い/Mup/C/2S 等）
//     入数の行　　＝取引先名の行の2つ下（3.34, 2, 5, 10 等のkg数）
//   同じ行に「合計／荷造数量／収穫舟数／荷造り舟数／ｽﾄｯｸ舟数／追い送り残数」の集計列もある
// ============================================================
var NZ_EXCLUDE_RE = /合計|ワンベジ|カワカミ|生産者|自社|収穫|荷造り|追い送り|ストック|ｽﾄｯｸ|舟数|残数|入力/;
var NZ_KG_GROUP_RE = /個人注文|その他サンプル/;

// 先頭15行・先頭3列の中から「西暦（2000〜2100）」があるセルを探し、その行を取引先名の行とする
function findOrderNameRow_(v){
  for(var r = 0; r < Math.min(v.length, 15); r++){
    for(var c = 0; c < 3; c++){
      var y = Number(v[r][c]);
      if(y >= 2000 && y <= 2100) return r;
    }
  }
  return -1;
}

// 取引先名の行から、列ごとの{取引先名・区分・入数}を組み立てる（集計列・ワンベジ列は除外）
function buildOrderCols_(v, nameRow){
  var nyusuRow = nameRow + 2;
  var kubunRow = nameRow + 1;
  var cols = [], byName = {}, lastName = '';
  var width = v[nameRow] ? v[nameRow].length : 0;
  for(var c = 2; c < width; c++){
    var nm = normText_(v[nameRow][c]);
    if(nm) lastName = nm;
    var name = lastName;
    if(!name) continue;
    var isKg = NZ_KG_GROUP_RE.test(name);
    if(!isKg && NZ_EXCLUDE_RE.test(name)) continue;
    var nyusu = Number(v[nyusuRow] ? v[nyusuRow][c] : NaN);
    if(!(nyusu > 0)) continue;   // 入数が数値の列だけ＝実際の取引先の商品列
    var kubun = normText_(kubunRow < v.length ? v[kubunRow][c] : '');
    if(kubun === '土なし') kubun = '洗い';
    if(/^[\d.]+$/.test(kubun)) kubun = '';
    if(kubun && !byName[name]) byName[name] = kubun;
    if(isKg){ cols.push({ c:c, name:name, nyusu:nyusu, kubun:'', kgUnit:true }); continue; }
    cols.push({ c:c, name:name, nyusu:nyusu, kubun:kubun });
  }
  return { cols: cols, byName: byName };
}

// ⑤ 本日（または指定日）の取引先別・注文一覧（数量・kg）。あくまで発注書シートの読み取りのみ。
function getNizukuriToday_(params){
  params = params || {};
  var sh = openOrderSheetReadOnly_(CFG.ORDER_MAIN_SHEET);
  if(!sh) return { error: 'シート「' + CFG.ORDER_MAIN_SHEET + '」が見つかりません' };
  var v = sh.getDataRange().getValues();
  var nameRow = findOrderNameRow_(v);
  if(nameRow < 0) return { error: '取引先の見出し行（西暦がある行）が見つかりませんでした' };
  var meta = detectDayColAndHeaderRows_(v);
  var built = buildOrderCols_(v, nameRow);
  var row = findRowByDate_(v, meta.dayCol, params.date);

  var orders = [], totalQty = 0, totalKg = 0;
  if(row >= 0){
    var kgAgg = {}, kgOrder = [];
    built.cols.forEach(function(col){
      var qty = Number(v[row][col.c]) || 0;
      if(qty <= 0) return;
      if(col.kgUnit){
        if(!(col.name in kgAgg)){ kgAgg[col.name] = 0; kgOrder.push(col.name); }
        kgAgg[col.name] += qty * (col.nyusu || 1);
        return;
      }
      var kubun = col.kubun || built.byName[col.name] || '';
      var kg = Math.round(qty * col.nyusu);
      orders.push({ cust: col.name, kubun: kubun, nyusu: col.nyusu, qty: qty, kg: kg });
      totalQty += qty; totalKg += kg;
    });
    kgOrder.forEach(function(nm){
      var kgv = kgAgg[nm]; if(!(kgv > 0)) return;
      kgv = Math.round(kgv * 10) / 10;
      orders.push({ cust: nm, kubun: '', nyusu: 1, qty: kgv, kg: Math.round(kgv), unit: 'kg' });
      totalKg += Math.round(kgv);
    });
  }
  return {
    sheet: CFG.ORDER_MAIN_SHEET,
    date: params.date || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'),
    rowFound: row >= 0,
    orders: orders,
    totalQty: totalQty,
    totalKg: totalKg
  };
}

// ① 取引先名の行にある集計列（合計／荷造数量／収穫舟数／荷造り舟数／ｽﾄｯｸ舟数／追い送り残数）の本日値
function getMainStatsToday_(params){
  params = params || {};
  var sh = openOrderSheetReadOnly_(CFG.ORDER_MAIN_SHEET);
  if(!sh) return { error: 'シート「' + CFG.ORDER_MAIN_SHEET + '」が見つかりません' };
  var v = sh.getDataRange().getValues();
  var nameRow = findOrderNameRow_(v);
  if(nameRow < 0) return { error: '取引先の見出し行が見つかりませんでした' };
  var meta = detectDayColAndHeaderRows_(v);
  var row = findRowByDate_(v, meta.dayCol, params.date);
  var keys = ['荷造り舟数', '収穫舟数', '荷造数量', 'ｽﾄｯｸ舟数', 'ストック舟数', '追い送り残数', '合計'];
  var stats = {};
  var width = v[nameRow] ? v[nameRow].length : 0;
  for(var c = 0; c < width; c++){
    var label = normText_(v[nameRow][c]);
    if(!label) continue;
    for(var k = 0; k < keys.length; k++){
      if(stats.hasOwnProperty(keys[k])) continue;   // 最初に見つかった列を採用
      if(label.indexOf(keys[k]) >= 0){
        var val = (row >= 0) ? v[row][c] : '';
        stats[keys[k]] = (typeof val === 'number') ? val : (val || '');
      }
    }
  }
  return {
    sheet: CFG.ORDER_MAIN_SHEET,
    date: params.date || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'),
    rowFound: row >= 0,
    stats: stats
  };
}

// ============================================================
// ④ 資材管理アプリの「要確認」簡易アラート（読み取りのみ・DATA_SS_ID内のデータから計算）
//   ※今はしきい値方式（残数◯個で警告）の資材だけ判定する簡易版。
//     定期チェック方式（◯日ごと）や発注書連動方式は、資材アプリ本体（shizai.html）の方が正確なので
//     そちらで確認してください（ここでは対応していません）。
// ============================================================
function getShizaiAlerts_(){
  var out = { alerts: [], count: 0 };
  try{
    var state = getShizaiState_();
    var s = JSON.parse(state.json || '{}');
    var materials = s.materials || [];
    var latestByName = {};
    try{
      var stockSh = SpreadsheetApp.openById(CFG.DATA_SS_ID).getSheetByName(CFG.SHIZAI_STOCK_SHEET);
      if(stockSh){
        var sv = stockSh.getDataRange().getValues();
        if(sv.length > 1){
          var lastCol = sv[0].length - 1;
          for(var r = 1; r < sv.length; r++){
            var nm = String(sv[r][0] || ''); if(!nm) continue;
            var val = sv[r][lastCol];
            if(val !== '' && val != null && !isNaN(Number(val))) latestByName[nm] = Number(val);
          }
        }
      }
    }catch(e){}
    materials.forEach(function(m){
      if(m.alertMode === 'threshold' && (m.name in latestByName)){
        var actual = latestByName[m.name];
        if(actual <= Number(m.thresholdQty || 0)){
          out.alerts.push({ name: m.name, unit: m.unit || '', actual: actual, thresholdQty: Number(m.thresholdQty || 0) });
        }
      }
    });
    out.count = out.alerts.length;
  }catch(e){ out.error = String(e); }
  return out;
}

// ============================================================
// ①「進捗シートへ数字を飛ばす」機能・段階1（試験運用）
//   電子黒板から入力した値は、発注書スプレッドシートには一切書かず、
//   CFG.DATA_SS_ID の「進捗テスト」シートにだけ記録する。
//   保存形：日付ごとに1行。列＝日付／更新日時／端末／(見出しラベル)ごとの値（JSON1セル）
// ============================================================
function progressTestSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.PROGRESS_TEST_SHEET || '進捗テスト';
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(['日付', '更新日時', '端末', '入力内容(JSON)']);
    try{ sh.setFrozenRows(1); }catch(e){}
  }
  return sh;
}
function progressTestGet_(params){
  params = params || {};
  var date = String(params.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var sh = progressTestSheet_();
  var last = sh.getLastRow();
  if(last < 2) return { date: date, entries: {}, savedAt: '', by: '' };
  var v = sh.getRange(2, 1, last - 1, 4).getValues();
  for(var i = v.length - 1; i >= 0; i--){   // 同じ日付は最後に保存した行を採用
    var d0 = v[i][0];
    var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
    if(dstr !== date) continue;
    var entries = {};
    try{ entries = JSON.parse(v[i][3] || '{}'); }catch(e){ entries = {}; }
    return { date: date, entries: entries, savedAt: String(v[i][1] || ''), by: String(v[i][2] || '') };
  }
  return { date: date, entries: {}, savedAt: '', by: '' };
}
function progressTestSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var date = String(body.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    var now  = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    var entries = (body.entries && typeof body.entries === 'object') ? body.entries : {};
    var sh = progressTestSheet_();
    // 「日付」列を文字列固定にして保存（Date型化によるTZずれを防ぐ）
    sh.appendRow([date, now, String(body.by || ''), JSON.stringify(entries)]);
    var last = sh.getLastRow();
    sh.getRange(last, 1).setNumberFormat('@').setValue(date);
    return { ok:true, date: date, savedAt: now };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ============================================================
// ② 生産者：持ち込み舟数・出来高の記録（センターと同じデータ形。保存先はDATA_SS_ID内のみ）
//   列＝日付/時間帯/生産者/区分/サイズkg/舟数/出来高kg/更新日時
// ============================================================
function seisanSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.SEISAN_SHEET || '生産者記録';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['日付','時間帯','生産者','区分','サイズkg','舟数','出来高kg','更新日時']); try{ sh.setFrozenRows(1); }catch(e){} }
  return sh;
}
function seisanGet_(params){
  params = params || {};
  var sh = seisanSheet_();
  var date = String(params.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var v = sh.getDataRange().getValues();
  var map = {}, order = [], totalFunes = 0, totalKg = 0;
  for(var r = 1; r < v.length; r++){
    var d0 = v[r][0];
    var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
    if(dstr !== date) continue;
    var ampm = String(v[r][1] || 'AM').trim().toUpperCase(); if(ampm !== 'PM') ampm = 'AM';
    var name = String(v[r][2] || '').trim(); if(!name) continue;
    var grp  = String(v[r][3] || '').trim();
    var size = Number(v[r][4]) || 0;
    var funes = Number(v[r][5]) || 0;
    var kg    = Number(v[r][6]); if(!kg) kg = funes * size;
    var mk = ampm + '|' + name;
    if(!map[mk]){ map[mk] = { name:name, ampm:ampm, rows:{}, funes:0 }; order.push(mk); }
    if(grp === '収穫舟数'){ map[mk].funes = funes; continue; }
    if(size > 0 && funes > 0) map[mk].rows[grp + '|' + size] = funes;
    totalFunes += funes; totalKg += kg;
  }
  return { date: date, list: order.map(function(k){ return map[k]; }), totalFunes: totalFunes, totalKg: Math.round(totalKg*10)/10 };
}
function seisanSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(20000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var sh = seisanSheet_();
    var HEAD = ['日付','時間帯','生産者','区分','サイズkg','舟数','出来高kg','更新日時'];
    var date = String(body.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    var now  = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm');
    var list = (body.list instanceof Array) ? body.list : [];

    var data = sh.getDataRange().getValues();
    var kept = [ (data.length ? data[0] : HEAD) ];
    for(var i = 1; i < data.length; i++){
      var d0 = data[i][0];
      var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
      if(dstr !== date) kept.push(data[i]);
    }
    var rowsN = 0, totalFunes = 0, totalKg = 0;
    list.forEach(function(p){
      var name = String(p.name || '').trim(); if(!name) return;
      var ampm = (String(p.ampm||'AM').toUpperCase() === 'PM') ? 'PM' : 'AM';
      var rows = (p.rows && typeof p.rows === 'object') ? p.rows : {};
      Object.keys(rows).forEach(function(key){
        var funes = Number(rows[key]) || 0; if(funes <= 0) return;
        var parts = String(key).split('|');
        var grp  = parts[0] || '';
        var size = Number(parts[1]) || 0;
        var kg = funes * size;
        kept.push([date, ampm, name, grp, size, funes, Math.round(kg*10)/10, now]);
        rowsN++; totalFunes += funes; totalKg += kg;
      });
      var pf = Number(p.funes) || 0;
      if(pf > 0){ kept.push([date, ampm, name, '収穫舟数', 0, pf, 0, now]); rowsN++; }
    });
    sh.clearContents();
    sh.getRange(1, 1, kept.length, HEAD.length).setValues(kept.map(function(r){
      var a = r.slice(0, HEAD.length); while(a.length < HEAD.length) a.push(''); return a;
    }));
    return { ok:true, saved: rowsN, date: date, totalFunes: totalFunes, totalKg: Math.round(totalKg*10)/10 };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ============================================================
// ③ 資材管理アプリ：クラウド共有ストレージ（1シートにデータ一式を保存。DATA_SS_ID内のみ）
//   レイアウト（「資材データ」シート）：
//     B1=rev（更新のたび+1） / B2=savedAt / B3=savedBy(端末名) / B4=chunks（分割数）
//     A5〜 ＝ JSON文字列を45000字ごとに分割して縦に格納
// ============================================================
function shizaiSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.SHIZAI_SHEET || '資材データ';
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.getRange('A1').setValue('rev');     sh.getRange('B1').setValue(0);
    sh.getRange('A2').setValue('savedAt'); sh.getRange('B2').setValue('');
    sh.getRange('A3').setValue('savedBy'); sh.getRange('B3').setValue('');
    sh.getRange('A4').setValue('chunks');  sh.getRange('B4').setValue(0);
  }
  return sh;
}
function getShizaiMeta_(){
  var sh = shizaiSheet_();
  return {
    rev:     Number(sh.getRange('B1').getValue()) || 0,
    savedAt: String(sh.getRange('B2').getValue() || ''),
    savedBy: String(sh.getRange('B3').getValue() || '')
  };
}
function getShizaiState_(){
  var sh = shizaiSheet_();
  var rev    = Number(sh.getRange('B1').getValue()) || 0;
  var chunks = Number(sh.getRange('B4').getValue()) || 0;
  var json = '';
  if(chunks > 0){
    var vals = sh.getRange(5, 1, chunks, 1).getValues();
    for(var i = 0; i < vals.length; i++) json += String(vals[i][0] || '');
  }
  return {
    rev: rev,
    savedAt: String(sh.getRange('B2').getValue() || ''),
    savedBy: String(sh.getRange('B3').getValue() || ''),
    json: json
  };
}
function saveShizaiState_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(20000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var sh  = shizaiSheet_();
    var cur = Number(sh.getRange('B1').getValue()) || 0;
    var base = Number(body.rev);
    if(!body.force && !isNaN(base) && base !== cur){
      return { ok:false, conflict:true, rev:cur, savedBy:String(sh.getRange('B3').getValue()||''), savedAt:String(sh.getRange('B2').getValue()||'') };
    }
    var json = String(body.json || '');
    var oldChunks = Number(sh.getRange('B4').getValue()) || 0;
    if(oldChunks > 0) sh.getRange(5, 1, oldChunks, 1).clearContent();
    var size = 45000, parts = [];
    for(var i = 0; i < json.length; i += size) parts.push(json.substr(i, size));
    if(parts.length === 0) parts = [''];
    var newRev = cur + 1;
    var now = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    sh.getRange('B1').setValue(newRev);
    sh.getRange('B2').setValue(now);
    sh.getRange('B3').setValue(String(body.by || ''));
    sh.getRange('B4').setValue(parts.length);
    var out = []; for(var j = 0; j < parts.length; j++) out.push([parts[j]]);
    sh.getRange(5, 1, parts.length, 1).setValues(out);
    return { ok:true, rev:newRev, savedAt:now };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ============================================================
// ③ 資材管理アプリ：月末バックアップ（世代保存・追記のみ＝上書きしない。DATA_SS_ID内のみ）
//   「資材バックアップ」シート：A=対象月/日 / B=保存日時 / C=保存端末 / D=文字数 / E=分割数 / F〜=JSON
// ============================================================
function shizaiBackupSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.SHIZAI_BACKUP_SHEET || '資材バックアップ';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['対象月', '保存日時', '保存端末', '文字数', '分割数', 'JSON→']); }
  return sh;
}
function saveShizaiBackup_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(20000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var sh = shizaiBackupSheet_();
    var json    = String(body.json || '');
    var month   = String(body.month || '');
    var savedAt = String(body.savedAt || '') || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    var by      = String(body.by || body.savedBy || '');
    var size = 45000, parts = [];
    for(var i = 0; i < json.length; i += size) parts.push(json.substr(i, size));
    if(parts.length === 0) parts = [''];
    var row = [month, savedAt, by, json.length, parts.length].concat(parts);
    sh.appendRow(row);
    var colLabel = String(body.date || '') || month;
    try{ writeStocktakeTable_(colLabel, body.stock); }catch(e){}
    return { ok:true, month:month, savedAt:savedAt, rows:sh.getLastRow() };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}
function writeStocktakeTable_(colLabel, stock){
  colLabel = String(colLabel || '');
  if(!colLabel || !stock) return;
  var rows = (typeof stock === 'string') ? JSON.parse(stock) : stock;
  if(!rows || !rows.length) return;
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.SHIZAI_STOCK_SHEET || '月末棚卸（実数）';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['資材', '単位']); }
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var col = -1;
  for(var c = 2; c < header.length; c++){ if(headerNorm_(header[c], colLabel) === colLabel){ col = c + 1; break; } }
  if(col < 0){ col = lastCol + 1; sh.getRange(1, col).setNumberFormat('@').setValue(colLabel); }
  var names = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 1).getValues() : [];
  var rowOf = {};
  for(var i = 0; i < names.length; i++){ var nm = String(names[i][0] || ''); if(nm) rowOf[nm] = i + 2; }
  var nextRow = (lastRow > 1 ? lastRow : 1) + 1;
  for(var k = 0; k < rows.length; k++){
    var r = rows[k]; var nm = String(r.name || ''); if(!nm) continue;
    var rr = rowOf[nm];
    if(!rr){ rr = nextRow++; sh.getRange(rr, 1).setValue(nm); sh.getRange(rr, 2).setValue(r.unit || ''); rowOf[nm] = rr; }
    sh.getRange(rr, col).setValue(r.actual);
  }
}
function headerNorm_(x, label){
  if(x instanceof Date){
    var isDate = (String(label || '').length > 7);
    return Utilities.formatDate(x, CFG.TZ, isDate ? 'yyyy-MM-dd' : 'yyyy-MM');
  }
  return String(x || '').trim();
}
function getShizaiBackupList_(){
  var sh = shizaiBackupSheet_();
  var last = sh.getLastRow();
  if(last < 2) return { list: [] };
  var vals = sh.getRange(2, 1, last - 1, 5).getValues();
  var map = {};
  for(var i = 0; i < vals.length; i++){
    var m = String(vals[i][0] || ''); if(!m) continue;
    map[m] = { month:m, savedAt:String(vals[i][1]||''), savedBy:String(vals[i][2]||''), size:Number(vals[i][3])||0, row:i+2 };
  }
  var list = Object.keys(map).map(function(k){ return map[k]; });
  list.sort(function(a,b){ return a.month < b.month ? 1 : (a.month > b.month ? -1 : 0); });
  return { list: list };
}
function getShizaiBackup_(params){
  var month = String((params && params.month) || '');
  if(!month) return { error:'month を指定してください' };
  var sh = shizaiBackupSheet_();
  var last = sh.getLastRow();
  if(last < 2) return { error:'バックアップがありません' };
  var months = sh.getRange(2, 1, last - 1, 1).getValues();
  var target = -1;
  for(var i = 0; i < months.length; i++){ if(String(months[i][0]||'') === month) target = i + 2; }
  if(target < 0) return { error:'その月のバックアップが見つかりません' };
  var chunks = Number(sh.getRange(target, 5).getValue()) || 0;
  var json = '';
  if(chunks > 0){
    var cv = sh.getRange(target, 6, 1, chunks).getValues()[0];
    for(var j = 0; j < cv.length; j++) json += String(cv[j] || '');
  }
  return {
    month: month,
    savedAt: String(sh.getRange(target, 2).getValue() || ''),
    savedBy: String(sh.getRange(target, 3).getValue() || ''),
    json: json
  };
}

// ============================================================
// ③ 資材管理アプリ：期間内の使用量集計（進捗シートを読み取りのみで参照。書き込みはしない）
//   進捗シートの列見出しに「荷造数」を含む列を全て拾い、指定期間で合計する。
//   列見出しがそのままSKU名になる（取引先/規格を厳密に分解できない見出し構造のため、
//   見出し文字列をそのままキーにすることで誤集計のリスクを避ける）。
//   ?type=shizaiUsage&start=2026-08-01&end=2026-08-31
// ============================================================
function getShizaiUsage_(params){
  params = params || {};
  var sh = openOrderSheetReadOnly_(CFG.ORDER_PROGRESS_SHEET);
  if(!sh) return { error: 'シート「' + CFG.ORDER_PROGRESS_SHEET + '」が見つかりません' };
  var v = sh.getDataRange().getValues();
  var meta = detectDayColAndHeaderRows_(v);
  var labels = buildColumnLabels_(v, meta.headerRows, meta.dayCol);
  var targets = labels.filter(function(lb){ return lb.labelU.indexOf('荷造数') >= 0; });

  var startYmd = parseYmdLoose_(params.start);
  var endYmd   = parseYmdLoose_(params.end);
  var sums = {};
  targets.forEach(function(t){ sums[t.label] = 0; });
  for(var r = meta.headerRows; r < v.length; r++){
    var md = cellMonthDay_(v[r][meta.dayCol]);
    if(!md) continue;
    if(!inRangeLoose_(md, startYmd, endYmd)) continue;
    targets.forEach(function(t){
      var val = Number(v[r][t.c]);
      if(!isNaN(val)) sums[t.label] += val;
    });
  }
  return { start: params.start || '', end: params.end || '', usage: sums };
}
function parseYmdLoose_(s){
  s = String(s || '').trim();
  var m = s.match(/(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  return m ? { m: Number(m[2]), d: Number(m[3]) } : null;
}
// 年をまたぐ月日は考慮せず、単純に「開始<=対象<=終了」を月日だけで比較（同一年度内の利用を想定）
function inRangeLoose_(md, start, end){
  var v = md.m * 100 + md.d;
  var lo = start ? start.m * 100 + start.d : -1;
  var hi = end ? end.m * 100 + end.d : 9999;
  return v >= lo && v <= hi;
}

// ============================================================
// 診断用：デプロイ後にこの結果を見て、シート名・列検出が想定通りか確認する
//   ?type=debug
// ============================================================
function debugTop_(){
  var out = { orderSheetNames: [], dataSheetNames: [] };
  try{
    var orderSs = SpreadsheetApp.openById(CFG.ORDER_SS_ID);
    out.orderSheetNames = orderSs.getSheets().map(function(s){ return s.getName(); });
  }catch(e){ out.orderSheetError = String(e); }
  try{
    var dataSs = SpreadsheetApp.openById(CFG.DATA_SS_ID);
    out.dataSheetNames = dataSs.getSheets().map(function(s){ return s.getName(); });
  }catch(e){ out.dataSheetError = String(e); }

  try{
    var mainSh = openOrderSheetReadOnly_(CFG.ORDER_MAIN_SHEET);
    if(mainSh){
      var mv = mainSh.getDataRange().getValues();
      var mMeta = detectDayColAndHeaderRows_(mv);
      out.main = {
        dayCol: mMeta.dayCol, headerRows: mMeta.headerRows,
        top15Rows: mv.slice(0, Math.min(15, mv.length)),
        labels: buildColumnLabels_(mv, mMeta.headerRows, mMeta.dayCol).map(function(l){ return l.label; })
      };
    }
  }catch(e){ out.mainError = String(e); }

  try{
    var progSh = openOrderSheetReadOnly_(CFG.ORDER_PROGRESS_SHEET);
    if(progSh){
      var pv = progSh.getDataRange().getValues();
      var pMeta = detectDayColAndHeaderRows_(pv);
      out.progress = {
        dayCol: pMeta.dayCol, headerRows: pMeta.headerRows,
        top15Rows: pv.slice(0, Math.min(15, pv.length)),
        labels: buildColumnLabels_(pv, pMeta.headerRows, pMeta.dayCol).map(function(l){ return l.label; })
      };
    }
  }catch(e){ out.progressError = String(e); }

  return out;
}

// ============================================================
// エディタから▶実行して確認するためのテスト関数群
// ============================================================
function testDebug(){ Logger.log(JSON.stringify(debugTop_(), null, 2)); }
function testProgress(){ Logger.log(JSON.stringify(getProgressToday_({}), null, 2)); }
function testFunes(){ Logger.log(JSON.stringify(getFunesToday_({}), null, 2)); }
function testBundle(){ Logger.log(JSON.stringify(getBundle_({}), null, 2)); }
function testNizukuri(){ Logger.log(JSON.stringify(getNizukuriToday_({}), null, 2)); }
function testMainStats(){ Logger.log(JSON.stringify(getMainStatsToday_({}), null, 2)); }
function testShizaiAlerts(){ Logger.log(JSON.stringify(getShizaiAlerts_(), null, 2)); }
