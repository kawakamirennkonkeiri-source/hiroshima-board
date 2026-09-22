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
  HOJO_SHEET: '圃場舟数',                // ⑧ 圃場（畑）から持ってきた舟数（保存先はDATA_SS_IDのみ）
  // ⑧ 圃場名の自動取り込み元：「【広島】朝礼ボード_データ」スプレッドシート（曽我さん指定・2026-09-22）。
  //   A列＝日付・B列＝圃場名。読み取り専用（書き込みは絶対にしない）。gidでシートを特定（名前変更に強くするため）。
  HOJO_SOURCE_SS_ID: '1qGvDOVIWCzs1bsNFgLWIXNZ-h7Lghh1_2W1ofHfU0j4',
  HOJO_SOURCE_GID: 132351016,
  SHIZAI_SHEET: '資材データ',            // ③ 資材管理アプリ：クラウド共有データ本体
  SHIZAI_BACKUP_SHEET: '資材バックアップ', // ③ 月末棚卸ごとの世代バックアップ（追記のみ）
  SHIZAI_STOCK_SHEET: '月末棚卸（実数）',  // ③ 人が読める実数の表

  // ⑥ シフト連携（本日出勤人数・配置図）：シフト表本体はDATA_SS_ID内「R◯年◯月」シート
  //   （年度が変わるとシート名が変わる＝センターv2と同じ罠。動的に探す。CFGに固定シート名は持たない）
  HAICHI_ZONES: [
    { id:'nagashi',   label:'流し' },
    { id:'conveyor',  label:'はつり' },
    { id:'shiwake',   label:'仕分け' },
    { id:'shiwake_h', label:'仕分け補助' },
    { id:'hakoire',   label:'箱入れ' },
    { id:'pallet',    label:'パレット' },
    { id:'hakoori',   label:'箱織' }
  ],
  HAICHI_DEFAULT_CAPACITY: { conveyor: 4 },   // 未設定ゾーンは既定2（後述の関数側で補完）
  HAICHI_SKILL_SHEET: '力量表',      // ⑥ 氏名×ゾーンの○/△/×（直接スプレッドシート編集で調整）
  HAICHI_PRIO_SHEET: '配置優先',     // ⑨ 氏名×ゾーンの自動配置の優先番号（1が最優先・×は配置不可・空欄は最後回し）。アプリから編集可能
  HAICHI_CFG_SHEET: '配置設定',      // ⑥ ゾーンID/表示名/定員（直接スプレッドシート編集で調整）
  HAICHI_STATE_SHEET: '配置図状態',  // ⑥ 本日の配置・欠勤上書き・応援追加（JSON1行/日付）

  // ⑦ 本日荷造りの状態管理・生産ログ・NEW判定（センター電子黒板の同機能を広島の規模に合わせて移植）
  NZ_STATE_SHEET: '本日荷造り状態',      // 状態(確定/作成済み)・総舟数の当日上書き（JSON1行/日付）
  NZ_LOG_SHEET: '本日荷造り生産ログ',    // 生産日ごとの「本日作った分」upsertログ（日付を跨いで蓄積）
  NZ_SNAP_SHEET: '本日荷造りスナップショット', // NEW判定用の前回スナップショット（upsert・7日超は間引き）
  NZ_SNAP_KEEP_DAYS: 7,
  NZ_WORK_START: '07:00',
  NZ_WORK_BREAKS: [['08:30','09:00'], ['10:00','10:15'], ['12:00','13:00'], ['14:00','14:15']],
  // 広島の実データでの区分(kubun)は「洗い」「Mup」「C」「2S」等（?type=nizukuriで確認済み・2026-09-19）。
  // センターの「区分が"C/S"の1トークン」とは表記が違うため広島専用の判定にする。
  NZ_CS_KUBUN_RE: /^(C|\d*S)$/,
  // ⑦-b 本日荷造りタブの表示ウィンドウ（何日分・起点日）を全PC共有するためのキー（PropertiesService）
  NZ_VIEW_PROP_KEY: 'NZ_VIEW_STATE',
  NZ_VIEW_MAX_DAYS: 14,

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
    else if(type === 'shift')        out = getHiroshimaShiftToday_(e.parameter);   // ⑥ 本日出勤人数
    else if(type === 'haichiGet')    out = getHaichiGet_(e.parameter);             // ⑥ 配置図
    else if(type === 'debugShift')   out = debugShift_(e.parameter);               // ⑥ 診断用
    else if(type === 'nizukuriFull') out = getNizukuriFull_(e.parameter);          // ⑦ 状態管理・生産ログ・実績計算つきの本日荷造り
    else if(type === 'nizukuriFullDays') out = getNizukuriFullDays_(e.parameter);  // ⑦-b 表示ウィンドウぶん（複数日）をまとめて取得
    else if(type === 'nzViewGet')    out = nzViewGet_();                           // ⑦-b 本日荷造りタブの表示ウィンドウ（全PC共有）
    else if(type === 'hojoGet')      out = hojoGet_(e.parameter);                  // ⑧ 圃場（畑）から持ってきた舟数
    else if(type === 'debugHojoSource') out = debugHojoSource_(e.parameter);       // ⑧ 診断用：朝礼ボード連携
    else if(type === 'progressByClient') out = getProgressByClient_(e.parameter);  // 🔍 進捗差分：発注書「進捗」シートの取引先別荷造数
    else if(type === 'debugProgress') out = debugProgress_(e.parameter);           // 🔍 診断用
    else if(type === 'bundle')       out = getBundle_(e.parameter);
    else if(type === 'debug')        out = debugTop_();
    else if(type === 'debugOrder')   out = debugOrder_(e.parameter);
    else out = { error:'type を progress / funes / progressTestGet / seisanGet / nizukuri / mainStats / shizaiAlerts / shizaiLoad / shizaiMeta / shizaiBackupList / shizaiBackupGet / shizaiUsage / shift / haichiGet / nizukuriFull / nizukuriFullDays / nzViewGet / hojoGet / progressByClient / bundle / debug のいずれかで指定してください' };
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
    else if(action === 'haichiSave')       out = haichiSave_(body);   // ⑥ 配置図：本日の配置・欠勤上書き・応援追加
    else if(action === 'haichiSkillSave')  out = haichiSkillSave_(body); // ⑥ 力量表：○/△/×をアプリから編集
    else if(action === 'haichiPrioSave')   out = haichiPrioSave_(body); // ⑨ 配置優先：優先番号をアプリから編集
    else if(action === 'haichiZoneCfgSave') out = haichiZoneCfgSave_(body); // ⑩ ゾーン設定：定員をアプリから編集
    else if(action === 'nizukuriStateSave') out = nzStateSave_(body);  // ⑦ 状態(確定/作成済み)・総舟数の当日上書き
    else if(action === 'nizukuriMadeSave')  out = nzMadeSave_(body);   // ⑦ 本日作った分（生産ログupsert）
    else if(action === 'nzViewSave')        out = nzViewSave_(body);  // ⑦-b 本日荷造りタブの表示ウィンドウ（全PC共有）
    else if(action === 'hojoSave')          out = hojoSave_(body);    // ⑧ 圃場（畑）から持ってきた舟数
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
    nizukuri:     safe(function(){ return getNizukuriFull_(params); }),   // ⑦ 状態管理・生産ログ・実績計算つき（本日のみ・電子黒板ホーム用）
    // ⑦-b 本日荷造りタブの表示ウィンドウ（何日分・起点日）だけ全PC共有用にbundleへ相乗り（軽量値）。
    //   注文データ自体（nizukuriFullDays＝発注書シートの重い読み取り）は配置図/生産者タブと同様、
    //   本日荷造りタブを開いている時だけ個別に取得する（30秒バンドルの対象に入れると全画面で
    //   毎回コストがかかるため）。
    nzView:       safe(function(){ return nzViewGet_(); }),
    mainStats:    safe(function(){ return getMainStatsToday_(params); }),
    shizaiAlerts: safe(function(){ return getShizaiAlerts_(); }),
    shift:        safe(function(){ return getHiroshimaShiftToday_(params); }),
    hojo:         safe(function(){ return hojoGet_(params); }),                // ⑧ 舟数モニター・歩留まりの分母に使用
    progressByClient: safe(function(){ return getProgressByClient_(params); }) // 🔍 進捗差分タブ用
    // ⚠配置図（haichiGet/haichiSave）は生産者タブと同様、タブを開いた時だけ読み込む＝
    //   30秒バンドルポーリングの対象には含めない（負荷を増やさないため）
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
  // c=0は日付列。取引先名の先頭（例：ハローズ）はc=1から始まるため、c=1から見る
  //   （c=2からにすると、最初の取引先の1列目がまるごと抜け落ちる＝debugOrderで発覚した不具合）
  for(var c = 1; c < width; c++){
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

// ⑤ 診断用：nizukuriが空になる原因調査（本番運用には使わない）
//   ?type=debugOrder&date=... → nameRow・検出できた列数・列の中身（先頭20件）・本日行の生データを返す
function debugOrder_(params){
  params = params || {};
  var sh = openOrderSheetReadOnly_(CFG.ORDER_MAIN_SHEET);
  if(!sh) return { error: 'シート「' + CFG.ORDER_MAIN_SHEET + '」が見つかりません' };
  var v = sh.getDataRange().getValues();
  var nameRow = findOrderNameRow_(v);
  if(nameRow < 0) return { error: '取引先の見出し行が見つかりませんでした' };
  var meta = detectDayColAndHeaderRows_(v);
  var row = findRowByDate_(v, meta.dayCol, params.date);
  var nyusuRow = nameRow + 2, kubunRow = nameRow + 1;
  var width = v[nameRow] ? v[nameRow].length : 0;

  // フィルタ前の生データ（列ごとに：取引先名候補・区分候補・入数候補・本日の値）を先頭30列だけ
  var raw = [];
  var lastName = '';
  for(var c = 1; c < Math.min(width, 30); c++){
    var nm = normText_(v[nameRow][c]);
    if(nm) lastName = nm;
    raw.push({
      c: c,
      nameCell: v[nameRow][c],
      nameCarried: lastName,
      kubunCell: v[kubunRow] ? v[kubunRow][c] : null,
      nyusuCell: v[nyusuRow] ? v[nyusuRow][c] : null,
      todayVal: (row >= 0) ? v[row][c] : null
    });
  }
  var built = buildOrderCols_(v, nameRow);
  return {
    nameRow: nameRow, nyusuRow: nyusuRow, kubunRow: kubunRow,
    dayCol: meta.dayCol, rowFound: row >= 0, rowIndex: row,
    builtColsCount: built.cols.length,
    builtColsSample: built.cols.slice(0, 20),
    rawFirst30Cols: raw
  };
}

// ============================================================
// ⑦ 本日荷造り：状態管理（未確定/確定/作成済み）・生産ログ（本日作った分）・NEW判定・実績計算
//   センター電子黒板の同機能を広島の規模（1日表示のみ）に合わせて移植。発注書へは一切書き込まない
//   （読み取りは既存のgetNizukuriToday_/getFunesToday_/getProgressToday_/seisanGet_のみ流用）。
// ============================================================
function nzOrderKey_(date, o){
  return date + '|' + (o.cust || '') + '|' + (o.kubun || '') + '|' + (o.nyusu || 0);
}

// ---- 状態（未確定/確定/作成済み）・総舟数の当日上書き。「その日付だけ入れ替え」方式 ----
function nzStateSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.NZ_STATE_SHEET || '本日荷造り状態';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['日付', '更新日時', '端末', '入力内容(JSON)']); try{ sh.setFrozenRows(1); }catch(e){} }
  return sh;
}
function nzStateRead_(date){
  var sh = nzStateSheet_();
  var last = sh.getLastRow();
  if(last < 2) return { status: {}, targetOverride: null };
  var v = sh.getRange(2, 1, last - 1, 4).getValues();
  for(var i = v.length - 1; i >= 0; i--){
    var d0 = v[i][0];
    var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
    if(dstr !== date) continue;
    try{
      var p = JSON.parse(v[i][3] || '{}');
      return { status: p.status || {}, targetOverride: (typeof p.targetOverride === 'number') ? p.targetOverride : null };
    }catch(e){ return { status: {}, targetOverride: null }; }
  }
  return { status: {}, targetOverride: null };
}
function nzStateSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var date = String(body.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    var now  = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    var payload = {
      status: (body.status && typeof body.status === 'object') ? body.status : {},
      targetOverride: (body.targetOverride === null || body.targetOverride === undefined) ? null : (Number(body.targetOverride) || 0)
    };
    var sh = nzStateSheet_();
    var data = sh.getDataRange().getValues();
    var kept = [ data.length ? data[0] : ['日付', '更新日時', '端末', '入力内容(JSON)'] ];
    for(var i = 1; i < data.length; i++){
      var d0 = data[i][0];
      var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
      if(dstr !== date) kept.push(data[i]);
    }
    kept.push([date, now, String(body.by || ''), JSON.stringify(payload)]);
    sh.clearContents();
    sh.getRange(1, 1, kept.length, 4).setValues(kept.map(function(r){ var a = r.slice(0, 4); while(a.length < 4) a.push(''); return a; }));
    return { ok:true, date: date, savedAt: now };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ---- 生産ログ（本日作った分。日付を跨いで蓄積＝upsert方式。前日作成(累計)の計算根拠） ----
function nzLogSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.NZ_LOG_SHEET || '本日荷造り生産ログ';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['キー', '生産日', '納品日', '取引先', '区分', '入数', '数量cs', '更新日時', '端末']); try{ sh.setFrozenRows(1); }catch(e){} }
  return sh;
}
// 全件読み込み→ {orderKey: {生産日: cases}} のマップ（前日作成(累計)＝本日以外の合計、で使う）
function nzLogReadAll_(){
  var sh = nzLogSheet_();
  var last = sh.getLastRow();
  var map = {};
  if(last < 2) return map;
  var v = sh.getRange(2, 1, last - 1, 7).getValues();
  for(var i = 0; i < v.length; i++){
    var key = String(v[i][0] || ''); if(!key) continue;
    var prodDate = String(v[i][1] || '');
    var cases = Number(v[i][6]) || 0;
    if(!map[key]) map[key] = {};
    map[key][prodDate] = cases;
  }
  return map;
}
function nzMadeSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var ddate    = String(body.date || '').trim();                       // 納品日（＝注文キーの日付）
    var prodDate = String(body.prodDate || '').trim() || ddate;          // 省略時は納品日=本日扱い
    var cust  = String(body.cust  || '').trim();
    var kubun = String(body.kubun || '').trim();
    var nyusu = Number(body.nyusu) || 0;
    var cases = Math.max(0, Math.round(Number(body.cases) || 0));
    var by    = String(body.by || '').trim();
    if(!ddate || !cust) return { ok:false, error:'date と cust は必須です' };
    var key = ddate + '|' + cust + '|' + kubun + '|' + nyusu;
    var now = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    var sh = nzLogSheet_();
    var row = [key, prodDate, ddate, cust, kubun, nyusu, cases, now, by];
    var last = sh.getLastRow(), found = -1;
    if(last >= 2){
      var keys  = sh.getRange(2, 1, last - 1, 1).getValues();
      var prods = sh.getRange(2, 2, last - 1, 1).getValues();
      for(var i = 0; i < keys.length; i++){
        if(String(keys[i][0]) === key && String(prods[i][0]) === prodDate){ found = i + 2; break; }
      }
    }
    if(found > 0){ sh.getRange(found, 1, 1, row.length).setValues([row]); }
    else{ sh.appendRow(row); found = sh.getLastRow(); }
    // 生産日・納品日は文字列固定で保存（Date型化によるTZずれで前日に見える事故を防ぐ）
    sh.getRange(found, 2, 1, 2).setNumberFormat('@').setValues([[prodDate, ddate]]);
    return { ok:true, key: key, prodDate: prodDate, savedAt: now };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ---- NEW判定（前回スナップショットと比較。初回実行は基準化のみ＝NEW扱いにしない） ----
function nzSnapSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.NZ_SNAP_SHEET || '本日荷造りスナップショット';
  var sh = ss.getSheetByName(name);
  var firstEver = false;
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['キー', '数量', '検知日時', '取引先区分']); try{ sh.setFrozenRows(1); }catch(e){} firstEver = true; }
  return { sh: sh, firstEver: firstEver };
}
function nzMarkNew_(date, orders){
  var t = nzSnapSheet_(), sh = t.sh;
  var data = sh.getDataRange().getValues();
  var firstEver = t.firstEver || data.length <= 1;
  var snap = {};
  for(var i = 1; i < data.length; i++){
    var k = String(data[i][0] || ''); if(!k) continue;
    var ca = data[i][2];
    var caMs = (ca instanceof Date) ? ca.getTime() : (ca ? Date.parse(ca) : 0);
    snap[k] = { qty: Number(data[i][1]) || 0, changedAt: caMs || 0, memo: String(data[i][3] || '') };
  }
  var now = Date.now();
  var newWindowMs = 12 * 60 * 60 * 1000;
  orders.forEach(function(o){
    var key = nzOrderKey_(date, o);
    var prev = snap[key], changedAt;
    if(firstEver){ changedAt = 0; }
    else if(!prev){ changedAt = now; }
    else if(prev.qty !== (o.qty || 0)){ changedAt = now; }
    else{ changedAt = prev.changedAt || 0; }
    snap[key] = { qty: o.qty || 0, changedAt: changedAt, memo: o.cust + (o.kubun ? '(' + o.kubun + ')' : '') };
    o.isNew = !!(changedAt && (now - changedAt) < newWindowMs);
  });
  var cutoffMs = now - (CFG.NZ_SNAP_KEEP_DAYS || 7) * 24 * 60 * 60 * 1000;
  var out = [['キー', '数量', '検知日時', '取引先区分']];
  Object.keys(snap).forEach(function(k){
    var dms = Date.parse(k.split('|')[0]);
    if(dms && dms < cutoffMs) return;   // 古いスナップショットは保存のたびに間引く
    var s = snap[k];
    out.push([k, s.qty, s.changedAt ? new Date(s.changedAt).toISOString() : '', s.memo]);
  });
  sh.clearContents();
  sh.getRange(1, 1, out.length, 4).setValues(out);
}

// ---- 実績計算：終了目標時刻（総舟数÷(人数×2舟/時)を開始7:00・休憩4本を除いて計算） ----
function nzWtMin_(hhmm){ var p = String(hhmm).split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); }
function nzWorkPeriods_(){
  var startMin = nzWtMin_(CFG.NZ_WORK_START || '07:00');
  var endMin = 23 * 60 + 59;
  var breaks = (CFG.NZ_WORK_BREAKS || []).map(function(b){ return [nzWtMin_(b[0]), nzWtMin_(b[1])]; }).sort(function(a, b){ return a[0] - b[0]; });
  var out = [], t = startMin;
  breaks.forEach(function(b){ if(b[0] > t) out.push([t, Math.min(b[0], endMin)]); t = Math.max(t, b[1]); });
  if(t < endMin) out.push([t, endMin]);
  return out.filter(function(p){ return p[1] > p[0]; });
}
function nzFmtMin_(m){ var hh = Math.floor(m / 60), mm = Math.round(m - hh * 60); if(mm >= 60){ hh++; mm -= 60; } return ('0' + hh).slice(-2) + ':' + ('0' + mm).slice(-2); }
function nzCalcFinish_(totalFunes, workerCount){
  if(!(totalFunes > 0) || !(workerCount > 0)) return null;
  var need = totalFunes / (workerCount * 2 / 60);
  var periods = nzWorkPeriods_();
  var t = nzWtMin_(CFG.NZ_WORK_START || '07:00');
  for(var i = 0; i < periods.length; i++){
    var st = Math.max(t, periods[i][0]); if(st >= periods[i][1]) continue;
    var avail = periods[i][1] - st;
    if(need <= avail) return nzFmtMin_(st + need);
    need -= avail;
  }
  return null;   // 本日中は厳しい見込み
}

// ---- ⑦ まとめ取得：状態・生産ログ・NEW判定・実績計算つきの本日荷造り（読み取りのみ） ----
function getNizukuriFull_(params){
  params = params || {};
  var base = getNizukuriToday_(params);
  if(base.error) return base;
  var date = base.date;
  var state = nzStateRead_(date);
  var logMap = nzLogReadAll_();

  var orders = base.orders.map(function(o){
    var key = nzOrderKey_(date, o);
    var log = logMap[key] || {};
    var madeToday = Number(log[date]) || 0;
    var madeTotal = 0; Object.keys(log).forEach(function(d){ madeTotal += Number(log[d]) || 0; });
    var madePrev = madeTotal - madeToday;
    var totalQty = Math.round(o.qty || 0);
    return {
      cust: o.cust, kubun: o.kubun, nyusu: o.nyusu, qty: o.qty, kg: o.kg, unit: o.unit,
      key: key, state: state.status[key] || 'mikettei',
      madePrev: madePrev, madeToday: madeToday, rest: totalQty - madePrev - madeToday,
      isCS: !!(o.kubun && CFG.NZ_CS_KUBUN_RE.test(o.kubun))
    };
  });
  nzMarkNew_(date, orders);   // 各要素にisNewを付与（発注書側は一切変更しない）

  // 本日作った分の実績（個人注文/その他サンプル＝kg単位グループは、センターと同じ理由で対象外）
  var allKg = 0, csKg = 0;
  orders.forEach(function(o){
    if(o.unit === 'kg') return;
    var kg = o.madeToday * (o.nyusu || 0);
    if(!kg) return;
    allKg += kg;
    if(o.isCS) csKg += kg;
  });

  var mstats = {};
  try{ var ms = getMainStatsToday_(params); if(ms && ms.stats) mstats = ms.stats; }catch(e){}
  var seisanFunes = 0;
  try{
    var s = seisanGet_(params);
    if(s && s.totalFunes) seisanFunes = Number(s.totalFunes) || 0;
  }catch(e){}

  // 舟数（歩留まりの分母）＝圃場（畑）タブの合計＋生産者タブの収穫舟数合計
  //   （センター電子黒板と同じ考え方＝発注書のセルではなく現場の入力を実績として使う。2026-09-22）。
  //   圃場タブがまだ入力されていない日は、従来通り発注書「収穫舟数」列（mainStats経由）を暫定値として使う。
  var hojoFunes = 0;
  try{
    var h = hojoGet_(params);
    if(h && h.total) hojoFunes = Number(h.total) || 0;
  }catch(e){}
  var fallbackFunes = (mstats['収穫舟数'] != null && mstats['収穫舟数'] !== '') ? (Number(mstats['収穫舟数']) || 0) : 0;
  var totalFunes = (hojoFunes > 0 ? hojoFunes : fallbackFunes) + seisanFunes;
  var budomari = (totalFunes > 0) ? (allKg / totalFunes) : null;

  // 加工率＝発注書「進捗」シートのCS率を優先（読み取りのみ）。取得できなければ板集計にフォールバック
  var orderCsRate = null;
  try{
    var prog = getProgressToday_(params);
    if(prog && prog.columns){
      var hit = prog.columns.filter(function(c){ return c.label.indexOf('CS率') >= 0; })[0];
      if(hit && typeof hit.value === 'number') orderCsRate = hit.value;
    }
  }catch(e){}
  var kakouRitsu = (orderCsRate != null) ? (orderCsRate * 100) : ((allKg > 0) ? (csKg / allKg * 100) : null);

  // 終了目標時刻＝本日の荷造り舟数（発注書の荷造り舟数＋生産者タブの収穫舟数合計。数量変更の上書きが
  //   あればそちら）÷（本日出勤人数×2舟/時）。電子黒板の「本日の荷造り舟数」タイルと同じ計算式にそろえる（2026-09-22）。
  var baseNizukuriFune = (mstats['荷造り舟数'] != null && mstats['荷造り舟数'] !== '') ? (Number(mstats['荷造り舟数']) || 0) : 0;
  var defaultTargetFunes = baseNizukuriFune + seisanFunes;
  var targetFunes = (state.targetOverride != null) ? state.targetOverride : defaultTargetFunes;
  var presentCount = 0;
  try{ var sh2 = getHiroshimaShiftToday_(params); if(sh2 && !sh2.error) presentCount = sh2.presentCount; }catch(e){}
  var finishTime = nzCalcFinish_(targetFunes, presentCount);

  return {
    sheet: base.sheet, date: date, rowFound: base.rowFound,
    orders: orders, totalQty: base.totalQty, totalKg: base.totalKg,
    targetOverride: state.targetOverride, targetFunes: targetFunes,
    madeAllKg: allKg, madeCsKg: csKg, totalFunes: totalFunes,
    budomari: budomari, kakouRitsu: kakouRitsu, finishTime: finishTime
  };
}

// ---- ⑦-b 本日荷造りタブの表示ウィンドウ（何日分表示・起点日）。注文データ自体ではなく
//      「今どの範囲を見ているか」というナビゲーション状態。センター電子黒板の
//      「デフォ3日・＋1日・指定日にジャンプ」を全PCで揃えるため、PropertiesService
//      （スクリプト全体で共有・軽量）に1個だけ保存する。日付ごとの行を持つ本日荷造り状態シートとは別物。 ----
function nzViewGet_(){
  try{
    var raw = PropertiesService.getScriptProperties().getProperty(CFG.NZ_VIEW_PROP_KEY || 'NZ_VIEW_STATE');
    if(!raw) return { daysWanted: 3, jumpDate: '', updatedAt: '', by: '' };
    var p = JSON.parse(raw);
    return {
      daysWanted: Math.max(1, Math.min(CFG.NZ_VIEW_MAX_DAYS || 14, Number(p.daysWanted) || 3)),
      jumpDate: String(p.jumpDate || ''),
      updatedAt: String(p.updatedAt || ''),
      by: String(p.by || '')
    };
  }catch(e){ return { daysWanted: 3, jumpDate: '', updatedAt: '', by: '' }; }
}
function nzViewSave_(body){
  body = body || {};
  var now = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
  var payload = {
    daysWanted: Math.max(1, Math.min(CFG.NZ_VIEW_MAX_DAYS || 14, Number(body.daysWanted) || 3)),
    jumpDate: String(body.jumpDate || '').trim(),
    updatedAt: now,
    by: String(body.by || '')
  };
  PropertiesService.getScriptProperties().setProperty(CFG.NZ_VIEW_PROP_KEY || 'NZ_VIEW_STATE', JSON.stringify(payload));
  return { ok: true, view: payload };
}

// ---- ⑦-c 表示ウィンドウぶんの本日荷造り（複数日）をまとめて1回のリクエストで返す ----
//      ?type=nizukuriFullDays&days=3&date=2026-09-22（date省略＝今日起点）。
//      配置図/生産者タブと同様、本日荷造りタブを開いている時だけフロントから呼ぶ（bundleには含めない）。
function getNizukuriFullDays_(params){
  params = params || {};
  var daysWanted = Math.max(1, Math.min(CFG.NZ_VIEW_MAX_DAYS || 14, Number(params.days) || 3));
  var startStr = String(params.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var p = startStr.split('-').map(Number);
  var start = (p.length === 3 && p[0] && p[1] && p[2]) ? new Date(p[0], p[1] - 1, p[2]) : new Date();
  var days = [];
  for(var i = 0; i < daysWanted; i++){
    var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    var dISO = Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd');
    var dayParams = {}; for(var k in params){ dayParams[k] = params[k]; } dayParams.date = dISO;
    days.push(getNizukuriFull_(dayParams));
  }
  return { days: days, daysWanted: daysWanted, startDate: startStr };
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
// ⑧ 圃場（畑）：本日持ってきた舟数の記録（保存先はDATA_SS_ID内のみ）
//   圃場名は「【広島】朝礼ボード_データ」スプレッドシート（A列＝日付・B列＝圃場名・読み取り専用）から
//   毎回自動で取り込む（センター電子黒板の「生産DX（朝礼ボード）」連携と同じ考え方。曽我さん指定・2026-09-22）。
//   舟数0で追加し、既に記録済みの舟数は保持＝名前だけを供給、数量は現場入力を優先。fromDx=取り込み元の目印。
//   列＝日付/圃場名/舟数/更新日時
// ============================================================
function hojoSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.HOJO_SHEET || '圃場舟数';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['日付','圃場名','舟数','更新日時']); try{ sh.setFrozenRows(1); }catch(e){} }
  return sh;
}
// 朝礼ボードのシートを開く（gidで特定。見つからなければ先頭シートにフォールバック）
function hojoSourceSheet_(){
  var ss = SpreadsheetApp.openById(CFG.HOJO_SOURCE_SS_ID);
  var sheets = ss.getSheets();
  for(var i = 0; i < sheets.length; i++){
    if(String(sheets[i].getSheetId()) === String(CFG.HOJO_SOURCE_GID)) return sheets[i];
  }
  return sheets[0];
}
// 朝礼ボードから指定日（省略＝今日）の圃場名一覧を返す（読み取り専用。失敗しても[]を返し圃場舟数側は必ず動く）
function getHojoSourceFieldNames_(dateStr){
  var out = [];
  try{
    var sh = hojoSourceSheet_();
    var v = sh.getDataRange().getValues();
    var want = dateStr || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    for(var r = 0; r < v.length; r++){
      var d0 = v[r][0];
      var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0 || '').trim();
      if(dstr !== want) continue;
      var nm = normText_(v[r][1]);
      if(nm && out.indexOf(nm) < 0) out.push(nm);
    }
  }catch(e){}
  return out;
}
function hojoGet_(params){
  params = params || {};
  var sh = hojoSheet_();
  var date = String(params.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var v = sh.getDataRange().getValues();
  var fields = [], total = 0, byName = {};
  for(var r = 1; r < v.length; r++){
    var d0 = v[r][0];
    var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
    if(dstr !== date) continue;
    var name = String(v[r][1] || '').trim(); if(!name) continue;
    var funes = Number(v[r][2]) || 0;
    var f = { name: name, funes: funes };
    fields.push(f); byName[name] = f;
    total += funes;
  }
  var dxNames = getHojoSourceFieldNames_(date);
  dxNames.forEach(function(nm){
    if(byName[nm]){ byName[nm].fromDx = true; return; }
    var f = { name: nm, funes: 0, fromDx: true };
    fields.push(f); byName[nm] = f;
  });
  return { date: date, fields: fields, total: total, dxCount: dxNames.length };
}
// 🔗 診断用：朝礼ボード連携がずれる原因調査（本番運用には使わない）
function debugHojoSource_(params){
  params = params || {};
  var out = { ssId: CFG.HOJO_SOURCE_SS_ID, gid: CFG.HOJO_SOURCE_GID };
  try{
    var ss = SpreadsheetApp.openById(CFG.HOJO_SOURCE_SS_ID);
    out.allSheets = ss.getSheets().map(function(s){ return { name: s.getName(), gid: s.getSheetId() }; });
    var sh = hojoSourceSheet_();
    out.usedSheetName = sh.getName();
    var v = sh.getDataRange().getValues();
    out.rowCount = v.length;
    out.first10Rows = v.slice(0, 10).map(function(row){ return [row[0], row[1]]; });
    out.namesForParam = getHojoSourceFieldNames_(params.date);
  }catch(e){ out.error = String(e && e.message || e); }
  return out;
}
function hojoSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(20000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var sh = hojoSheet_();
    var HEAD = ['日付','圃場名','舟数','更新日時'];
    var date = String(body.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    var now  = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm');
    var fields = (body.fields instanceof Array) ? body.fields : [];

    var data = sh.getDataRange().getValues();
    var kept = [ (data.length ? data[0] : HEAD) ];
    for(var i = 1; i < data.length; i++){
      var d0 = data[i][0];
      var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
      if(dstr !== date) kept.push(data[i]);
    }
    var rowsN = 0, total = 0;
    fields.forEach(function(f){
      var name = String(f.name || '').trim(); if(!name) return;
      var funes = Math.max(0, Math.round(Number(f.funes) || 0));
      kept.push([date, name, funes, now]);
      rowsN++; total += funes;
    });
    sh.clearContents();
    sh.getRange(1, 1, kept.length, HEAD.length).setValues(kept.map(function(r){
      var a = r.slice(0, HEAD.length); while(a.length < HEAD.length) a.push(''); return a;
    }));
    return { ok:true, saved: rowsN, date: date, total: total };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ============================================================
// 🔍 進捗差分タブ用：発注書「進捗」シートを取引先ごとに合算して返す（読み取り専用）
//   ①先頭15行・先頭3列のどこかに西暦(2000〜2100)がある行＝取引先名の行（custRow）
//   ②その1つ下の行＝見出しに「荷造数」を含む列を探す（subRow）
//   ③本日の行は他の進捗シート読み取り関数と同じ月日一致方式（findRowByDate_）で探す
//   ④取引先名は「荷造数」列と同じ列に入っている（センターの発注書は1列左だが、広島の進捗シートは
//     ?type=debugProgress の実データで確認した通り同じ列＝取引先ブロックの最初の列に名前がある）。
//     空欄は直前の名前を引き継ぐ（結合セル運用のため）。custRowの西暦セル自体は名前として扱わない。
//   列は固定しない・発注書スプレッドシートへは一切書き込まない。
// ============================================================
function readOrderProgressByClient_(dateParam){
  var out = {};
  var sh = openOrderSheetReadOnly_(CFG.ORDER_PROGRESS_SHEET);
  if(!sh) return out;
  var v = sh.getDataRange().getValues();

  var custRow = -1;
  for(var r = 0; r < Math.min(v.length, 15) && custRow < 0; r++){
    for(var c = 0; c < 3; c++){ var y = Number(v[r][c]); if(y >= 2000 && y <= 2100){ custRow = r; break; } }
  }
  if(custRow < 0) return out;
  var subRow = custRow + 1;
  if(subRow >= v.length) return out;

  var meta = detectDayColAndHeaderRows_(v);
  var todayRow = findRowByDate_(v, meta.dayCol, dateParam);
  if(todayRow < 0) return out;

  var lastName = '';
  var width = v[subRow] ? v[subRow].length : 0;
  for(var c2 = 1; c2 < width; c2++){
    var nm = normText_(v[custRow][c2]);
    var nmYear = Number(nm);
    if(nm && !(nmYear >= 2000 && nmYear <= 2100)) lastName = nm;
    var head = normText_(v[subRow][c2]);
    if(head.indexOf('荷造数') < 0) continue;
    var name = lastName;
    if(!name) continue;
    var raw = v[todayRow][c2];
    var n = (typeof raw === 'number') ? raw : Number(String(raw || '').replace(/[^0-9.\-]/g, ''));
    if(!(n > 0)) continue;
    out[name] = (out[name] || 0) + n;
  }
  return out;
}
function getProgressByClient_(params){
  params = params || {};
  return {
    sheet: CFG.ORDER_PROGRESS_SHEET,
    date: params.date || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'),
    byClient: readOrderProgressByClient_(params.date)
  };
}
// 🔍 診断用：進捗差分の取引先ごと集計がずれる原因調査（本番運用には使わない）
function debugProgress_(params){
  params = params || {};
  var sh = openOrderSheetReadOnly_(CFG.ORDER_PROGRESS_SHEET);
  if(!sh) return { error: 'シート「' + CFG.ORDER_PROGRESS_SHEET + '」が見つかりません' };
  var v = sh.getDataRange().getValues();
  var custRow = -1;
  for(var r = 0; r < Math.min(v.length, 15) && custRow < 0; r++){
    for(var c = 0; c < 3; c++){ var y = Number(v[r][c]); if(y >= 2000 && y <= 2100){ custRow = r; break; } }
  }
  var subRow = custRow >= 0 ? custRow + 1 : -1;
  var meta = detectDayColAndHeaderRows_(v);
  var todayRow = findRowByDate_(v, meta.dayCol, params.date);
  var raw = [];
  if(subRow >= 0 && v[subRow]){
    var lastName = '';
    for(var c2 = 1; c2 < Math.min(v[subRow].length, 40); c2++){
      var nm = normText_(v[custRow][c2]);
      var nmYear = Number(nm);
      if(nm && !(nmYear >= 2000 && nmYear <= 2100)) lastName = nm;
      raw.push({ c: c2, custCell: v[custRow][c2], custCarried: lastName, subHead: v[subRow][c2], todayVal: todayRow >= 0 ? v[todayRow][c2] : null });
    }
  }
  return { custRow: custRow, subRow: subRow, dayCol: meta.dayCol, todayRow: todayRow, byClient: readOrderProgressByClient_(params.date), rawFirst40Cols: raw };
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
// ⑥ シフト連携：本日出勤人数・配置図
//   シフト表本体はDATA_SS_ID内「R◯年◯月」シート（年度が変わるとシート名が変わる＝
//   センターv2と同じ罠。固定シート名はCFGに持たず毎回動的に探す）。
//   力量表・配置設定は曽我さんがスプレッドシートを直接編集して調整する運用＝保存APIは無い。
// ============================================================
function resolveTargetDate_(dateStr){
  if(dateStr){
    var m = String(dateStr).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if(m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date();
}
function reiwaYearMonth_(d){
  return { reiwa: d.getFullYear() - 2018, month: d.getMonth() + 1 };
}
function findShiftSheetName_(ss, dateObj){
  var rm = reiwaYearMonth_(dateObj);
  var want = 'R' + rm.reiwa + '年' + rm.month + '月';
  return ss.getSheetByName(want) ? want : null;
}
// シフト表は「1日,2日,3日…」の連番日付（Date型セル。見た目は「1」だけの表示形式でも実体はDate）が
//   並ぶ行を日付ヘッダーとして自動検出する（行番号のベタ書き禁止。氏名は行・日付は列という向きが
//   発注書と逆なので専用の検出ロジックにしている）。発注書と同じ`cellMonthDay_`でDate/テキスト両対応。
//   ⚠数値そのものの「1,2,3…」ではなくDate型なので、見た目の表示だけで判断しない
//   （2026-09-19に`?type=debugShift`の生データで実際にDate型と確認・修正済み）。
function findShiftDayHeaderRow_(v, targetMonth){
  for(var r = 0; r < Math.min(v.length, 12); r++){
    for(var c = 0; c < Math.min(v[r] ? v[r].length : 0, 6); c++){
      var md = cellMonthDay_(v[r][c]);
      if(md && md.d === 1 && (!targetMonth || md.m === targetMonth)){
        var len = 1;
        for(var k = c + 1; k < v[r].length; k++){
          var md2 = cellMonthDay_(v[r][k]);
          if(md2 && md2.m === md.m && md2.d === len + 1) len++; else break;
        }
        if(len >= 15) return { row: r, col0: c };
      }
    }
  }
  return null;
}

// 本日（または指定日）の出勤人数。ラベル文字列（「センター合計人数」等の命名残骸）には一切
//   依存せず、実際に〇マークをカウントする＝ラベルが将来直っても直らなくても壊れない。
function getHiroshimaShiftToday_(params){
  params = params || {};
  var target = resolveTargetDate_(params.date);
  var ymd = Utilities.formatDate(target, CFG.TZ, 'yyyy-MM-dd');
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var sheetName = findShiftSheetName_(ss, target);
  if(!sheetName){
    var rm = reiwaYearMonth_(target);
    var all = ss.getSheets().map(function(s){ return s.getName(); }).filter(function(n){ return /^R\d+年\d+月$/.test(n); });
    return { error: 'シフトシート「R' + rm.reiwa + '年' + rm.month + '月」が見つかりません。存在するシート：' + all.join('、') };
  }
  var sh = ss.getSheetByName(sheetName);
  var v = sh.getDataRange().getValues();
  var head = findShiftDayHeaderRow_(v, target.getMonth() + 1);
  if(!head) return { error: 'シート「' + sheetName + '」で日付ヘッダー行（1日,2日,3日…の連番）が見つかりませんでした' };
  var day = target.getDate();
  var col = head.col0 + (day - 1);
  var workers = [], presentCount = 0;
  var scanLimit = Math.min(v.length, head.row + 2 + 80);
  for(var r = head.row + 2; r < scanLimit; r++){
    var label = normText_(v[r][1]);
    if(label.indexOf('合計人数') >= 0) break;
    if(!label) continue;
    var mark = normText_(v[r][col]);
    var present = (mark === CFG.MARK_PRESENT);
    if(present) presentCount++;
    workers.push({ name: label, mark: mark, present: present });
  }
  return { date: ymd, sheet: sheetName, workers: workers, presentCount: presentCount, totalCount: workers.length };
}

// ---- 力量表（○/△/×。曽我さんがスプレッドシートを直接編集して調整する運用。保存APIは無い） ----
function haichiSkillSheet_(rosterNames){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.HAICHI_SKILL_SHEET || '力量表';
  var zones = CFG.HAICHI_ZONES || [];
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(['氏名'].concat(zones.map(function(z){ return z.label; })));
    try{ sh.setFrozenRows(1); }catch(e){}
  }
  // ロスターに居るのに力量表に未登録の人を、全ゾーン「○」で追記する（センターregisterNewWorkers_の簡易版。
  //   氏名リストをコードにベタ書きしない＝シフト表の実データから毎回同期する）
  if(rosterNames && rosterNames.length){
    var v = sh.getDataRange().getValues();
    var known = {};
    for(var r = 1; r < v.length; r++){ var nm = normText_(v[r][0]); if(nm) known[nm] = true; }
    rosterNames.forEach(function(raw){
      var nm = normText_(raw); if(!nm || known[nm]) return;
      var cells = [nm]; zones.forEach(function(){ cells.push('○'); });
      sh.appendRow(cells);
      known[nm] = true;
    });
  }
  return sh;
}
// アプリの力量表タブから○/△/×を直接編集して保存する（1人×1ゾーンのセルだけ更新。行が無ければ追加）
function haichiSkillSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var name = normText_(body.name || ''); if(!name) return { ok:false, error:'nameが空です' };
    var zoneId = String(body.zoneId || '');
    var value = String(body.value || '○');
    var zones = CFG.HAICHI_ZONES || [];
    var idx = -1;
    for(var i = 0; i < zones.length; i++){ if(zones[i].id === zoneId) { idx = i; break; } }
    if(idx < 0) return { ok:false, error:'不明なゾーンID: ' + zoneId };
    var sh = haichiSkillSheet_([name]);   // 未登録ならこの呼び出しで全ゾーン○で追記される
    var v = sh.getDataRange().getValues();
    for(var r = 1; r < v.length; r++){
      if(normText_(v[r][0]) === name){ sh.getRange(r + 1, 2 + idx).setValue(value); return { ok:true }; }
    }
    return { ok:false, error:'力量表に氏名が見つかりませんでした: ' + name };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}
function haichiReadSkills_(rosterNames){
  var sh = haichiSkillSheet_(rosterNames);
  var v = sh.getDataRange().getValues();
  var zones = CFG.HAICHI_ZONES || [];
  var skills = {};
  for(var r = 1; r < v.length; r++){
    var nm = normText_(v[r][0]); if(!nm) continue;
    var row = {};
    zones.forEach(function(z, i){ row[z.id] = normText_(v[r][1 + i]) || '○'; });
    skills[nm] = row;
  }
  return skills;
}

// ---- ⑨ 配置優先（氏名×ゾーンの自動配置の優先番号。力量表〈○/△/×〉とは別シートで管理。
//      タップで循環（空欄→1→2→3→4→5→×→空欄）：数字が小さいほど先に配置、×はそのゾーンに配置不可、
//      空欄は「配置はできるが優先されない（最後に回される）」扱い。アプリから編集可能） ----
function haichiPrioSheet_(rosterNames){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.HAICHI_PRIO_SHEET || '配置優先';
  var zones = CFG.HAICHI_ZONES || [];
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(['氏名'].concat(zones.map(function(z){ return z.label; })));
    try{ sh.setFrozenRows(1); }catch(e){}
  }
  if(rosterNames && rosterNames.length){
    var v = sh.getDataRange().getValues();
    var known = {};
    for(var r = 1; r < v.length; r++){ var nm = normText_(v[r][0]); if(nm) known[nm] = true; }
    rosterNames.forEach(function(raw){
      var nm = normText_(raw); if(!nm || known[nm]) return;
      var cells = [nm]; zones.forEach(function(){ cells.push(''); });
      sh.appendRow(cells);
      known[nm] = true;
    });
  }
  return sh;
}
function haichiPrioSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var name = normText_(body.name || ''); if(!name) return { ok:false, error:'nameが空です' };
    var zoneId = String(body.zoneId || '');
    var value = String(body.value || '');
    var zones = CFG.HAICHI_ZONES || [];
    var idx = -1;
    for(var i = 0; i < zones.length; i++){ if(zones[i].id === zoneId) { idx = i; break; } }
    if(idx < 0) return { ok:false, error:'不明なゾーンID: ' + zoneId };
    var sh = haichiPrioSheet_([name]);   // 未登録ならこの呼び出しで全ゾーン空欄で追記される
    var v = sh.getDataRange().getValues();
    for(var r = 1; r < v.length; r++){
      if(normText_(v[r][0]) === name){ sh.getRange(r + 1, 2 + idx).setValue(value); return { ok:true }; }
    }
    return { ok:false, error:'配置優先に氏名が見つかりませんでした: ' + name };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}
function haichiReadPrio_(rosterNames){
  var sh = haichiPrioSheet_(rosterNames);
  var v = sh.getDataRange().getValues();
  var zones = CFG.HAICHI_ZONES || [];
  var prio = {};
  for(var r = 1; r < v.length; r++){
    var nm = normText_(v[r][0]); if(!nm) continue;
    var row = {};
    zones.forEach(function(z, i){ row[z.id] = normText_(v[r][1 + i]) || ''; });
    prio[nm] = row;
  }
  return prio;
}

// ---- 配置設定（ゾーンID・表示名・定員・優先度。スプレッドシート直接編集に加えて、
//      アプリの「⚙ ゾーン設定」からも編集可能。優先度＝自動配置でゾーンを埋める順番（数字が小さいほど先）） ----
function haichiCfgSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.HAICHI_CFG_SHEET || '配置設定';
  var zones = CFG.HAICHI_ZONES || [];
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(['ゾーンID', '表示名', '定員', '優先度']);
    var defaultCap = CFG.HAICHI_DEFAULT_CAPACITY || {};
    zones.forEach(function(z, i){ sh.appendRow([z.id, z.label, defaultCap[z.id] || 2, i + 1]); });
    try{ sh.setFrozenRows(1); }catch(e){}
    return sh;
  }
  // 既存シートに「優先度」列（D列）が無い場合は追加し、既存の行順を初期値として埋める（後方互換・1回だけ）
  if(sh.getLastColumn() < 4 || String(sh.getRange(1, 4).getValue() || '') !== '優先度'){
    sh.getRange(1, 4).setValue('優先度');
    var last = sh.getLastRow();
    if(last >= 2){
      var col = sh.getRange(2, 4, last - 1, 1).getValues();
      for(var r = 0; r < col.length; r++){ if(col[r][0] === '' || col[r][0] == null) col[r][0] = r + 1; }
      sh.getRange(2, 4, last - 1, 1).setValues(col);
    }
  }
  return sh;
}
function haichiReadZoneCfg_(){
  var sh = haichiCfgSheet_();
  var v = sh.getDataRange().getValues();
  var zones = CFG.HAICHI_ZONES || [];
  var capById = {}, prioById = {};
  for(var r = 1; r < v.length; r++){
    var id = normText_(v[r][0]); if(!id) continue;
    capById[id] = Number(v[r][2]) || 0;
    prioById[id] = Number(v[r][3]) || 0;
  }
  return zones.map(function(z, i){
    return {
      id: z.id, label: z.label,
      capacity: (z.id in capById) ? capById[z.id] : 2,
      priority: (prioById[z.id] > 0) ? prioById[z.id] : (i + 1)
    };
  });
}
// ⑩ アプリの「⚙ ゾーン設定」から定員・優先度を編集して保存する（1ゾーンの1項目だけ更新。行が無ければ追加）
function haichiZoneCfgSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var zoneId = String(body.zoneId || ''); if(!zoneId) return { ok:false, error:'zoneIdが空です' };
    var field = (String(body.field || 'capacity') === 'priority') ? 'priority' : 'capacity';
    var col = (field === 'priority') ? 4 : 3;
    var value = Math.max((field === 'priority' ? 1 : 0), Math.round(Number(body.value) || 0));
    var zones = CFG.HAICHI_ZONES || [];
    var zone = null;
    for(var i = 0; i < zones.length; i++){ if(zones[i].id === zoneId){ zone = zones[i]; break; } }
    if(!zone) return { ok:false, error:'不明なゾーンID: ' + zoneId };
    var sh = haichiCfgSheet_();
    var v = sh.getDataRange().getValues();
    for(var r = 1; r < v.length; r++){
      if(normText_(v[r][0]) === zoneId){ sh.getRange(r + 1, col).setValue(value); return { ok:true, field: field, value: value }; }
    }
    var row = [zone.id, zone.label, field === 'capacity' ? value : 2, field === 'priority' ? value : (zones.indexOf(zone) + 1)];
    sh.appendRow(row);
    return { ok:true, field: field, value: value };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ---- 配置図状態（本日の配置・欠勤上書き・応援追加。生産者記録と同じ「その日付だけ入れ替え」方式） ----
function haichiStateSheet_(){
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var name = CFG.HAICHI_STATE_SHEET || '配置図状態';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['日付', '更新日時', '端末', '入力内容(JSON)']); try{ sh.setFrozenRows(1); }catch(e){} }
  return sh;
}
function haichiReadState_(date){
  var sh = haichiStateSheet_();
  var last = sh.getLastRow();
  if(last < 2) return { assignment:{}, absentOverride:[], extra:[] };
  var v = sh.getRange(2, 1, last - 1, 4).getValues();
  for(var i = v.length - 1; i >= 0; i--){
    var d0 = v[i][0];
    var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
    if(dstr !== date) continue;
    try{ var parsed = JSON.parse(v[i][3] || '{}'); return parsed || {}; }catch(e){ return { assignment:{}, absentOverride:[], extra:[] }; }
  }
  return { assignment:{}, absentOverride:[], extra:[] };
}
function haichiSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var date = String(body.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    var now  = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    var payload = {
      assignment: (body.assignment && typeof body.assignment === 'object') ? body.assignment : {},
      absentOverride: Array.isArray(body.absentOverride) ? body.absentOverride : [],
      extra: Array.isArray(body.extra) ? body.extra : []
    };
    var sh = haichiStateSheet_();
    var data = sh.getDataRange().getValues();
    var kept = [ data.length ? data[0] : ['日付', '更新日時', '端末', '入力内容(JSON)'] ];
    for(var i = 1; i < data.length; i++){
      var d0 = data[i][0];
      var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
      if(dstr !== date) kept.push(data[i]);
    }
    kept.push([date, now, String(body.by || ''), JSON.stringify(payload)]);
    sh.clearContents();
    sh.getRange(1, 1, kept.length, 4).setValues(kept.map(function(r){ var a = r.slice(0, 4); while(a.length < 4) a.push(''); return a; }));
    return { ok:true, date: date, savedAt: now };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ---- 配置図：まとめ取得（読み取りのみ。力量表/配置設定は無ければ自動作成） ----
function getHaichiGet_(params){
  params = params || {};
  var shift = getHiroshimaShiftToday_(params);
  if(shift.error) return { error: shift.error };
  var rosterNames = shift.workers.map(function(w){ return w.name; });
  var skills = haichiReadSkills_(rosterNames);
  var prio = haichiReadPrio_(rosterNames);
  var zones = haichiReadZoneCfg_();
  var state = haichiReadState_(shift.date);
  return {
    date: shift.date,
    zones: zones,
    workers: shift.workers.map(function(w){ return { name: w.name, present: w.present }; }),
    skills: skills,
    prio: prio,
    assignment: state.assignment || {},
    absentOverride: state.absentOverride || [],
    extra: state.extra || []
  };
}

// 診断用：シフトシートの日付ヘッダー行検出が失敗する時の調査用（本番運用には使わない）
//   ?type=debugShift → 探そうとしたシート名・実際に存在するシート名一覧・先頭12行×10列の生データを返す
function debugShift_(params){
  params = params || {};
  var target = resolveTargetDate_(params.date);
  var rm = reiwaYearMonth_(target);
  var wantName = 'R' + rm.reiwa + '年' + rm.month + '月';
  var ss = SpreadsheetApp.openById(CFG.DATA_SS_ID);
  var out = { wantSheetName: wantName, dataSheetNames: ss.getSheets().map(function(s){ return s.getName(); }) };
  var sh = ss.getSheetByName(wantName);
  if(!sh) return out;
  var v = sh.getDataRange().getValues();
  out.top12Rows = v.slice(0, Math.min(12, v.length)).map(function(row){ return row.slice(0, 10); });
  out.headDetected = findShiftDayHeaderRow_(v, rm.month);
  return out;
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
function testShift(){ Logger.log(JSON.stringify(getHiroshimaShiftToday_({}), null, 2)); }
function testHaichi(){ Logger.log(JSON.stringify(getHaichiGet_({}), null, 2)); }
function testNizukuriFull(){ Logger.log(JSON.stringify(getNizukuriFull_({}), null, 2)); }
