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
  //   2026-10-03〜 「CS」「C・S」「CとS」等も対象（曽我さん指示：C・CS・CとSは歩留まりの「本日作った分」に含めない）。
  NZ_CS_KUBUN_RE: /^\s*(C|\d*S|C\s*[・と&＆\/／・]?\s*S)\s*$/i,
  // ② 繰越在庫（期首）：基準日の「作業が終わった時点の在庫」（その日に作った分も含む）を「累計」の出発点にする（基準日まで〈当日を含む〉の生産ログは使わない）。
  //   2026-10-05 修正：10/3の行（ハローズ土付き14＝10/2の7＋10/3の7、ハローズ洗い120＝10/3の120）は終了時点の数だったのに、10/3の入力を足して二重になっていた。
  //   基準日を更新する時は「荷造り繰越在庫」シートに新しい基準日の行を足す（いちばん新しい基準日の行だけ使う）。
  NZ_OPEN_SHEET: '荷造り繰越在庫',
  // 2026-10-05〜 初期値（10/3の在庫）はコードから外した：シートを誤って消しても10/3の数字で作り直さない＝見出しだけの空シートを作る。
  // ⑦-b 本日荷造りタブの表示ウィンドウ（何日分・起点日）を全PC共有するためのキー（PropertiesService）
  NZ_VIEW_PROP_KEY: 'NZ_VIEW_STATE',
  NZ_VIEW_MAX_DAYS: 14,
  NZ_VIEW_MIN_DAYS: 7,    // 2026-10-03〜 本日荷造りは既定7日表示（曽我さん依頼。旧3日）

  // ===== ⑫ TODOリスト（2026-09-24追加。センター電子黒板の「センターTODOマスタ」と同じ仕組み） =====
  //   マスタ（A=業務/B=頻度）に行を足すだけで黒板に出る（GAS再デプロイ不要）。
  //   チェック操作は履歴シートへ1行追記するだけ＝状態は履歴の最新行から都度組み立てる。
  TODO_MASTER_SHEET: '広島TODOマスタ',
  TODO_LOG_SHEET:    'TODO履歴',
  // ⑫-c Googleカレンダー連携（2026-09-29追加・曽我さん依頼）：会社全体カレンダーの予定のうち、
  //   タイトルに【広島】（半角[広島]も可）が付いたものだけをその日のTODOに出す。
  //   ⚠CalendarAppを初めて使うので、デプロイ前に testTodoCalendar を▶実行して承認が必要。
  //   2026-10-02：会社全体カレンダー（kawakamirenkon116@gmail.com）が共有切れで開けなくなったため、
  //   曽我さんのカレンダーに切り替え（曽我さん指示）。【広島】付きの予定はこのカレンダーに入れる運用。
  TODO_CALENDAR_ID: 'kawakamirennkonkeiri@gmail.com',
  TODO_CALENDAR_TAG_RE: /[【\[]\s*広島\s*[】\]]/,

  // ===== 🚢 前日ストック（2026-09-29追加）：発注書「発注書」シートの前日行の「ｽﾄｯｸ舟数」を自動で使う。
  //   舟数モニターから当日ぶんだけ手入力で上書きできる（PropertiesServiceに日付ごと保存・14日で掃除）。
  PREV_STOCK_PROP_KEY: 'PREV_STOCK_OVERRIDE',
  // ===== ⑤ 資材管理アプリのアラート（2026-09-29追加）：資材アプリが計算した「要対応」一覧を受け取って保存
  SHIZAI_ALERTS_PROP_KEY: 'SHIZAI_ALERTS_PUB',

  // ===== ⑬ Slack連携お知らせ（2026-09-24追加・広島専用チャンネル） =====
  //   スクリプトプロパティ SLACK_BOT_TOKEN / SLACK_CHANNEL_ID（広島チャンネルのID）を読む。
  //   未設定のあいだは ?type=news が {error:...} を返すだけ＝他の機能には一切影響しない。
  NEWS_SHOW_DAYS: 14,                                   // 黒板に出す日数
  NEWS_NIZUKURI_TAG_RE: /^\s*[【\[]\s*荷造り\s*[】\]]\s*/, // 先頭の【荷造り】→本日荷造りタブにも注意文
  NEWS_FALLBACK_NAME: 'お知らせ',
  NEWS_CACHE_SEC: 60,

  // ===== ⑭ 応答キャッシュ（2026-09-24追加・「開くのが遅い」対策） =====
  //   bundleは発注書スプレッドシートを何度も読むため実測16〜17秒かかっていた。
  //   組み立て結果をCacheServiceへ入れ、次からはキャッシュを返す（＝1.5〜2秒）。
  BUNDLE_CACHE_SEC: 21600,     // キャッシュの保持時間（秒・CacheServiceの上限6時間）。2026-10-01に900→21600
                               //   （鮮度はmaxAge/HB_DIRTYで判定するので、長く持つのは「開いた瞬間に出す用」の古い控え）
  BUNDLE_MAX_AGE_SEC: 180,     // 既定の許容鮮度。?maxAge=600 のように呼び出し側から緩められる
                               //   ⚠保存（POST）のたびにキャッシュを捨てるので、誰かが入力した内容は
                               //     この秒数を待たずに次のポーリングで全PCへ反映される。
                               //     この値が効くのは「誰も何も触っていない時に作り直すか」だけ。
  CACHE_CHUNK: 90000,          // CacheServiceの1キー上限(100KB)に収めるための分割サイズ
  // キャッシュ温めトリガーを動かす時間帯（この外では即return＝Apps Scriptの
  // 「トリガーの合計実行時間」の1日あたり上限を使い切らないようにするため）
  CACHE_WARM_HOUR_FROM: 5,
  CACHE_WARM_HOUR_TO: 19,
  // キャッシュ温め1回あたりの持ち時間（秒）。bundleの作り直しだけでこれを超えたら（＝Google側が重い日）、
  //   Slack・本日荷造り7日分の温めは省いて終える（2026-10-08追加。6分上限で強制終了されるのを防ぐ）。
  //   普段は全部で約15秒なので、通常日は影響しない。
  CACHE_WARM_BUDGET_SEC: 60,

  MARK_PRESENT: '〇',
  // ⑥-b シフトシートが無い月は「会社休み」シートで出勤を判定（2026-10-01追加）
  SHIFT_HOLIDAY_SHEET: '会社休み',
  SHIFT_YAKUIN_NAMES: ['中島誠一郎']   // 「役員出勤」の日に出勤する人（空白は無視して比較）
};

// ============================================================
// ★ 実行内メモ化（2026-09-24追加・高速化）
//   同じ1回のリクエストの中で SpreadsheetApp.openById / getDataRange().getValues() が
//   何度も走っていた（bundleは発注書スプレッドシートを5回開き直していた＝実測16.9秒）。
//   ・スプレッドシートを開く操作＝IDごとに1回だけ
//   ・発注書スプレッドシート（読み取り専用）のセル値＝シートごとに1回だけ
//   ⚠値のメモ化は「読み取り専用」と決めてある発注書スプレッドシートに限定する。
//     書き込みがあるDATA_SS_ID側は、開いたオブジェクトだけ使い回して値はメモ化しない
//     （保存直後に古い値を返してしまうのを防ぐため）。
// ============================================================
var _SS_MEMO_  = {};   // { spreadsheetId: Spreadsheet }
var _ORD_MEMO_ = {};   // { sheetName: values[][] }（発注書スプレッドシートのみ）
function ssById_(id){
  if(!_SS_MEMO_[id]) _SS_MEMO_[id] = SpreadsheetApp.openById(id);
  return _SS_MEMO_[id];
}

// ============================================================
// ★ 応答キャッシュ（2026-09-24追加・「開くのが遅い」対策）
//   CacheServiceの1キー上限は約100KBなので、長い本文は CFG.CACHE_CHUNK 文字ずつに分割して
//   「<key>.n（個数）」＋「<key>.0, <key>.1 …」のキーに入れる。
//   キャッシュはあくまで表示の高速化用＝壊れていたら黙って作り直す（例外は握りつぶす）。
// ============================================================
function cachePut_(key, text, sec){
  try{
    var cache = CacheService.getScriptCache();
    var size = CFG.CACHE_CHUNK, parts = [];
    for(var i = 0; i < text.length; i += size) parts.push(text.substring(i, i + size));
    if(parts.length > 20) return false;   // 大きすぎる（想定外）＝キャッシュしない
    var map = { };
    map[key + '.n'] = String(parts.length);
    for(var j = 0; j < parts.length; j++) map[key + '.' + j] = parts[j];
    cache.putAll(map, sec);
    return true;
  }catch(err){ return false; }
}
function cacheGet_(key){
  try{
    var cache = CacheService.getScriptCache();
    var n = Number(cache.get(key + '.n') || 0);
    if(!n) return null;
    var names = [];
    for(var i = 0; i < n; i++) names.push(key + '.' + i);
    var got = cache.getAll(names);
    var out = '';
    for(var j = 0; j < n; j++){
      var p = got[key + '.' + j];
      if(p == null) return null;   // 1つでも欠けていたら無効（作り直す）
      out += p;
    }
    return out;
  }catch(err){ return null; }
}
function cacheDrop_(key){
  try{
    var cache = CacheService.getScriptCache();
    var n = Number(cache.get(key + '.n') || 0);
    var names = [key + '.n'];
    for(var i = 0; i < n; i++) names.push(key + '.' + i);
    cache.removeAll(names);
  }catch(err){}
}
function bundleCacheKey_(params){
  var d = String((params && params.date) || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  return 'HB_BUNDLE_' + d;
}
// 保存系POSTの直後に呼ぶ。2026-10-01〜キャッシュは捨てずに「この時刻より前に作ったものは古い」という
//   印（HB_DIRTY）だけ付ける＝通常の取得は作り直すが、?stale=1（画面を開いた瞬間の1回目）は古いままでも
//   すぐ返せる（キャッシュを消してしまうと、入力直後に開いた人が9〜12秒待たされていた）。
function dropBundleCacheToday_(){
  try{ CacheService.getScriptCache().put('HB_DIRTY', String(Date.now()), 21600); }catch(e){}
}
function boardDirtyAt_(){
  try{ return Number(CacheService.getScriptCache().get('HB_DIRTY') || 0); }catch(e){ return 0; }
}

// キャッシュ付き取得の共通部品（bundle と nizukuriFullDays で使う）。
//   ?maxAge=秒 … これより古いキャッシュは作り直す（既定 CFG.BUNDLE_MAX_AGE_SEC）。
//   ?stale=1   … 古くても（保存後でも）キャッシュがあればそのまま即返す＝画面を開いた瞬間用。
//                 フロントは返ってきた _stale を見て、裏でもう1回（stale無しで）取り直す。
//   ?nocache=1 … キャッシュを無視して必ず作り直す（診断用）。
function cachedBuild_(key, params, builder){
  params = params || {};
  var now = Date.now();
  var maxAge = Number(params.maxAge);
  if(!(maxAge >= 0)) maxAge = CFG.BUNDLE_MAX_AGE_SEC;
  if(String(params.nocache || '') !== '1'){
    var raw = cacheGet_(key);
    if(raw){
      try{
        var hit = JSON.parse(raw);
        var age = (now - Number(hit._builtAtMs || 0)) / 1000;
        var fresh = (age >= 0 && age <= maxAge && Number(hit._builtAtMs || 0) >= boardDirtyAt_());
        if(fresh || String(params.stale || '') === '1'){
          hit._cache = fresh ? 'hit' : 'stale'; hit._stale = !fresh; hit._ageSec = Math.round(age);
          return hit;
        }
      }catch(e){}
    }
  }
  var out = builder(params);
  out._builtAtMs = now;   // 組み立て開始時刻（組み立て中に保存があれば次回は古い扱いになる）
  out._builtAt = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
  out._cache = 'miss';
  out._stale = false;
  out._ageSec = 0;
  cachePut_(key, JSON.stringify(out), CFG.BUNDLE_CACHE_SEC);
  return out;
}
function getBundleCached_(params){
  return cachedBuild_(bundleCacheKey_(params), params, getBundle_);
}
// ⑦-b 本日荷造りタブ（複数日）も同じ仕組みでキャッシュ（素の組み立ては実測12秒）
function getNizukuriFullDaysCached_(params){
  params = params || {};
  var start = String(params.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var key = 'HB_NZD2_' + Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd') + '_' + start + '_' + (Number(params.days) || 7);
  return cachedBuild_(key, params, getNizukuriFullDays_);
}

// ★ 5分おきのトリガーに登録しておくと、キャッシュが常に温まっている＝朝いちで開く人も待たされない。
//   Apps Scriptエディタで installBoardCacheTrigger を1回だけ▶実行すれば設置できる（任意）。
//   ⚠Apps Scriptには「トリガーの合計実行時間」の1日あたり上限がある（個人アカウントは90分/日）。
//     bundleの組み立ては数秒かかるので、1分おきに24時間動かすと上限を使い切ってしまう。
//     そのため①5分おき②稼働時間帯（CFG.CACHE_WARM_HOUR_FROM〜TO）の外は即returnする、の2点で
//     1日あたりの合計実行時間を十分小さく抑えている。
function refreshBoardCache(){
  var hour = Number(Utilities.formatDate(new Date(), CFG.TZ, 'H'));
  if(hour < CFG.CACHE_WARM_HOUR_FROM || hour >= CFG.CACHE_WARM_HOUR_TO) return 'skip(時間外)';
  // 2026-10-08 重複実行の防止：Google側が重い日に前の回が5分を超えて動いていると、次の回と重なって
  //   さらに重くなる（＋1日の合計実行時間を食う）ので、前の回の印が残っていれば何もせず終える。
  //   ⚠ScriptLockは保存（POST）と共用なので使わない（握ったままだと保存側が待たされる）。
  //   印は7分で自然に消える＝6分上限で強制終了されて finally が走らなくても、次の次の回からは再開する。
  var cache = CacheService.getScriptCache();
  try{
    if(cache.get('HB_WARMING')) return 'skip(前回の実行中)';
    cache.put('HB_WARMING', String(Date.now()), 420);
  }catch(e){}
  var t0 = Date.now();
  function overBudget(){ return (Date.now() - t0) / 1000 > CFG.CACHE_WARM_BUDGET_SEC; }
  try{
    var params = { date: Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd') };
    var out = cachedBuild_(bundleCacheKey_(params), { date: params.date, nocache: '1' }, getBundle_);
    if(overBudget()) return out._builtAt + '（時間がかかったため残りの温めは省略）';
    try{ getNewsCached_(true); }catch(e){}   // Slackお知らせも一緒に温めておく
    if(overBudget()) return out._builtAt + '（時間がかかったため本日荷造りの温めは省略）';
    // 本日荷造りタブ（今日起点・全PC共通の表示日数）も温めておく（2026-10-03・7日表示で素の組み立てが重くなったため）
    try{
      var vw = nzViewGet_();
      if(!vw.jumpDate) getNizukuriFullDaysCached_({ date: params.date, days: vw.daysWanted, nocache: '1' });
    }catch(e){}
    return out._builtAt;
  }finally{
    try{ cache.remove('HB_WARMING'); }catch(e){}
  }
}
// 5分おきのトリガーを設置（重複して作らないよう既存の同名トリガーは消してから作る）
function installBoardCacheTrigger(){
  var all = ScriptApp.getProjectTriggers();
  for(var i = 0; i < all.length; i++){
    if(all[i].getHandlerFunction() === 'refreshBoardCache') ScriptApp.deleteTrigger(all[i]);
  }
  ScriptApp.newTrigger('refreshBoardCache').timeBased().everyMinutes(5).create();
  Logger.log('✅ refreshBoardCache を5分おきに設置しました（'
    + CFG.CACHE_WARM_HOUR_FROM + '時〜' + CFG.CACHE_WARM_HOUR_TO + '時のあいだだけ動きます）。'
    + '電子黒板が常に速く開くようになります。');
}
function uninstallBoardCacheTrigger(){
  var all = ScriptApp.getProjectTriggers(), n = 0;
  for(var i = 0; i < all.length; i++){
    if(all[i].getHandlerFunction() === 'refreshBoardCache'){ ScriptApp.deleteTrigger(all[i]); n++; }
  }
  Logger.log('🗑 refreshBoardCache のトリガーを ' + n + ' 件削除しました');
}

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
    else if(type === 'nizukuriFullDays') out = getNizukuriFullDaysCached_(e.parameter); // ⑦-b 表示ウィンドウぶん（複数日）をまとめて取得
    else if(type === 'nzViewGet')    out = nzViewGet_();                           // ⑦-b 本日荷造りタブの表示ウィンドウ（全PC共有）
    else if(type === 'hojoGet')      out = hojoGet_(e.parameter);                  // ⑧ 圃場（畑）から持ってきた舟数
    else if(type === 'debugHojoSource') out = debugHojoSource_(e.parameter);       // ⑧ 診断用：朝礼ボード連携
    else if(type === 'progressByClient') out = getProgressByClient_(e.parameter);  // 🔍 進捗差分：発注書「進捗」シートの取引先別荷造数
    else if(type === 'debugProgress') out = debugProgress_(e.parameter);           // 🔍 診断用
    else if(type === 'todoMaster')   out = getTodoBoard_(e.parameter.date);        // ⑫ TODOリスト：マスタ一覧＋本日のチェック状態
    else if(type === 'news')         out = getNewsCached_(String(e.parameter.nocache||'')==='1'); // ⑬ Slack連携お知らせ（広島チャンネル）
    else if(type === 'bundle')       out = getBundleCached_(e.parameter);          // ⑭ 高速化：CacheService経由（?nocache=1で強制再計算）
    else if(type === 'debug')        out = debugTop_();
    else if(type === 'debugOrder')   out = debugOrder_(e.parameter);
    else if(type === 'debugColors')  out = debugColors_(e.parameter);   // ⑥ 発注書の数字の文字色→状態の判定結果（診断用）
    else if(type === 'debugPool')    out = debugPool_(e.parameter);     // ② 繰り越しの振り分け結果（診断用・&cust=で絞り込み）
    else out = { error:'type を progress / funes / progressTestGet / seisanGet / nizukuri / mainStats / shizaiAlerts / shizaiLoad / shizaiMeta / shizaiBackupList / shizaiBackupGet / shizaiUsage / shift / haichiGet / nizukuriFull / nizukuriFullDays / nzViewGet / hojoGet / progressByClient / todoMaster / news / bundle / debug のいずれかで指定してください' };
  }catch(err){
    out = { error: String(err && err.message || err) };
  }
  var body = JSON.stringify(out);
  // JSONPのcallback名は英数字・_・$・.だけ許可（任意のJSを実行させないため）
  if(e.parameter.callback && /^[\w$.]{1,80}$/.test(String(e.parameter.callback))){
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
    else if(action === 'todoLog')           out = todoLogAppend_(body); // ⑫ TODOのチェック/解除を履歴へ1行追記
    else if(action === 'prevStockSave')     out = prevStockSave_(body); // 🚢 前日ストックの当日上書き
    else if(action === 'shizaiAlertsPublish') out = shizaiAlertsPublish_(body); // ⑤ 資材アプリのアラート一覧を受け取る
    else if(action === 'slackPost')         out = slackPost_(body);   // 資材アプリ「繁忙期の全資材 再確認」の報告（広島チャンネルへ投稿）
    else out = { ok:false, error:'unknown action: ' + action };
    // ⑭ 保存された内容はbundleにも含まれるので、本日ぶんのキャッシュを捨てて次の取得で作り直させる
    //   （＝保存したのに30秒〜数分そのまま古い値が返る、というのを防ぐ）
    if(out && out.ok !== false) { try{ dropBundleCacheToday_(); }catch(e){} }
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
    progressByClient: safe(function(){ return getProgressByClient_(params); }), // 🔍 進捗差分タブ用
    todo:         safe(function(){ return getTodoBoard_(params.date); })       // ⑫ TODOリスト（軽い＝DATA_SS側の2シートを読むだけ）
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
//   2026-09-24：戻り値を「getDataRange().getValues() をメモ化した読み取り専用ラッパー」に変更。
//   呼び出し側（getProgressToday_/getFunesToday_/getNizukuriToday_/getMainStatsToday_/
//   readOrderProgressByClient_/getShizaiUsage_/debug系）は今まで通り
//   `sh.getDataRange().getValues()` と書けばよく、実際のシート読み取りは1回だけになる。
//   ⚠ラッパーは読み取り専用（getValues/getNameのみ）＝発注書スプレッドシートへの
//     書き込みAPIを誤って呼べない作りにもなっている（このファイルの最重要ルールの補強）。
function openOrderSheetReadOnly_(sheetName){
  var sh = ssById_(CFG.ORDER_SS_ID).getSheetByName(sheetName);
  if(!sh) return null;
  return {
    getName: function(){ return sh.getName(); },
    getDataRange: function(){
      return {
        getValues: function(){
          if(!_ORD_MEMO_.hasOwnProperty(sheetName)) _ORD_MEMO_[sheetName] = sh.getDataRange().getValues();
          return _ORD_MEMO_[sheetName];
        }
      };
    },
    // ⑥ 2026-10-03追加：数字の文字色（赤＝未確定／黒＝確定／青＝納品済）を読むだけ（書き込みはしない）。
    //   r0〜r1は0始まりの行番号。行ごとに '#rrggbb' の配列をメモ化して返す。
    fontColorRows: function(r0, r1){
      var memo = _ORD_COLOR_MEMO_[sheetName] = _ORD_COLOR_MEMO_[sheetName] || {};
      var need = false;
      for(var r = r0; r <= r1; r++){ if(!memo.hasOwnProperty(r)){ need = true; break; } }
      if(need && r1 >= r0){
        var width = sh.getLastColumn();
        var objs = sh.getRange(r0 + 1, 1, r1 - r0 + 1, width).getFontColorObjects();
        for(var i = 0; i < objs.length; i++) memo[r0 + i] = objs[i].map(fontColorHex_);
      }
      var out = {};
      for(var r2 = r0; r2 <= r1; r2++) out[r2] = memo[r2] || [];
      return out;
    }
  };
}
var _ORD_COLOR_MEMO_ = {};   // { sheetName: { row: ['#rrggbb', …] } }（発注書スプレッドシートのみ・読み取り）
var _THEME_MEMO_ = null;
// 文字色オブジェクト→'#rrggbb'（テーマ色はスプレッドシートのテーマから実際の色に直す。分からなければ''）
function fontColorHex_(c){
  try{
    if(!c) return '';
    var t = c.getColorType();
    if(t === SpreadsheetApp.ColorType.RGB) return c.asRgbColor().asHexString();
    if(t === SpreadsheetApp.ColorType.THEME){
      if(!_THEME_MEMO_) _THEME_MEMO_ = ssById_(CFG.ORDER_SS_ID).getSpreadsheetTheme();
      return _THEME_MEMO_.getConcreteColor(c.asThemeColor().getThemeColorType()).asRgbColor().asHexString();
    }
  }catch(e){}
  return '';
}
// '#rrggbb' → 'red'（赤系）／'blue'（青系）／'black'（それ以外＝黒・灰色・既定色）
function nzColorClass_(hex){
  // ⚠実データでは黒が '#ff000000'（先頭2桁＝不透明度＋RRGGBB の8桁）で返る（2026-10-03 debugColorsで確認）。
  //   8桁のときは先頭2桁を捨てて RRGGBB として読む（そのまま先頭6桁を読むと黒が赤に化ける）。
  var s = String(hex || '').replace(/^#/, '');
  if(/^[0-9a-f]{8}$/i.test(s)) s = s.slice(2);
  var m = s.match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if(!m) return 'black';
  var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  if(r >= 140 && r - g >= 60 && r - b >= 60) return 'red';
  if(b >= 120 && b - r >= 60 && b - g >= 20) return 'blue';
  return 'black';
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
// ② 個人注文（2026-09-29変更）：広島の個人注文は2kg/5kgの列に「箱数(c/s)」で入力されるため、
//   kg合算グループから外して
//   普通の注文と同じc/s行として出し、kojin:trueを付ける（「本日作った分」の自動記入は2026-09-29に停止＝手入力）。
//   その他サンプルも2026-10-08〜 同じくc/s行（区分Mup/C/S・入数1）として出す（曽我さん指示「サンプルはMup」）。
//   C・S列は他の注文と同じく isCS＝歩留まり・進捗差分の対象外。旧kg合算時代のログ（区分が空）は nzLogReadAll_ でMupへ読み替える。
var NZ_KOJIN_RE = /個人注文/;
var NZ_SAMPLE_RE = /その他サンプル/;

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
    var isKojin = NZ_KOJIN_RE.test(name);
    var isKg = false;   // 2026-10-08〜 kg合算グループは無し（個人注文・その他サンプルともc/s行）
    if(!isKojin && !NZ_SAMPLE_RE.test(name) && NZ_EXCLUDE_RE.test(name)) continue;
    var nyusu = Number(v[nyusuRow] ? v[nyusuRow][c] : NaN);
    if(!(nyusu > 0)) continue;   // 入数が数値の列だけ＝実際の取引先の商品列
    var kubun = normText_(kubunRow < v.length ? v[kubunRow][c] : '');
    if(kubun === '土なし') kubun = '洗い';
    if(/^[\d.]+$/.test(kubun)) kubun = '';
    if(kubun && !byName[name]) byName[name] = kubun;
    if(isKg){ cols.push({ c:c, name:name, nyusu:nyusu, kubun:'', kgUnit:true }); continue; }
    cols.push({ c:c, name:name, nyusu:nyusu, kubun:kubun, kojin:isKojin });
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
    // ⑥ 数字の文字色（params.withColor の時だけ・読み取りのみ）。取れなければ色判定なし＝従来どおり手動
    var rowColors = null;
    if(params.withColor){
      try{ rowColors = sh.fontColorRows(row, row)[row] || null; }catch(e){ rowColors = null; }
    }
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
      var od = { cust: col.name, kubun: kubun, nyusu: col.nyusu, qty: qty, kg: kg };
      if(col.kojin) od.kojin = true;
      if(rowColors){ od.color = nzColorClass_(rowColors[col.c]); od.colorHex = rowColors[col.c] || ''; }
      orders.push(od);
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
  var out = readMainStatsRow_(params.date);
  if(out.error) return out;
  // 🚢 前日ストック（2026-09-29追加）：前日行の「ｽﾄｯｸ舟数」。前日の行が無い（休み等）ときは
  //   最大7日さかのぼって、行がある直近の日の値を使う。舟数モニターからの当日上書きがあればそちら。
  var baseYmd = String(params.date || '').trim() || todayYmd_();
  var prevAuto = null, prevDate = '';
  for(var back = 1; back <= 7; back++){
    var dYmd = ymdAddDays_(baseYmd, -back);
    var ps = readMainStatsRow_(dYmd);
    if(ps.error || !ps.rowFound) continue;
    var sv = ps.stats['ｽﾄｯｸ舟数'];
    if(sv === undefined) sv = ps.stats['ストック舟数'];
    prevAuto = Number(sv) || 0; prevDate = dYmd;
    break;
  }
  var ov = prevStockOverrideGet_(baseYmd);
  out.prevStockAuto = prevAuto;
  out.prevStockDate = prevDate;
  out.prevStockOverride = ov;
  out.prevStock = (ov != null) ? ov : (prevAuto || 0);
  // ④ 本日の荷造り舟数（2026-09-29変更・曽我さん指定の式）
  //   ＝ 収穫舟数 ＋ 前日ｽﾄｯｸ舟数 − 本日ｽﾄｯｸ舟数 ＋ 生産者タブの収穫舟数
  //   （生産者ぶんは getNizukuriFull_／フロント側で足す。ここでは発注書側の3項だけ返す）
  var st = out.stats;
  var harvest = (st['収穫舟数'] != null && st['収穫舟数'] !== '') ? (Number(st['収穫舟数']) || 0) : null;
  var todayStockRaw = (st['ｽﾄｯｸ舟数'] !== undefined) ? st['ｽﾄｯｸ舟数'] : st['ストック舟数'];
  out.todayStock = Number(todayStockRaw) || 0;
  out.harvest = harvest;
  out.nizukuriFunesBase = (harvest == null) ? null : (harvest + out.prevStock - out.todayStock);
  return out;
}
function ymdAddDays_(ymd, n){
  var p = String(ymd).split('-').map(Number);
  var d = new Date(p[0], p[1] - 1, p[2] + n);
  return Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd');
}
// 🚢 前日ストックの当日上書き（舟数モニターから手入力）。value=null で上書き解除＝発注書の値に戻す
function prevStockOverrideAll_(){
  try{ return JSON.parse(PropertiesService.getScriptProperties().getProperty(CFG.PREV_STOCK_PROP_KEY) || '{}') || {}; }catch(e){ return {}; }
}
function prevStockOverrideGet_(ymd){
  var m = prevStockOverrideAll_();
  return (m.hasOwnProperty(ymd) && typeof m[ymd] === 'number') ? m[ymd] : null;
}
function prevStockSave_(body){
  body = body || {};
  var ymd = String(body.date || '').trim() || todayYmd_();
  var m = prevStockOverrideAll_();
  if(body.value === null || body.value === undefined || body.value === '') delete m[ymd];
  else m[ymd] = Math.max(0, Number(body.value) || 0);
  var cutoff = ymdAddDays_(todayYmd_(), -14);
  Object.keys(m).forEach(function(k){ if(k < cutoff) delete m[k]; });
  PropertiesService.getScriptProperties().setProperty(CFG.PREV_STOCK_PROP_KEY, JSON.stringify(m));
  return { ok:true, date: ymd, value: (m.hasOwnProperty(ymd) ? m[ymd] : null) };
}
// 発注書「発注書」シートの指定日の行から、集計列（荷造り舟数・収穫舟数・ｽﾄｯｸ舟数 等）を読む（読み取りのみ）
function readMainStatsRow_(dateParam){
  var sh = openOrderSheetReadOnly_(CFG.ORDER_MAIN_SHEET);
  if(!sh) return { error: 'シート「' + CFG.ORDER_MAIN_SHEET + '」が見つかりません' };
  var v = sh.getDataRange().getValues();
  var nameRow = findOrderNameRow_(v);
  if(nameRow < 0) return { error: '取引先の見出し行が見つかりませんでした' };
  var meta = detectDayColAndHeaderRows_(v);
  var row = findRowByDate_(v, meta.dayCol, dateParam);
  var params = { date: dateParam };
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
// ⑥ 診断用：指定日（省略＝今日）の注文ごとの文字色と判定（赤＝未確定／黒・青＝確定）。読み取りのみ。
function debugColors_(params){
  params = params || {};
  var p = {}; for(var k in params){ p[k] = params[k]; } p.withColor = true;
  var base = getNizukuriToday_(p);
  if(base.error) return base;
  return { date: base.date, rowFound: base.rowFound, orders: base.orders.map(function(o){
    return { cust: o.cust, kubun: o.kubun, nyusu: o.nyusu, qty: o.qty, colorHex: o.colorHex || '', color: o.color || '' };
  }) };
}
// ② 診断用：繰り越し（余りの振り分け）の計算結果。&cust=取引先名 で絞り込み。読み取りのみ。
function debugPool_(params){
  params = params || {};
  var todayReal = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var pool = nzPoolCompute_(todayReal);
  var cust = String(params.cust || '').trim();
  var out = {};
  Object.keys(pool).sort().forEach(function(k){
    if(cust && k.split('|')[1].indexOf(cust) < 0) return;
    var x = pool[k];
    if(!x.own && !x.carryIn && !x.surplusOut && !x.leftover && k.split('|')[0] < todayReal) return;   // 過去で動きの無い注文は省略
    out[k] = x;
  });
  var open = {}; try{ open = nzOpeningRead_(); }catch(e){ open = { error: String(e) }; }
  return { today: todayReal, opening: open, count: Object.keys(out).length, pool: out };
}
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
  var ss = ssById_(CFG.DATA_SS_ID);
  var name = CFG.NZ_STATE_SHEET || '本日荷造り状態';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['日付', '更新日時', '端末', '入力内容(JSON)']); try{ sh.setFrozenRows(1); }catch(e){} }
  return sh;
}
var _NZ_STATE_MEMO_ = null;   // 1リクエスト内で「本日荷造り状態」シートを読むのは1回だけ（複数日表示の高速化・2026-10-03）
function nzStateRead_(date){
  if(!_NZ_STATE_MEMO_){
    var sh = nzStateSheet_();
    var last = sh.getLastRow();
    _NZ_STATE_MEMO_ = (last < 2) ? [] : sh.getRange(2, 1, last - 1, 4).getValues();
  }
  var v = _NZ_STATE_MEMO_;
  for(var i = v.length - 1; i >= 0; i--){
    var d0 = v[i][0];
    var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
    if(dstr !== date) continue;
    try{
      var p = JSON.parse(v[i][3] || '{}');
      return { status: p.status || {}, statusColor: p.statusColor || {}, targetOverride: (typeof p.targetOverride === 'number') ? p.targetOverride : null };
    }catch(e){ return { status: {}, statusColor: {}, targetOverride: null }; }
  }
  return { status: {}, statusColor: {}, targetOverride: null };
}
function nzStateSave_(body){
  body = body || {};
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var date = String(body.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    var now  = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    var sh = nzStateSheet_();
    var data = sh.getDataRange().getValues();
    var kept = [ data.length ? data[0] : ['日付', '更新日時', '端末', '入力内容(JSON)'] ];
    var prev = null;
    for(var i = 1; i < data.length; i++){
      var d0 = data[i][0];
      var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
      if(dstr !== date){ kept.push(data[i]); continue; }
      try{ prev = JSON.parse(data[i][3] || '{}') || null; }catch(e){ prev = null; }
    }
    // 2026-10-02〜 差分マージ方式：送られてきた項目だけを書き換え、それ以外（他PC・他画面の変更）は残す。
    //   statusPatch:{キー:状態}（'mikettei'＝解除）／ setTarget:true の時だけ targetOverride を書き換え／
    //   patch.day.busy（資材アプリの繁忙期再確認）は day.busy に足す。
    //   旧クライアント（status丸ごと送信）は従来どおり status を置き換える（後方互換）。
    var payload = (prev && typeof prev === 'object') ? prev : {};
    if(!payload.status || typeof payload.status !== 'object') payload.status = {};
    if(typeof payload.targetOverride !== 'number') payload.targetOverride = null;
    var isPatch = !!(body.statusPatch || body.setTarget || body.patch);
    if(!isPatch){
      payload.status = (body.status && typeof body.status === 'object') ? body.status : {};
      payload.targetOverride = (body.targetOverride === null || body.targetOverride === undefined) ? null : (Number(body.targetOverride) || 0);
    } else {
      var sp = (body.statusPatch && typeof body.statusPatch === 'object') ? body.statusPatch : {};
      // ⑥ 2026-10-03〜 colorPatch:{キー:'mikettei'|'kakutei'}＝押した時点の発注書の文字色による状態。
      //   手で押した状態は「その色のあいだだけ」有効（発注書の色が変わったら色の状態に戻る）。
      //   色が取れている注文では「未確定」も手動の選択として残す（黒でも未確定にしておけるように）。
      var cp = (body.colorPatch && typeof body.colorPatch === 'object') ? body.colorPatch : null;
      if(!payload.statusColor || typeof payload.statusColor !== 'object') payload.statusColor = {};
      Object.keys(sp).forEach(function(k){
        var st = String(sp[k] || '');
        var col = cp ? String(cp[k] || '') : '';
        if(col){
          payload.status[k] = st || 'mikettei';
          payload.statusColor[k] = col;
        } else {
          if(!st || st === 'mikettei') delete payload.status[k]; else payload.status[k] = st;
          delete payload.statusColor[k];
        }
      });
      if(body.setTarget){
        payload.targetOverride = (body.targetOverride === null || body.targetOverride === undefined) ? null : (Number(body.targetOverride) || 0);
      }
      var busy = body.patch && body.patch.day && body.patch.day.busy;
      if(busy && typeof busy === 'object'){
        payload.day = (payload.day && typeof payload.day === 'object') ? payload.day : {};
        payload.day.busy = (payload.day.busy && typeof payload.day.busy === 'object') ? payload.day.busy : {};
        Object.keys(busy).forEach(function(k){ payload.day.busy[k] = busy[k]; });
      }
    }
    kept.push([date, now, String(body.by || ''), JSON.stringify(payload)]);
    sh.clearContents();
    sh.getRange(1, 1, kept.length, 4).setValues(kept.map(function(r){ var a = r.slice(0, 4); while(a.length < 4) a.push(''); return a; }));
    _NZ_STATE_MEMO_ = null;
    return { ok:true, date: date, savedAt: now };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ---- 生産ログ（本日作った分。日付を跨いで蓄積＝upsert方式。前日作成(累計)の計算根拠） ----
function nzLogSheet_(){
  var ss = ssById_(CFG.DATA_SS_ID);
  var name = CFG.NZ_LOG_SHEET || '本日荷造り生産ログ';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['キー', '生産日', '納品日', '取引先', '区分', '入数', '数量cs', '更新日時', '端末']); try{ sh.setFrozenRows(1); }catch(e){} }
  return sh;
}
// 全件読み込み→ {orderKey: {生産日: cases}} のマップ（前日作成(累計)＝本日以外の合計、で使う）
var _NZ_LOG_MEMO_ = null;   // 1リクエスト内で生産ログを読むのは1回だけ（2026-10-03・複数日表示の高速化）
function nzLogReadAll_(){
  if(_NZ_LOG_MEMO_) return _NZ_LOG_MEMO_;
  var sh = nzLogSheet_();
  var last = sh.getLastRow();
  var map = {};
  if(last < 2) return (_NZ_LOG_MEMO_ = map);
  var v = sh.getRange(2, 1, last - 1, 7).getValues();
  for(var i = 0; i < v.length; i++){
    var key = String(v[i][0] || ''); if(!key) continue;
    // 2026-10-08：その他サンプルがkg合算だった頃のキー（区分が空・入数1）は、Mupのc/s行のキーへ読み替える
    if(/\|その他サンプル\|\|1$/.test(key)) key = key.replace(/\|\|1$/, '|Mup|1');
    var pd0 = v[i][1];
    var prodDate = (pd0 instanceof Date) ? Utilities.formatDate(pd0, CFG.TZ, 'yyyy-MM-dd') : String(pd0 || '').trim();
    var cases = Number(v[i][6]) || 0;
    if(!map[key]) map[key] = {};
    map[key][prodDate] = cases;
  }
  return (_NZ_LOG_MEMO_ = map);
}

// ---- ② 2026-10-03追加：作りすぎた分の繰り越し（同じ 取引先｜区分｜入数 の次の注文へ自動で回す） ----
//   曽我さん指定の仕様：
//     ・同じ商品＝取引先＋区分＋入数が同じ注文（区分が空のkg単位グループは対象外＝従来どおり）
//     ・これまでの全生産ログが対象
//     ・（2026-10-08〜）納品日の早い注文から順に、自分への入力＋それまでの余りを生産日の古い順に充てる（先入れ先出し）。
//       以下は2026-10-03当初の説明：作った数は、まず入力した注文自身に充てる（注文数まで）。注文数を超えた「余り」は、
//       納品日の早い注文から順に自動で埋める（その注文の納品日までに作った分だけ）。
//       → 注文数が増えれば余りを先の注文から取り戻し（月100→200なら 月103・火0）、
//         減れば余りが次の注文へ回る（月100→50なら 月50・火53）。毎回計算し直すので保存はしない。
//     ・どの注文にも入らない余りは、その商品のいちばん先の注文に「余り」として表示する。
//   発注書は読み取りのみ。生産ログ（DATA_SS_ID）にも書かない（表示上の振り分けだけ）。
var _NZ_POOL_MEMO_ = null;
function nzRowYmd_(cell, md){
  if(cell instanceof Date) return Utilities.formatDate(cell, CFG.TZ, 'yyyy-MM-dd');
  var fy = orderFiscalStartYear_();
  var y = (md.m >= 7) ? fy : fy + 1;   // 発注書は7月始まり
  return y + '-' + pad2_(md.m) + '-' + pad2_(md.d);
}
// 発注書「発注書」シート全日付の注文を { '取引先|区分|入数': { 'yyyy-MM-dd': 数量 } } にまとめる（読み取りのみ）
function nzAllOrdersByGroup_(){
  var sh = openOrderSheetReadOnly_(CFG.ORDER_MAIN_SHEET);
  if(!sh) return {};
  var v = sh.getDataRange().getValues();
  var nameRow = findOrderNameRow_(v);
  if(nameRow < 0) return {};
  var meta = detectDayColAndHeaderRows_(v);
  var built = buildOrderCols_(v, nameRow);
  var groups = {}, seen = {};
  for(var r = Math.max(meta.headerRows, nameRow + 1); r < v.length; r++){
    var md = cellMonthDay_(v[r][meta.dayCol]); if(!md) continue;
    var ymd = nzRowYmd_(v[r][meta.dayCol], md);
    if(seen[ymd]) continue;   // 同じ日付の行が2つあれば最初の行だけ（findRowByDate_と同じ）
    seen[ymd] = true;
    built.cols.forEach(function(col){
      if(col.kgUnit) return;
      var qty = Math.round(Number(v[r][col.c]) || 0);
      if(qty <= 0) return;
      var kubun = col.kubun || built.byName[col.name] || '';
      var g = col.name + '|' + kubun + '|' + col.nyusu;
      groups[g] = groups[g] || {};
      groups[g][ymd] = (groups[g][ymd] || 0) + qty;
    });
  }
  return groups;
}
// 繰越在庫（期首）の読み込み：{ date:'yyyy-MM-dd'（いちばん新しい基準日）, stock:{ '取引先|区分|入数': c/s } }
//   書き込み先は電子黒板データ（DATA_SS_ID）だけ。発注書には書かない。
var _NZ_OPEN_MEMO_ = null;
var NZ_OPEN_HEAD_ = '基準日（この日の作業が終わった時点の在庫＝その日に作った分も含む）';
function nzOpeningRead_(){
  if(_NZ_OPEN_MEMO_) return _NZ_OPEN_MEMO_;
  var ss = ssById_(CFG.DATA_SS_ID);
  var sh = ss.getSheetByName(CFG.NZ_OPEN_SHEET);
  if(!sh){
    sh = ss.insertSheet(CFG.NZ_OPEN_SHEET);
    sh.getRange(1, 1, 1, 6).setValues([[NZ_OPEN_HEAD_, '取引先', '区分', '入数', '在庫c/s', 'メモ']]);
    try{ sh.setFrozenRows(1); }catch(e){}
  }
  var v = sh.getDataRange().getValues();
  // 2026-10-05〜 見出し・メモの表現を「終了時点の在庫」にそろえる（同日午前の版で「作業前」と書き換えてしまったものを戻す）
  if(v.length && String(v[0][0]) !== NZ_OPEN_HEAD_){ sh.getRange(1, 1).setValue(NZ_OPEN_HEAD_); v[0][0] = NZ_OPEN_HEAD_; }
  for(var mi = 1; mi < v.length; mi++){
    var memo = String(v[mi][5] || '');
    if(memo.indexOf('作業前') >= 0){ var nm = memo.replace(/作業前の在庫|作業前/, '終了時点の在庫'); sh.getRange(mi + 1, 6).setValue(nm); v[mi][5] = nm; }
  }
  var best = '', byDate = {};
  for(var i = 1; i < v.length; i++){
    var d0 = v[i][0];
    var d = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0 || '').trim().replace(/\//g, '-');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    var cust = String(v[i][1] || '').trim(), kubun = String(v[i][2] || '').trim(), nyusu = Number(v[i][3]) || 0;
    var cs = Math.round(Number(v[i][4]) || 0);
    if(!cust || !kubun) continue;
    var g = cust + '|' + kubun + '|' + nyusu;
    byDate[d] = byDate[d] || {};
    byDate[d][g] = (byDate[d][g] || 0) + cs;
    if(d > best) best = d;
  }
  return (_NZ_OPEN_MEMO_ = { date: best, stock: best ? byDate[best] : {} });
}
// 戻り値：{ 注文キー: { own:自分の分として使った数, ownToday:そのうち今日作った分, carryIn:余りから回ってきた数,
//                      surplusOut:自分の入力のうち他の注文へ回った/余った数, leftover:どこにも入らない余り（先頭の注文のみ） } }
function nzPoolCompute_(todayReal){
  if(_NZ_POOL_MEMO_) return _NZ_POOL_MEMO_;
  var logMap = nzLogReadAll_();
  var groups = nzAllOrdersByGroup_();
  // 繰越在庫（期首）：基準日の作業が終わった時点の在庫を出発点にする（2026-10-03〜・2026-10-05に「終了時点」へ修正）。
  //   ・基準日まで（当日を含む）の生産ログは使わない（在庫の数字に含まれている）
  //   ・納品日が基準日までの注文は「済み」扱い（在庫を食わない）
  //   ・在庫は基準日の生産として、納品日が基準日より後の注文へ早い順に充てる
  //   ※基準日は作業が終わった日（昨日以前）にする。今日の日付にすると、今日の入力が在庫に吸われて見えなくなる。
  var open = { date: '', stock: {} };
  try{ open = nzOpeningRead_(); }catch(e){}
  var lotsBy = {};   // g -> [{prod, src, left}]
  Object.keys(open.stock || {}).forEach(function(g){
    var c = Math.round(Number(open.stock[g]) || 0); if(c <= 0) return;
    (lotsBy[g] = lotsBy[g] || []).push({ prod: open.date, src: '', ddate: '', left: c, opening: true });
  });
  Object.keys(logMap).forEach(function(k){
    var p = k.split('|'); if(p.length < 4) return;
    if(!p[2]) return;   // 区分が空＝kg単位グループは対象外
    var g = p.slice(1).join('|');
    var lm = logMap[k] || {};
    Object.keys(lm).forEach(function(pd){
      var c = Math.round(Number(lm[pd]) || 0); if(c <= 0 || !pd) return;
      // 基準日まで（当日を含む）の生産は繰越在庫に含まれている＝足さない。
      //   2026-10-05：以前は基準日当日の入力を足しており、10/3の入力（ハローズ土付き7・洗い120）が在庫と二重になっていた。
      if(open.date && pd <= open.date) return;
      (lotsBy[g] = lotsBy[g] || []).push({ prod: pd, src: k, ddate: p[0], left: c });
    });
  });
  var res = {};
  var allG = {}; Object.keys(groups).forEach(function(g){ allG[g] = 1; }); Object.keys(lotsBy).forEach(function(g){ allG[g] = 1; });
  Object.keys(allG).forEach(function(g){
    var od = groups[g] || {};
    var dates = Object.keys(od).sort();
    var lots = (lotsBy[g] || []).sort(function(a, b){ return a.prod < b.prod ? -1 : a.prod > b.prod ? 1 : (a.ddate < b.ddate ? -1 : a.ddate > b.ddate ? 1 : 0); });
    var info = {};
    dates.forEach(function(d){
      var it = { qty: od[d], own: 0, ownToday: 0, carryIn: 0, surplusOut: 0, leftover: 0 };
      if(open.date && d <= open.date){
        // 基準日までに納品の注文＝済み。今日の入力があればその分だけ「本日」に見せる（在庫計算には使わない）
        it.own = it.qty; it.closed = true;
        var tl = (logMap[d + '|' + g] || {})[todayReal];
        if(tl) it.ownToday = Math.min(it.qty, Math.round(Number(tl) || 0));
      }
      info[d + '|' + g] = it;
    });
    // 1) 納品日の早い注文から順に、「自分に入力した分」＋「それまでに出た余り（繰越在庫・前の注文の作りすぎ）」を
    //    生産日の古い順に充てる（同じ生産日なら自分の入力を先）。
    //    2026-10-08 修正（曽我さん指摘「個人注文2kgの昨日時点の繰越は12ケース」）：以前は自分の入力を先に全部充てて
    //    から余りを回していたため、10/8分に今日23入れると、昨日までの余り12のうち7しか10/8分に入らず5が10/10分へ
    //    飛んでいた。古い在庫から先に使う（先入れ先出し）ようにした。先の注文に入力した分は、その注文の番が来るまで
    //    使わない（明後日分を今日作っても、明日分に吸われない）。
    var ownBy = {}, free = [];
    lots.forEach(function(l){
      l.orig = l.left;
      var o = info[l.src];
      if(o && !o.closed) (ownBy[l.src] = ownBy[l.src] || []).push(l);
      else free.push(l);   // 注文が発注書から消えた/日付が変わった・済みの注文への入力・繰越在庫＝最初から余り
    });
    dates.forEach(function(d){
      var k = d + '|' + g, o = info[k];
      var mine = ownBy[k] || [];
      if(o.closed) return;
      var cands = mine.concat(free.filter(function(l){ return l.left > 0 && l.prod <= d; }));
      cands.sort(function(a, b){
        if(a.prod !== b.prod) return a.prod < b.prod ? -1 : 1;
        var am = a.src === k ? 0 : 1, bm = b.src === k ? 0 : 1;
        if(am !== bm) return am - bm;
        return a.ddate < b.ddate ? -1 : a.ddate > b.ddate ? 1 : 0;
      });
      var need = o.qty - o.own;
      for(var i = 0; i < cands.length && need > 0; i++){
        var l = cands[i]; if(l.left <= 0) continue;
        var take = Math.min(l.left, need);
        l.left -= take; need -= take;
        if(l.src === k){ o.own += take; if(l.prod === todayReal) o.ownToday += take; }
        else o.carryIn += take;
      }
      mine.forEach(function(l){ if(l.left > 0) free.push(l); });   // 使い切れなかった自分の入力＝余り（次の注文へ）
    });
    // surplusOut＝自分に入力した数のうち、自分に充てなかった数（済みの注文は入力が全部余り）
    lots.forEach(function(l){ var o = info[l.src]; if(o) o.surplusOut += l.orig; });
    dates.forEach(function(d){ var o = info[d + '|' + g]; if(!o.closed) o.surplusOut = Math.max(0, o.surplusOut - o.own); });
    // 2) まだ足りない注文（納品日が過ぎて入力が足りない等）へ、残った余りを納品日の早い順に（その注文の納品日までに作った分だけ）
    dates.forEach(function(d){
      var o = info[d + '|' + g];
      var need = o.qty - o.own - o.carryIn; if(need <= 0) return;
      for(var i = 0; i < lots.length && need > 0; i++){
        var l = lots[i];
        if(l.left <= 0 || l.prod > d) continue;
        var take = Math.min(l.left, need);
        l.left -= take; need -= take; o.carryIn += take;
      }
    });
    // 3) どこにも入らなかった余り → この商品のいちばん先（納品日が最後）の注文に表示
    var rest = 0; lots.forEach(function(l){ rest += l.left; });
    if(rest > 0 && dates.length) info[dates[dates.length - 1] + '|' + g].leftover = rest;
    Object.keys(info).forEach(function(k){ res[k] = info[k]; });
  });
  return (_NZ_POOL_MEMO_ = res);
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
    _NZ_LOG_MEMO_ = null; _NZ_POOL_MEMO_ = null;
    return { ok:true, key: key, prodDate: prodDate, savedAt: now };
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ---- NEW判定（前回スナップショットと比較。初回実行は基準化のみ＝NEW扱いにしない） ----
function nzSnapSheet_(){
  var ss = ssById_(CFG.DATA_SS_ID);
  var name = CFG.NZ_SNAP_SHEET || '本日荷造りスナップショット';
  var sh = ss.getSheetByName(name);
  var firstEver = false;
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['キー', '数量', '検知日時', '取引先区分']); try{ sh.setFrozenRows(1); }catch(e){} firstEver = true; }
  return { sh: sh, firstEver: firstEver };
}
// 2026-10-03〜 複数日表示（7日）で毎日ぶん読み書きしないよう、1リクエスト内は読み込み1回・書き込み1回にまとめる
//   （nzMarkNew_ で印を付け、getNizukuriFull_／getNizukuriFullDays_ の最後に nzSnapFlush_ で1回だけ保存）。
var _NZ_SNAP_MEMO_ = null;   // { sh, firstEver, snap, dirty }
function nzSnapLoad_(){
  if(_NZ_SNAP_MEMO_) return _NZ_SNAP_MEMO_;
  var t = nzSnapSheet_(), sh = t.sh;
  var data = sh.getDataRange().getValues();
  var snap = {};
  for(var i = 1; i < data.length; i++){
    var k = String(data[i][0] || ''); if(!k) continue;
    var ca = data[i][2];
    var caMs = (ca instanceof Date) ? ca.getTime() : (ca ? Date.parse(ca) : 0);
    snap[k] = { qty: Number(data[i][1]) || 0, changedAt: caMs || 0, memo: String(data[i][3] || '') };
  }
  _NZ_SNAP_MEMO_ = { sh: sh, firstEver: t.firstEver || data.length <= 1, snap: snap, dirty: false };
  return _NZ_SNAP_MEMO_;
}
function nzMarkNew_(date, orders){
  var m = nzSnapLoad_(), snap = m.snap, firstEver = m.firstEver;
  var now = Date.now();
  var newWindowMs = 12 * 60 * 60 * 1000;
  orders.forEach(function(o){
    var key = nzOrderKey_(date, o);
    var prev = snap[key], changedAt;
    if(firstEver){ changedAt = 0; }
    else if(!prev){ changedAt = now; }
    else if(prev.qty !== (o.qty || 0)){ changedAt = now; }
    else{ changedAt = prev.changedAt || 0; }
    var memo = o.cust + (o.kubun ? '(' + o.kubun + ')' : '');
    if(!prev || prev.qty !== (o.qty || 0) || prev.changedAt !== changedAt) m.dirty = true;
    snap[key] = { qty: o.qty || 0, changedAt: changedAt, memo: memo };
    o.isNew = !!(changedAt && (now - changedAt) < newWindowMs);
  });
}
function nzSnapFlush_(){
  var m = _NZ_SNAP_MEMO_;
  if(!m) return;
  var now = Date.now();
  var cutoffMs = now - (CFG.NZ_SNAP_KEEP_DAYS || 7) * 24 * 60 * 60 * 1000;
  var out = [['キー', '数量', '検知日時', '取引先区分']], dropped = false;
  Object.keys(m.snap).forEach(function(k){
    var dms = Date.parse(k.split('|')[0]);
    if(dms && dms < cutoffMs){ dropped = true; return; }   // 古いスナップショットは保存のたびに間引く
    var s = m.snap[k];
    out.push([k, s.qty, s.changedAt ? new Date(s.changedAt).toISOString() : '', s.memo]);
  });
  if(m.dirty || dropped || m.firstEver){
    m.sh.clearContents();
    m.sh.getRange(1, 1, out.length, 4).setValues(out);
  }
  _NZ_SNAP_MEMO_ = null;
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
  var bp = {}; for(var pk in params){ bp[pk] = params[pk]; } bp.withColor = true;   // ⑥ 文字色も読む
  var base = getNizukuriToday_(bp);
  if(base.error) return base;
  var date = base.date;   // クエリした注文行の納品日（複数日表示では今日以外の日もありうる）
  // ⚠「本日作った分」の判定基準は常に実際のカレンダー上の今日＝todayReal（生産日）。納品日dateとは
  //   別物＝「明日納品の注文を今日のうちに作った」場合、その注文行の“本日”欄にも正しく計上されるように
  //   する（2026-09-22の複数日表示追加時、当初は log[date]＝納品日基準で作ってしまい、生産日を跨いだ
  //   集計・進捗差分への反映が壊れる不具合になった。修正後は生産日=todayRealで統一）。
  var todayReal = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var state = nzStateRead_(date);
  var logMap = nzLogReadAll_();
  var pool = {};
  try{ pool = nzPoolCompute_(todayReal); }catch(e){ pool = {}; }
  var openDate = '';
  try{ openDate = nzOpeningRead_().date || ''; }catch(e){}

  var orders = base.orders.map(function(o){
    var key = nzOrderKey_(date, o);
    var log = logMap[key] || {};
    // 個人注文の自動記入は2026-09-29に停止・関数は2026-10-05に削除（曽我さん依頼）：
    //   発注書の入力日と実際に作った日がずれるため、他の注文と同じく「本日」欄を手入力する運用に戻した。
    var madeToday = Number(log[todayReal]) || 0;   // 本日欄＝この注文に今日入力した数（そのまま）
    var madeTotal = 0; Object.keys(log).forEach(function(d){ madeTotal += Number(log[d]) || 0; });
    var totalQty = Math.round(o.qty || 0);
    var madePrev, rest, carryIn = 0, surplus = 0, pooled = false;
    var pi = pool[key];
    if(pi && pi.qty === totalQty){
      // ② 繰り越しあり：累計＝自分に充てた分（今日の入力ぶんを除く）＋余りから回ってきた分
      pooled = true;
      carryIn = pi.carryIn;
      madePrev = pi.own - pi.ownToday + pi.carryIn;
      rest = Math.max(0, totalQty - pi.own - pi.carryIn);
      surplus = pi.surplusOut;   // 自分の入力のうち注文数を超えた分（次の注文へ回る）
    } else {
      madePrev = madeTotal - madeToday;
      rest = totalQty - madePrev - madeToday;
    }
    // ⑥ 状態：発注書の文字色（赤＝未確定／黒・青＝確定）で自動判定。手で押した状態は、押した時と
    //   同じ色のあいだだけ優先。「作成済み」は手で付けたものを常に優先。
    var colorState = o.color ? (o.color === 'red' ? 'mikettei' : 'kakutei') : '';
    var manual = state.status[key] || '', manualColor = (state.statusColor || {})[key] || '';
    // 2026-10-08：その他サンプルがkg合算だった頃に押した状態（キーの区分が空）も引き継ぐ
    if(!manual && NZ_SAMPLE_RE.test(o.cust) && o.kubun === 'Mup'){
      var oldKey = date + '|' + o.cust + '||1';
      manual = state.status[oldKey] || ''; manualColor = (state.statusColor || {})[oldKey] || '';
    }
    var st, stSrc;
    if(manual === 'sakusei'){ st = 'sakusei'; stSrc = 'manual'; }
    else if(manual && (!colorState || manualColor === colorState)){ st = manual; stSrc = 'manual'; }
    else if(colorState){ st = colorState; stSrc = 'color'; }
    else { st = manual || 'mikettei'; stSrc = manual ? 'manual' : ''; }
    return {
      cust: o.cust, kubun: o.kubun, nyusu: o.nyusu, qty: o.qty, kg: o.kg, unit: o.unit,
      key: key, state: st, stateSrc: stSrc, color: o.color || '', colorState: colorState,
      kojin: !!o.kojin,
      madePrev: madePrev, madeToday: madeToday, rest: rest,
      pooled: pooled, carryIn: carryIn, surplus: surplus, leftover: pooled ? pi.leftover : 0,
      prodLog: log,   // 生産日ごとの内訳（累計修正UIのツールチップ・日付選択時のプリフィルに使用。読み取りのみ）
      isCS: !!(o.kubun && CFG.NZ_CS_KUBUN_RE.test(o.kubun))
    };
  });
  nzMarkNew_(date, orders);   // 各要素にisNewを付与（発注書側は一切変更しない）
  if(!params._noFlush) nzSnapFlush_();
  if(params.ordersOnly){
    // 複数日表示用：注文一覧だけ（実績・舟数・終了時刻は電子黒板ホームの bundle 側で今日ぶんだけ計算する）
    return { sheet: base.sheet, date: date, rowFound: base.rowFound, orders: orders, totalQty: base.totalQty, totalKg: base.totalKg, openDate: openDate };
  }

  // 本日作った分の実績（2026-10-08〜 その他サンプルもc/s行＝Mupは対象・C/Sは対象外）
  //   ⚠ 納品日がこの日の注文だけでなく、生産ログ全体から「生産日=todayReal」の行を合計する
  //   （2026-10-01：明日・明後日納品分を今日作った分が歩留まりに入らず、本日の荷造り合計1979.3kgに対し
  //    550kg÷40舟=13.75になっていた。キー＝納品日|取引先|区分|入数。kg単位グループは区分が空なので除外）。
  // 2026-10-05〜 madeTodayByKey＝同じ集計の「注文キーごとの本日作った分(c/s)」（C・S・kg単位は除く）。
  //   ホームの一致確認タイル・🔍進捗差分はこれで判定する（以前は本日荷造りタブを開いた時の表示範囲だけを
  //   見ていたため、起動直後のホームで全取引先が「要確認」になっていた）。
  var allKg = 0, csKg = 0, madeTodayByKey = {};
  Object.keys(logMap).forEach(function(k){
    var made = Number((logMap[k] || {})[todayReal]) || 0;
    if(!made) return;
    var p = k.split('|');
    var kubun = p[2] || '', nyusu = Number(p[3]) || 0;
    if(!kubun || !nyusu) return;
    var kg = made * nyusu;
    // 2026-10-03〜 区分C・S（CS・CとS等）は歩留まりの「本日作った分」に含めない（曽我さん指示）。csKgは加工率の予備計算用に別集計
    if(CFG.NZ_CS_KUBUN_RE.test(kubun)){ csKg += kg; return; }
    allKg += kg;
    madeTodayByKey[k] = made;
  });
  allKg = Math.round(allKg * 100) / 100; csKg = Math.round(csKg * 100) / 100;

  var mstats = {}, msFull = null;
  try{ var ms = getMainStatsToday_(params); if(ms && ms.stats){ mstats = ms.stats; msFull = ms; } }catch(e){}
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
  var kakouRitsu = (orderCsRate != null) ? (orderCsRate * 100) : ((allKg + csKg > 0) ? (csKg / (allKg + csKg) * 100) : null);

  // 終了目標時刻＝本日の荷造り舟数（数量変更の上書きがあればそちら）÷（本日出勤人数×2舟/時）。
  //   本日の荷造り舟数＝収穫舟数＋前日ｽﾄｯｸ舟数−本日ｽﾄｯｸ舟数＋生産者タブの収穫舟数（2026-09-29・曽我さん指定の式）。
  //   電子黒板の「本日の荷造り舟数」タイル（フロント nzDefaultTargetFunes_）と同じ計算式にそろえる。
  //   発注書の収穫舟数が取れない時だけ、従来の「発注書の荷造り舟数」列を使う。
  var baseNizukuriFune = (msFull && msFull.nizukuriFunesBase != null) ? msFull.nizukuriFunesBase
    : ((mstats['荷造り舟数'] != null && mstats['荷造り舟数'] !== '') ? (Number(mstats['荷造り舟数']) || 0) : 0);
  var defaultTargetFunes = baseNizukuriFune + seisanFunes;
  // 2026-10-03〜 「本日の合計数量 変更」ボタンを廃止（曽我さん依頼）＝過去に保存された上書きが残っていても使わない。
  var targetFunes = defaultTargetFunes;
  var presentCount = 0;
  try{ var sh2 = getHiroshimaShiftToday_(params); if(sh2 && !sh2.error) presentCount = sh2.presentCount; }catch(e){}
  var finishTime = nzCalcFinish_(targetFunes, presentCount);

  return {
    sheet: base.sheet, date: date, rowFound: base.rowFound,
    orders: orders, totalQty: base.totalQty, totalKg: base.totalKg, openDate: openDate,
    targetOverride: null, targetFunes: targetFunes,
    madeAllKg: allKg, madeCsKg: csKg, totalFunes: totalFunes,
    madeTodayByKey: madeTodayByKey, madeTodayDate: todayReal,
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
    if(!raw) return { daysWanted: CFG.NZ_VIEW_MIN_DAYS || 7, jumpDate: '', updatedAt: '', by: '' };
    var p = JSON.parse(raw);
    return {
      daysWanted: Math.max(CFG.NZ_VIEW_MIN_DAYS || 7, Math.min(CFG.NZ_VIEW_MAX_DAYS || 14, Number(p.daysWanted) || 7)),
      jumpDate: String(p.jumpDate || ''),
      updatedAt: String(p.updatedAt || ''),
      by: String(p.by || '')
    };
  }catch(e){ return { daysWanted: CFG.NZ_VIEW_MIN_DAYS || 7, jumpDate: '', updatedAt: '', by: '' }; }
}
function nzViewSave_(body){
  body = body || {};
  var now = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
  var payload = {
    daysWanted: Math.max(CFG.NZ_VIEW_MIN_DAYS || 7, Math.min(CFG.NZ_VIEW_MAX_DAYS || 14, Number(body.daysWanted) || 7)),
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
  var daysWanted = Math.max(1, Math.min(CFG.NZ_VIEW_MAX_DAYS || 14, Number(params.days) || 7));
  var startStr = String(params.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var p = startStr.split('-').map(Number);
  var start = (p.length === 3 && p[0] && p[1] && p[2]) ? new Date(p[0], p[1] - 1, p[2]) : new Date();
  var isos = [];
  for(var i = 0; i < daysWanted; i++){
    var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    isos.push(Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd'));
  }
  // ⑥ 表示する日の行の文字色をまとめて1回で読む（1日ずつ読むと7日分で遅くなるため。読み取りのみ）
  try{
    var sh = openOrderSheetReadOnly_(CFG.ORDER_MAIN_SHEET);
    if(sh){
      var v = sh.getDataRange().getValues();
      var meta = detectDayColAndHeaderRows_(v);
      var rows = isos.map(function(iso){ return findRowByDate_(v, meta.dayCol, iso); }).filter(function(r){ return r >= 0; });
      if(rows.length) sh.fontColorRows(Math.min.apply(null, rows), Math.max.apply(null, rows));
    }
  }catch(e){}
  // 2026-10-03〜 各日は注文一覧だけ（ordersOnly）・NEW判定の保存は最後に1回だけ（_noFlush）
  var days = isos.map(function(dISO){
    var dayParams = {}; for(var k in params){ dayParams[k] = params[k]; }
    dayParams.date = dISO; dayParams.ordersOnly = true; dayParams._noFlush = true;
    return getNizukuriFull_(dayParams);
  });
  try{ nzSnapFlush_(); }catch(e){}
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
      var stockSh = ssById_(CFG.DATA_SS_ID).getSheetByName(CFG.SHIZAI_STOCK_SHEET);
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
  // ⑤ 資材管理アプリ本体が計算した「要対応」一覧（2026-09-29追加）。こちらがあれば黒板はこれを優先して出す
  //   （発注書連動の在庫切れ予定・納品予定・定期チェック・破棄率・月末棚卸まで、資材アプリの画面と同じ内容）。
  try{
    var pub = PropertiesService.getScriptProperties().getProperty(CFG.SHIZAI_ALERTS_PROP_KEY);
    if(pub) out.published = JSON.parse(pub);
  }catch(e){}
  return out;
}
// ⑤ 資材管理アプリ（shizai.html）から「要対応」一覧を受け取って保存（POST action:'shizaiAlertsPublish'）
//   body = { items:[{kind, text}], asOf:'yyyy-MM-dd', by }。PropertiesServiceの1値上限(9KB)に収まるよう件数・文字数を丸める。
function shizaiAlertsPublish_(body){
  body = body || {};
  var items = Array.isArray(body.items) ? body.items : [];
  var clean = [];
  for(var i = 0; i < items.length && clean.length < 40; i++){
    var t = String(items[i] && items[i].text || '').slice(0, 120);
    if(!t) continue;
    clean.push({ kind: String(items[i].kind || '').slice(0, 16), text: t });
  }
  var payload = {
    items: clean,
    total: clean.length,
    asOf: String(body.asOf || todayYmd_()).slice(0, 10),
    at: Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm'),
    by: String(body.by || '').slice(0, 40)
  };
  var json = JSON.stringify(payload);
  // 上限はバイト数（日本語は1文字3バイト）なのでバイトで測る
  while(Utilities.newBlob(json).getBytes().length > 8500 && payload.items.length){ payload.items.pop(); json = JSON.stringify(payload); }
  PropertiesService.getScriptProperties().setProperty(CFG.SHIZAI_ALERTS_PROP_KEY, json);
  return { ok:true, total: payload.total, at: payload.at };
}

// ============================================================
// ①「進捗シートへ数字を飛ばす」機能・段階1（試験運用）
//   電子黒板から入力した値は、発注書スプレッドシートには一切書かず、
//   CFG.DATA_SS_ID の「進捗テスト」シートにだけ記録する。
//   保存形：日付ごとに1行。列＝日付／更新日時／端末／(見出しラベル)ごとの値（JSON1セル）
// ============================================================
function progressTestSheet_(){
  var ss = ssById_(CFG.DATA_SS_ID);
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
  var ss = ssById_(CFG.DATA_SS_ID);
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
    // totalFunes＝生産者カードの「🚢収穫舟数」の合計（荷造り舟数・歩留まりの分母・舟数モニターに使う）。
    //   規格別の入力（c/s数・C/S/半端のkg）は舟数ではないので足さない（2026-10-02修正。それまではc/sとkgを足していた）。
    if(grp === '収穫舟数'){ map[mk].funes = funes; totalFunes += funes; continue; }
    if(size > 0 && funes > 0) map[mk].rows[grp + '|' + size] = funes;
    totalKg += kg;
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
    // 2026-10-02〜 keys:['AM|生産者名',…] が来たら、その生産者（時間帯）の行だけを入れ替える
    //   （他PCが入力した別の生産者の行は残す）。keysが無い旧クライアントは従来どおりその日を丸ごと入れ替え。
    var onlyKeys = null;
    if(body.keys instanceof Array){
      onlyKeys = {};
      body.keys.forEach(function(k){ onlyKeys[String(k)] = true; });
    }
    function seisanRowKey_(ampm, name){
      return ((String(ampm || 'AM').trim().toUpperCase() === 'PM') ? 'PM' : 'AM') + '|' + String(name || '').trim();
    }

    var data = sh.getDataRange().getValues();
    var kept = [ (data.length ? data[0] : HEAD) ];
    for(var i = 1; i < data.length; i++){
      var d0 = data[i][0];
      var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
      if(dstr !== date){ kept.push(data[i]); continue; }
      if(onlyKeys && !onlyKeys[seisanRowKey_(data[i][1], data[i][2])]) kept.push(data[i]);
    }
    var rowsN = 0, totalFunes = 0, totalKg = 0;
    list.forEach(function(p){
      var name = String(p.name || '').trim(); if(!name) return;
      var ampm = (String(p.ampm||'AM').toUpperCase() === 'PM') ? 'PM' : 'AM';
      if(onlyKeys && !onlyKeys[ampm + '|' + name]) return;
      var rows = (p.rows && typeof p.rows === 'object') ? p.rows : {};
      Object.keys(rows).forEach(function(key){
        var funes = Number(rows[key]) || 0; if(funes <= 0) return;
        var parts = String(key).split('|');
        var grp  = parts[0] || '';
        var size = Number(parts[1]) || 0;
        var kg = funes * size;
        kept.push([date, ampm, name, grp, size, funes, Math.round(kg*10)/10, now]);
        rowsN++;
      });
      var pf = Number(p.funes) || 0;
      if(pf > 0){ kept.push([date, ampm, name, '収穫舟数', 0, pf, 0, now]); rowsN++; }
    });
    sh.clearContents();
    sh.getRange(1, 1, kept.length, HEAD.length).setValues(kept.map(function(r){
      var a = r.slice(0, HEAD.length); while(a.length < HEAD.length) a.push(''); return a;
    }));
    // 保存後のその日の全員分（他PCの入力も含む）を返す＝画面はこれで最新に揃える
    var after = seisanGet_({ date: date });
    return { ok:true, saved: rowsN, date: date, list: after.list, totalFunes: after.totalFunes, totalKg: after.totalKg };
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
  var ss = ssById_(CFG.DATA_SS_ID);
  var name = CFG.HOJO_SHEET || '圃場舟数';
  var sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(['日付','圃場名','舟数','更新日時']); try{ sh.setFrozenRows(1); }catch(e){} }
  return sh;
}
// 朝礼ボードのシートを開く（gidで特定。見つからなければ先頭シートにフォールバック）
function hojoSourceSheet_(){
  var ss = ssById_(CFG.HOJO_SOURCE_SS_ID);
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
    var ss = ssById_(CFG.HOJO_SOURCE_SS_ID);
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
    // 2026-10-02〜 keys:[圃場名,…] が来たら、その圃場の行だけを入れ替える（他PCが入力した別の圃場は残す）。
    //   keysが無い旧クライアントは従来どおりその日を丸ごと入れ替え。
    var onlyKeys = null;
    if(body.keys instanceof Array){
      onlyKeys = {};
      body.keys.forEach(function(k){ onlyKeys[String(k).trim()] = true; });
    }

    var data = sh.getDataRange().getValues();
    var kept = [ (data.length ? data[0] : HEAD) ];
    for(var i = 1; i < data.length; i++){
      var d0 = data[i][0];
      var dstr = (d0 instanceof Date) ? Utilities.formatDate(d0, CFG.TZ, 'yyyy-MM-dd') : String(d0).trim();
      if(dstr !== date){ kept.push(data[i]); continue; }
      if(onlyKeys && !onlyKeys[String(data[i][1] || '').trim()]) kept.push(data[i]);
    }
    var rowsN = 0, total = 0;
    fields.forEach(function(f){
      var name = String(f.name || '').trim(); if(!name) return;
      if(onlyKeys && !onlyKeys[name]) return;
      var funes = Math.max(0, Math.round((Number(f.funes) || 0) * 2) / 2);   // 2026-10-03〜 0.5舟単位
      kept.push([date, name, funes, now]);
      rowsN++;
    });
    sh.clearContents();
    sh.getRange(1, 1, kept.length, HEAD.length).setValues(kept.map(function(r){
      var a = r.slice(0, HEAD.length); while(a.length < HEAD.length) a.push(''); return a;
    }));
    // その日の全圃場（他PCの入力も含む）を返す＝画面はこれで最新に揃える（朝礼ボードは読まない＝軽い）
    var all = [];
    for(var j = 1; j < kept.length; j++){
      var dj = kept[j][0];
      var ds = (dj instanceof Date) ? Utilities.formatDate(dj, CFG.TZ, 'yyyy-MM-dd') : String(dj).trim();
      if(ds !== date) continue;
      var nm = String(kept[j][1] || '').trim(); if(!nm) continue;
      var fn = Number(kept[j][2]) || 0;
      all.push({ name: nm, funes: fn }); total += fn;
    }
    return { ok:true, saved: rowsN, date: date, total: total, fields: all };
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
  var ss = ssById_(CFG.DATA_SS_ID);
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
  var ss = ssById_(CFG.DATA_SS_ID);
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
  var ss = ssById_(CFG.DATA_SS_ID);
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
// ③ 資材管理アプリ：SKU（取引先×区分×入数）ごとの荷造数（発注書「発注書」シートを読み取りのみ）
//   資材管理アプリの「🔗 発注書から取得（GAS）」（applyLive）が期待する形で返す：
//     rows   … [{tori,kubun,irisu,funes}]  start〜end の累計c/s
//     future … [{tori,kubun,irisu,days:[[YYYY-MM-DD,c/s],...]}]  end の翌日以降（在庫切れ予定日の算出用）
//   ⚠2026-09-24まではここが進捗シートの「荷造数」列見出しを合計した {usage:{...}} を返しており、
//     applyLiveが期待する rows が無いため画面には必ず「データ形式が想定と違います」が出ていた
//     （＝広島ではSKU一覧が一度も発注書から更新されず、熊本の雛形のままだった原因）。
//   ?type=shizaiUsage&start=2026-08-03&end=2026-09-24
// ============================================================
function getShizaiUsage_(params){
  params = params || {};
  var sh = openOrderSheetReadOnly_(CFG.ORDER_MAIN_SHEET);
  if(!sh) return { error: 'シート「' + CFG.ORDER_MAIN_SHEET + '」が見つかりません' };
  var v = sh.getDataRange().getValues();
  var nameRow = findOrderNameRow_(v);
  if(nameRow < 0) return { error: '取引先の見出し行（西暦がある行）が見つかりませんでした' };
  var meta = detectDayColAndHeaderRows_(v);
  var cols = buildShizaiSkuCols_(v, nameRow);

  var start = params.start ? ymdFromParam_(params.start) : '';
  var end   = params.end   ? ymdFromParam_(params.end)   : todayYmd_();
  var sums = cols.map(function(){ return 0; });
  var future = cols.map(function(){ return []; });

  // 発注書は7月始まり＝年をまたぐ。月が戻ったら年を1つ進めて実日付を組み立てる
  var year = orderFiscalStartYear_();
  var prevMonth = 0;
  for(var r = meta.headerRows; r < v.length; r++){
    var md = cellMonthDay_(v[r][meta.dayCol]);
    if(!md) continue;
    if(prevMonth && md.m < prevMonth) year++;
    prevMonth = md.m;
    var ymd = year + '-' + pad2_(md.m) + '-' + pad2_(md.d);
    var isPast   = (!start || ymd >= start) && ymd <= end;
    var isFuture = ymd > end;
    if(!isPast && !isFuture) continue;
    for(var i = 0; i < cols.length; i++){
      var q = Number(v[r][cols[i].c]);
      if(!(q > 0)) continue;
      if(isPast) sums[i] += q;
      else if(future[i].length < 120) future[i].push([ymd, q]);
    }
  }

  var rows = cols.map(function(col, i){
    return { tori: col.name, kubun: col.kubun, irisu: col.nyusu, funes: sums[i] };
  });
  var fut = [];
  cols.forEach(function(col, i){
    if(future[i].length) fut.push({ tori: col.name, kubun: col.kubun, irisu: col.nyusu, days: future[i] });
  });
  return { asOf: todayYmd_(), start: start, end: end, rows: rows, future: fut };
}
// buildOrderCols_ とほぼ同じだが、個人注文・その他サンプルの列も「区分」を落とさずに返す
//   （資材管理アプリはSKUキーが 取引先|区分|入数 なので、区分が空だと取り込み対象から外れてしまう）
function buildShizaiSkuCols_(v, nameRow){
  var kubunRow = nameRow + 1, nyusuRow = nameRow + 2;
  var cols = [], lastName = '';
  var width = v[nameRow] ? v[nameRow].length : 0;
  for(var c = 1; c < width; c++){          // c=1（B列）始まり。ここを2にすると先頭の取引先が丸ごと抜ける
    var nm = normText_(v[nameRow][c]);
    if(nm) lastName = nm;
    var name = lastName;
    if(!name) continue;
    if(!NZ_KG_GROUP_RE.test(name) && NZ_EXCLUDE_RE.test(name)) continue;   // 合計・舟数などの集計列を除外
    var nyusu = Number(v[nyusuRow] ? v[nyusuRow][c] : NaN);
    if(!(nyusu > 0)) continue;
    var kubun = normText_(kubunRow < v.length ? v[kubunRow][c] : '');
    if(kubun === '土なし') kubun = '洗い';        // 発注書の表記ゆれを資材アプリ側の区分に合わせる
    if(/^[\d.]+$/.test(kubun)) kubun = '';
    if(!kubun) continue;                          // 区分が無い列は資材アプリが取り込まない
    cols.push({ c: c, name: name, nyusu: nyusu, kubun: kubun });
  }
  return cols;
}
function pad2_(n){ return (n < 10 ? '0' : '') + n; }
function todayYmd_(){ return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }
function ymdFromParam_(s){
  var m = String(s || '').match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  return m ? (m[1] + '-' + pad2_(Number(m[2])) + '-' + pad2_(Number(m[3]))) : '';
}
// 発注書は7月始まり（7月1日〜翌4月）。今日が7月以降ならその年、1〜6月なら前年が年度開始年
function orderFiscalStartYear_(){
  var t = new Date();
  var y = Number(Utilities.formatDate(t, CFG.TZ, 'yyyy'));
  var m = Number(Utilities.formatDate(t, CFG.TZ, 'M'));
  return (m >= 7) ? y : (y - 1);
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
  var ss = ssById_(CFG.DATA_SS_ID);
  var sheetName = findShiftSheetName_(ss, target);
  // その月のシフトシートが無い月（2026-10〜）は「会社休み以外は既存メンバー全員出勤」で組み立てる
  if(!sheetName) return shiftFromCompanyHoliday_(ss, target, ymd);
  var sh = ss.getSheetByName(sheetName);
  var v = sh.getDataRange().getValues();
  var head = findShiftDayHeaderRow_(v, target.getMonth() + 1);
  if(!head) return { error: 'シート「' + sheetName + '」で日付ヘッダー行（1日,2日,3日…の連番）が見つかりませんでした' };
  var day = target.getDate();
  var col = head.col0 + (day - 1);
  var workers = [], presentCount = 0;
  readShiftRoster_(v, head).forEach(function(x){
    var mark = normText_(v[x.row][col]);
    var present = (mark === CFG.MARK_PRESENT);
    if(present) presentCount++;
    workers.push({ name: x.name, mark: mark, present: present });
  });
  return { date: ymd, sheet: sheetName, source: 'sheet', workers: workers, presentCount: presentCount, totalCount: workers.length };
}
// シフト表の氏名行（日付ヘッダーの2行下〜「合計人数」の手前まで）
function readShiftRoster_(v, head){
  var out = [];
  var scanLimit = Math.min(v.length, head.row + 2 + 80);
  for(var r = head.row + 2; r < scanLimit; r++){
    var label = normText_(v[r][1]);
    if(label.indexOf('合計人数') >= 0) break;
    if(!label) continue;
    out.push({ name: label, row: r });
  }
  return out;
}

// ---- ⑥-b 会社休みシートからの出勤判定（2026-10-01追加・曽我さん依頼） ----
//   「会社休み」シート（DATA_SS_ID内。A=日付／B=種別）を見て、
//     ・載っていない日 … 既存メンバー全員出勤
//     ・B列が空欄や「盆休み」等 … 全員休み
//     ・B列が「役員出勤」 … CFG.SHIFT_YAKUIN_NAMES（中島 誠一郎）だけ出勤
//   既存メンバー＝対象日より前で一番新しい「R◯年◯月」シートの氏名行（無ければ一番新しいシート）。
function companyHolidayMap_(ss){
  var sh = ss.getSheetByName(CFG.SHIFT_HOLIDAY_SHEET || '会社休み');
  var map = {};
  if(!sh) return null;
  var v = sh.getDataRange().getValues();
  for(var r = 1; r < v.length; r++){
    var a = v[r][0], key = '';
    if(a instanceof Date) key = Utilities.formatDate(a, CFG.TZ, 'yyyy-MM-dd');
    else key = ymdFromParam_(a);
    if(!key) continue;
    map[key] = normText_(v[r][1]);
  }
  return map;
}
function latestShiftRosterNames_(ss, target){
  var want = (target.getFullYear() - 2018) * 100 + (target.getMonth() + 1);
  var best = null, bestAny = null;
  ss.getSheets().forEach(function(s){
    var m = s.getName().match(/^R(\d+)年(\d+)月$/);
    if(!m) return;
    var k = Number(m[1]) * 100 + Number(m[2]);
    if(k <= want && (!best || k > best.k)) best = { k: k, sh: s, month: Number(m[2]) };
    if(!bestAny || k > bestAny.k) bestAny = { k: k, sh: s, month: Number(m[2]) };
  });
  var pick = best || bestAny;
  if(!pick) return { names: [], sheet: '' };
  var v = pick.sh.getDataRange().getValues();
  var head = findShiftDayHeaderRow_(v, pick.month);
  if(!head) return { names: [], sheet: pick.sh.getName() };
  return { names: readShiftRoster_(v, head).map(function(x){ return x.name; }), sheet: pick.sh.getName() };
}
function shiftFromCompanyHoliday_(ss, target, ymd){
  var roster = latestShiftRosterNames_(ss, target);
  if(!roster.names.length) return { error: 'メンバーの元になる「R◯年◯月」シフトシートが見つかりません' };
  var hol = companyHolidayMap_(ss);
  if(!hol) return { error: '「' + (CFG.SHIFT_HOLIDAY_SHEET || '会社休み') + '」シートが見つかりません' };
  var kind = Object.prototype.hasOwnProperty.call(hol, ymd) ? hol[ymd] : null;   // null＝通常出勤日
  var yakuin = {};
  (CFG.SHIFT_YAKUIN_NAMES || []).forEach(function(n){ yakuin[normText_(n)] = true; });
  var isYakuinDay = (kind !== null && kind.indexOf('役員出勤') >= 0);
  var workers = [], presentCount = 0;
  roster.names.forEach(function(nm){
    var present = (kind === null) || (isYakuinDay && !!yakuin[nm]);
    if(present) presentCount++;
    workers.push({ name: nm, mark: present ? CFG.MARK_PRESENT : '休', present: present });
  });
  return {
    date: ymd, sheet: roster.sheet, source: 'holiday',
    dayKind: (kind === null) ? '出勤日' : (isYakuinDay ? '役員出勤' : ('会社休み' + (kind ? '（' + kind + '）' : ''))),
    workers: workers, presentCount: presentCount, totalCount: workers.length
  };
}

// ---- 力量表（○/△/×。曽我さんがスプレッドシートを直接編集して調整する運用。保存APIは無い） ----
function haichiSkillSheet_(rosterNames){
  var ss = ssById_(CFG.DATA_SS_ID);
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
  var ss = ssById_(CFG.DATA_SS_ID);
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
  var ss = ssById_(CFG.DATA_SS_ID);
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
  var ss = ssById_(CFG.DATA_SS_ID);
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
    _NZ_STATE_MEMO_ = null;
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
  var ss = ssById_(CFG.DATA_SS_ID);
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
    var orderSs = ssById_(CFG.ORDER_SS_ID);
    out.orderSheetNames = orderSs.getSheets().map(function(s){ return s.getName(); });
  }catch(e){ out.orderSheetError = String(e); }
  try{
    var dataSs = ssById_(CFG.DATA_SS_ID);
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

// ============================================================
// ⑫ TODOリスト（2026-09-24追加・曽我さん依頼。センター電子黒板の「センターTODOマスタ」と同じ仕組み）
//   ・マスタ＝DATA_SS_ID内「広島TODOマスタ」（A=業務／B=頻度、1行目は見出し）。
//     このシートに行を足すだけで黒板に出る（GAS再デプロイ不要）。無ければ見出しだけ自動作成。
//   ・チェック状態は別に持たず、「TODO履歴」シートへ操作を1行ずつ追記し、
//     指定日の各業務の最新行（＝毎回降順ソートしているので先頭）から組み立てる＝操作履歴も残る。
//   ・GET  ?type=todoMaster&date=yyyy-MM-dd → { date, items:[{task,freq}], state:{業務名:true,…} }
//   ・POST { action:'todoLog', date, task, freq, checked:true/false, by } → 履歴へ1行追記
//   ※2026-09-29：会社全体カレンダーの【広島】予定もTODOに出す（⑫-c todoCalendarList_）。
// ============================================================
function todoMasterSheet_(){
  var ss = ssById_(CFG.DATA_SS_ID);
  var name = CFG.TODO_MASTER_SHEET;
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(['業務', '頻度']);
    try{ sh.setFrozenRows(1); }catch(e){}
  }
  return sh;
}
function todoMasterList_(){
  var sh = todoMasterSheet_();
  var last = sh.getLastRow();
  if(last < 2) return [];
  var v = sh.getRange(2, 1, last - 1, 2).getValues();
  var out = [];
  for(var r = 0; r < v.length; r++){
    var task = String(v[r][0] == null ? '' : v[r][0]).trim();
    if(!task) continue;
    out.push({ task: task, freq: String(v[r][1] == null ? '' : v[r][1]).trim() });
  }
  return out;
}
function todoLogSheet_(){
  var ss = ssById_(CFG.DATA_SS_ID);
  var name = CFG.TODO_LOG_SHEET;
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(['日付', '業務', '頻度', '操作', '更新日時', '端末']);
    try{ sh.setFrozenRows(1); }catch(e){}
  }
  return sh;
}
// 指定日の各業務の最新チェック状態（チェック中のものだけ {業務名:true} で持つ）
function getTodoState_(dateStr){
  var sh = todoLogSheet_();
  var last = sh.getLastRow();
  if(last < 2) return {};
  var v = sh.getRange(2, 1, last - 1, 6).getValues();
  var state = {}, seen = {};
  for(var r = 0; r < v.length; r++){
    var d = v[r][0];
    var dstr = (d instanceof Date) ? Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd') : String(d == null ? '' : d).trim();
    if(dstr !== dateStr) continue;
    var task = String(v[r][1] == null ? '' : v[r][1]).trim();
    if(!task || seen[task]) continue;
    seen[task] = true;                                   // 降順ソート済み＝最初に出会った行が最新
    if(String(v[r][3] == null ? '' : v[r][3]).trim() === 'チェック') state[task] = true;
  }
  return state;
}
// ============================================================
// ⑫-b 頻度による出し分け（2026-09-26追加・曽我さん依頼）
//   B列「頻度」の書き方から「その日に出すかどうか」を判定する。
//   ★スプレッドシートの書き方は今まで通りでよい＝日本語の頻度表記をそのまま解釈する。
//   ★**解釈できない書き方は「毎日出す」**（＝従来どおり）。新しい書き方を足しても
//     急にTODOが消えない、という安全側の設計にしてある。
//
//   | 書き方の例                  | 出る日                     |
//   |----------------------------|---------------------------|
//   | （空欄）／毎日／随時         | 毎日                       |
//   | 平日                        | 月〜金                     |
//   | 毎週月曜日／月曜／毎週月水    | その曜日だけ                |
//   | 第4月曜日（毎月）            | 毎月の第4月曜だけ           |
//   | 第2・第4金曜日               | 第2と第4の金曜だけ          |
//   | 最終金曜日                   | その月の最後の金曜だけ       |
//   | 毎月25日／25日               | 毎月25日だけ               |
//   | 月末                        | その月の最終日だけ          |
//   | 週1／月1 など（回数だけ）     | 毎日（ラベル扱い・従来どおり）|
// ============================================================
var TODO_WDAY_ = { '日':0, '月':1, '火':2, '水':3, '木':4, '金':5, '土':6 };

function todoParseYmd_(s){
  var m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function todoNormFreq_(s){
  return String(s == null ? '' : s)
    .replace(/[０-９]/g, function(c){ return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/\s|　/g, '')
    .trim();
}
function todoFreqMatches_(freq, dateStr){
  var s = todoNormFreq_(freq);
  if(!s) return true;                                   // 空欄＝毎日
  if(/毎日|日次|随時|都度/.test(s)) return true;

  var d = todoParseYmd_(dateStr);
  if(!d) return true;                                   // 日付が解釈できない時は出す（安全側）
  var dow = d.getDay();
  var dom = d.getDate();
  var lastDom = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

  // ① 曜日を拾う：「◯曜」の形を最優先（「毎月25日」の“月”を曜日と誤解しないため）
  var days = [], m;
  var re1 = /([日月火水木金土])曜/g;
  while((m = re1.exec(s)) !== null) days.push(TODO_WDAY_[m[1]]);
  if(!days.length){
    // 「毎週月水」のように“曜”を省いた書き方も拾う
    var m2 = s.match(/毎週([日月火水木金土・、,]+)/);
    if(m2){
      var chars = m2[1].split('');
      for(var i = 0; i < chars.length; i++){
        if(TODO_WDAY_.hasOwnProperty(chars[i])) days.push(TODO_WDAY_[chars[i]]);
      }
    }
  }

  // ② 「第N」を拾う（第2・第4 のように複数可）／「最終・最後」も拾う
  var nths = [], re2 = /第(\d+)/g;
  while((m = re2.exec(s)) !== null) nths.push(Number(m[1]));
  var wantLastWeek = /最終|最後/.test(s);

  // ③ 「◯日」（日にち指定）を拾う。※「第4月曜日」の“日”には数字が前に付かないので拾われない
  var doms = [], re3 = /(\d+)日/g;
  while((m = re3.exec(s)) !== null){
    var n = Number(m[1]);
    if(n >= 1 && n <= 31) doms.push(n);
  }

  if(days.length){
    if(days.indexOf(dow) < 0) return false;
    if(nths.length){
      var nth = Math.floor((dom - 1) / 7) + 1;          // その月で何回目のその曜日か
      return nths.indexOf(nth) >= 0;
    }
    if(wantLastWeek) return (dom + 7) > lastDom;        // 同じ曜日が今月もう来ない＝最終
    return true;                                        // 曜日指定だけ＝毎週その曜日
  }
  if(doms.length) return doms.indexOf(dom) >= 0;
  if(/月末/.test(s)) return dom === lastDom;
  if(/月初/.test(s)) return dom === 1;
  if(/平日/.test(s)) return dow >= 1 && dow <= 5;

  return true;   // 「週1」「月1」等の回数ラベル＝解釈しない＝毎日出す（従来どおり）
}

function getTodoBoard_(dateStr){
  dateStr = String(dateStr || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var all = todoMasterList_();
  var items = [], seen = {};
  for(var i = 0; i < all.length; i++){
    if(todoFreqMatches_(all[i].freq, dateStr)){ items.push(all[i]); seen[all[i].task] = true; }
  }
  // ⑫-c カレンダーの【広島】予定を後ろに足す（マスタと同名ならマスタ側を優先＝二重に出さない）
  var cal = todoCalendarList_(dateStr);
  for(var j = 0; j < cal.items.length; j++){
    if(seen[cal.items[j].task]) continue;
    seen[cal.items[j].task] = true;
    items.push(cal.items[j]);
  }
  // masterCount＝マスタの総件数。フロントは「マスタが空」と「本日は該当なし」を
  // これで区別してメッセージを出し分ける（カレンダー連携分も「登録あり」として数える）。
  return { date: dateStr, items: items, masterCount: all.length + cal.items.length,
           calendarError: cal.error || '', state: getTodoState_(dateStr) };
}
// ⑫-c Googleカレンダー（CFG.TODO_CALENDAR_ID＝会社全体カレンダー）の指定日の予定のうち、タイトルに
//   【広島】が付いたものだけを拾い、【広島】を取り除いた残りをTODOの業務名にする
//   （例：「【広島】消防設備点検 10:00」→「消防設備点検 10:00」。時刻付きの予定は頻度欄に時刻を出す）。
//   複数日にまたがる予定は、またがる各日に出る。取得できない時は空＋errorを返すだけ＝他の機能に影響させない。
function todoCalendarList_(dateStr){
  try{
    var calId = CFG.TODO_CALENDAR_ID;
    if(!calId) return { items: [] };
    var cal = CalendarApp.getCalendarById(calId);
    if(!cal){
      // 共有はされているが自分のカレンダー一覧に未登録の場合は、一度だけ登録してから読む
      try{ cal = CalendarApp.subscribeToCalendar(calId, { hidden: true }); }catch(e){}
    }
    if(!cal) return { items: [], error: 'カレンダー ' + calId + ' を開けません（共有設定を確認してください）' };
    var p = String(dateStr).split('-').map(Number);
    var start = new Date(p[0], p[1] - 1, p[2]);
    var end = new Date(p[0], p[1] - 1, p[2] + 1);
    var events = cal.getEvents(start, end);
    var re = CFG.TODO_CALENDAR_TAG_RE;
    var out = [], seen = {};
    for(var i = 0; i < events.length; i++){
      var title = String(events[i].getTitle() || '').trim();
      if(!re.test(title)) continue;
      var task = title.replace(new RegExp(re.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
      if(!task || seen[task]) continue;
      seen[task] = true;
      var freq = '📅予定';
      if(!events[i].isAllDayEvent()){
        var st = events[i].getStartTime();
        if(Utilities.formatDate(st, CFG.TZ, 'yyyy-MM-dd') === dateStr) freq = '📅' + Utilities.formatDate(st, CFG.TZ, 'H:mm');
      }
      out.push({ task: task, freq: freq, cal: true });
    }
    return { items: out };
  }catch(err){
    return { items: [], error: String(err && err.message || err) };
  }
}
// エディタから▶実行：カレンダー連携の疎通確認（★初回はここで「カレンダーへのアクセス」の承認ダイアログが出る）
//   今日から14日ぶん、【広島】の予定がどの日のTODOに出るかをログに出す。
function testTodoCalendar(){
  var base = new Date(), lines = [];
  var cal = CalendarApp.getCalendarById(CFG.TODO_CALENDAR_ID);
  lines.push('カレンダー：' + (cal ? cal.getName() : '開けません（共有・IDを確認）'));
  for(var i = 0; i < 14; i++){
    var ds = Utilities.formatDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i), CFG.TZ, 'yyyy-MM-dd');
    var r = todoCalendarList_(ds);
    lines.push(ds + '  ' + (r.error ? ('エラー：' + r.error) : (r.items.length ? r.items.map(function(x){ return x.task + '(' + x.freq + ')'; }).join(' / ') : '―')));
  }
  Logger.log(lines.join('\n'));
}
// 頻度の書き方が意図どおり解釈されているか、1週間ぶん並べて確認する（エディタから▶実行）
function testTodoFreq(){
  var all = todoMasterList_();
  var base = new Date();
  var lines = [];
  for(var i = 0; i < 14; i++){
    var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    var ds = Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd');
    var wd = ['日','月','火','水','木','金','土'][d.getDay()];
    var hit = [];
    for(var j = 0; j < all.length; j++){
      if(todoFreqMatches_(all[j].freq, ds)) hit.push(all[j].task);
    }
    lines.push(ds + '(' + wd + ')  ' + (hit.length ? hit.join(' / ') : '―'));
  }
  Logger.log(lines.join('\n'));
}
function todoLogAppend_(body){
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){ return { ok:false, error:'busy（他の保存処理中）' }; }
  try{
    var sh = todoLogSheet_();
    var date = String(body.date || '').trim() || Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    var task = String(body.task || '').trim();
    if(!task) return { ok:false, error:'業務名が空です' };
    var freq = String(body.freq || '').trim();
    var now  = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    var action = body.checked ? 'チェック' : '解除';
    sh.appendRow([date, task, freq, action, now, String(body.by || '')]);
    // 日付列は文字列固定（生産ログと同じ理由＝Date型だとシートのタイムゾーンで前日にずれることがある）
    var lastRow = sh.getLastRow();
    sh.getRange(lastRow, 1).setNumberFormat('@').setValue(date);
    todoSortLogDesc_(sh);
    return { ok:true, date:date, task:task, action:action };
  }catch(err){
    return { ok:false, error:String(err && err.message || err) };
  }finally{
    try{ lock.releaseLock(); }catch(e){}
  }
}
// 「更新日時」（E列）の降順に並べ替え＝getTodoState_が先頭行だけ見れば最新状態になる
function todoSortLogDesc_(sh){
  try{
    var last = sh.getLastRow();
    if(last < 3) return;
    sh.getRange(2, 1, last - 1, 6).sort({ column: 5, ascending: false });
  }catch(e){}
}
function testTodo(){ Logger.log(JSON.stringify(getTodoBoard_(''), null, 2)); }

// ============================================================
// ⑬ Slack連携お知らせ（2026-09-24追加・曽我さん依頼。広島専用チャンネル）
//   センターの「MD部お知らせ連携」GASと同じ仕組みを、別プロジェクトを作らずこのGASに同居させた
//   （センターは専用GASを別に立てているが、広島は既に1つのGASに全部入っているのでそちらに合わせた）。
//
//   ★必要な設定（Apps Scriptエディタ ⚙プロジェクトの設定 → スクリプト プロパティ）：
//       SLACK_BOT_TOKEN  … Slackアプリの Bot User OAuth Token（xoxb-…）
//       SLACK_CHANNEL_ID … 広島用チャンネルのID（C…）
//   ★Slack側：そのチャンネルで /invite @＜アプリ名＞ してBotを招待しておくこと。
//   未設定のあいだは {error:…} を返すだけ＝黒板側は「お知らせはありません」と出るだけで他は壊れない。
//
//   返す各要素：{ from, posted:'yyyy-MM-dd', time:'HH:mm', body, nizukuri:Boolean }
//   投稿の先頭に【荷造り】を付けると nizukuri:true になり、黒板の本日荷造りタブにも注意文が出る。
// ============================================================
function getNewsCached_(force){
  var key = 'HB_NEWS';
  if(!force){
    var raw = cacheGet_(key);
    if(raw){ try{ return JSON.parse(raw); }catch(e){} }
  }
  var out;
  try{ out = { items: fetchHiroshimaNotices_() }; }
  catch(err){ out = { error: String((err && err.message) || err), items: [] }; }
  out.fetchedAt = Utilities.formatDate(new Date(), CFG.TZ, 'HH:mm:ss');
  // エラー（未設定・権限不足）も短くキャッシュして、Slackを叩き続けないようにする
  cachePut_(key, JSON.stringify(out), CFG.NEWS_CACHE_SEC);
  return out;
}
// 資材アプリ「繁忙期の全資材 再確認」の報告を広島チャンネルへ投稿する（2026-10-02追加）。
//   Botに chat:write 権限が無い等で失敗しても {ok:false,error} を返すだけ（資材アプリ側は記録を優先して続行する）。
function slackPost_(body){
  body = body || {};
  var msg = String(body.msg || '').trim().slice(0, 300);
  if(!msg) return { ok:false, error:'msg が空です' };
  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('SLACK_BOT_TOKEN') || '';
  var channel = props.getProperty('SLACK_CHANNEL_ID') || '';
  if(!token || !channel) return { ok:false, error:'SLACK_BOT_TOKEN / SLACK_CHANNEL_ID が未設定です' };
  var res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ channel: channel, text: msg }),
    muteHttpExceptions: true
  });
  var data = {};
  try{ data = JSON.parse(res.getContentText()) || {}; }catch(e){}
  if(!data.ok) return { ok:false, error:'Slack: ' + (data.error || ('HTTP ' + res.getResponseCode())) + (data.error === 'missing_scope' ? '（Botに chat:write 権限がありません）' : '') };
  return { ok:true };
}
function fetchHiroshimaNotices_(){
  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('SLACK_BOT_TOKEN') || '';
  var channel = props.getProperty('SLACK_CHANNEL_ID') || '';
  if(!token || !channel){
    throw new Error('SLACK_BOT_TOKEN / SLACK_CHANNEL_ID をスクリプトプロパティに設定してください');
  }
  var oldest = Math.floor((Date.now() - CFG.NEWS_SHOW_DAYS * 24 * 60 * 60 * 1000) / 1000);
  var url = 'https://slack.com/api/conversations.history'
          + '?channel=' + encodeURIComponent(channel)
          + '&oldest='  + oldest
          + '&limit=200';
  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  var data = JSON.parse(res.getContentText());
  if(!data.ok){
    throw new Error('Slack APIエラー: ' + data.error
      + '（Botをチャンネルに /invite したか、channels:history / groups:history / users:read 権限を確認）');
  }
  var out = [];
  (data.messages || []).forEach(function(m){
    if(m.subtype && m.subtype !== 'thread_broadcast') return;   // 参加通知・bot投稿はスキップ
    if(!m.text || !String(m.text).trim()) return;
    var raw  = newsCleanText_(m.text);
    var isNz = CFG.NEWS_NIZUKURI_TAG_RE.test(raw);
    var body = isNz ? raw.replace(CFG.NEWS_NIZUKURI_TAG_RE, '').trim() : raw;
    if(!body) return;
    var when = new Date(Number(m.ts) * 1000);
    out.push({
      from:     newsUserName_(token, m.user),
      posted:   Utilities.formatDate(when, CFG.TZ, 'yyyy-MM-dd'),
      time:     Utilities.formatDate(when, CFG.TZ, 'HH:mm'),
      body:     body,
      nizukuri: isNz
    });
  });
  out.sort(function(a, b){
    if(a.posted !== b.posted) return a.posted < b.posted ? 1 : -1;
    return a.time < b.time ? 1 : (a.time > b.time ? -1 : 0);
  });
  return out;
}
// Slackのメンション記法・装飾を軽く整形（センターの cleanText_ と同じ）
function newsCleanText_(t){
  return String(t)
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/<@[A-Z0-9]+>/g, '@さん')
    .replace(/[*_~`]/g, '')
    .trim();
}
// user_id → 表示名（6時間キャッシュ。毎回users.infoを叩くと遅くなるため）
function newsUserName_(token, userId){
  if(!userId) return CFG.NEWS_FALLBACK_NAME;
  var cache = CacheService.getScriptCache();
  var hit = cache.get('hbu_' + userId);
  if(hit) return hit;
  try{
    var res = UrlFetchApp.fetch('https://slack.com/api/users.info?user=' + userId, {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    var d = JSON.parse(res.getContentText());
    var name = CFG.NEWS_FALLBACK_NAME;
    if(d.ok && d.user){
      var p = d.user.profile || {};
      name = p.display_name || d.user.real_name || p.real_name || d.user.name || CFG.NEWS_FALLBACK_NAME;
    }
    cache.put('hbu_' + userId, name, 6 * 60 * 60);
    return name;
  }catch(err){ return CFG.NEWS_FALLBACK_NAME; }
}
// エディタから▶実行して疎通確認（取得件数と先頭のお知らせがログに出る）
function testNews(){ Logger.log(JSON.stringify(getNewsCached_(true), null, 2)); }

// ⑭ 高速化の効き具合を測る（キャッシュ無しで組み立てた時間と、キャッシュ経由の時間をログに出す）
function testBundleSpeed(){
  var t0 = Date.now(); getBundleCached_({ nocache:'1' }); var t1 = Date.now();
  getBundleCached_({ maxAge:'600' }); var t2 = Date.now();
  Logger.log('組み立て（キャッシュ無し）: ' + ((t1 - t0) / 1000) + '秒 ／ キャッシュ経由: ' + ((t2 - t1) / 1000) + '秒');
}
