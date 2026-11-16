/**
 * 電子ペーパーカレンダー用の予定配信（Google Apps Script）
 *
 * 設定はすべて「プロジェクトの設定」→「スクリプト プロパティ」に置く（このファイルには書かない）
 *   TOKEN         … 合言葉。setup() が自動で作る
 *   CALENDAR_IDS  … 表示するカレンダーのID。複数ならカンマ区切り。空なら祝日・誕生日以外の全カレンダー
 *   TASKLIST_IDS  … メモ欄に出すToDoリストのID。複数ならカンマ区切り。空ならすべてのリスト
 *   ALERT_TO      … 不審なアクセスの通知先メールアドレス。空ならこのスクリプトの持ち主
 *
 * 事前に、エディタ左の「サービス」の＋から「Tasks API」を追加しておくこと（メモ欄用）
 *
 * 初回
 *  1. このコードを貼り付けて保存し、関数「setup」を実行（権限の許可が必要）→ ログに合言葉が出る
 *  2. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *  3. iPad用URL：https://satosu-n.github.io/epaper-calendar/#d=デプロイID&k=合言葉
 *
 * コードを更新したとき
 *  ・中身を丸ごと貼り替えて保存 →「デプロイを管理」→ 鉛筆 →「新バージョン」→「デプロイ」（デプロイIDは変わらない）
 *
 * URLが漏れたかもしれないとき
 *  ・すぐ止める：「デプロイを管理」で今のデプロイをアーカイブ（URLが即座に無効になる）
 *  ・合言葉だけ変える：関数「resetToken」を実行し、iPad用URLを作り直す
 */

const HOLIDAY_ID = 'ja.japanese#holiday@group.v.calendar.google.com';
const TZ = 'Asia/Tokyo';
const PAST_DAYS = 62;     // 取得できる範囲：今日から約2か月前まで
const FUTURE_DAYS = 366;  // 取得できる範囲：今日から1年先まで
const ALERT_INTERVAL_MIN = 60; // 不審なアクセスのメール通知は、多くてもこの間隔で1通

function doGet(e) {
  const p = (e && e.parameter) || {};
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TOKEN');
  if (!token || p.k !== token) {
    recordFailure_(props);
    return json_({ error: 'forbidden' });
  }

  let from = parse_(p.from), to = parse_(p.to);
  if (!from || !to || to < from) return json_({ error: 'bad range' });

  // 取得できる期間を制限する
  const today = parse_(fmt_(new Date(), 'yyyy-MM-dd'));
  const min = new Date(today.getTime() - PAST_DAYS * 864e5);
  const max = new Date(today.getTime() + FUTURE_DAYS * 864e5);
  if (from < min) from = min;
  if (to > max) to = max;

  const ev = [], h = {};
  if (from <= to) {
    const end = new Date(to.getTime() + 864e5); // toの日の終わりまで
    calendars_(props).forEach(c => c.getEvents(from, end).forEach(x => ev.push(conv_(x))));

    // 祝日（Googleの「日本の祝日」。節分などの行事は除く）
    const hc = CalendarApp.getCalendarById(HOLIDAY_ID);
    if (hc) {
      hc.getEvents(from, end).forEach(x => {
        const d = x.getDescription() || '';
        if (d && !/祝日|休日/.test(d)) return;
        h[fmt_(x.getAllDayStartDate(), 'yyyy-MM-dd')] = x.getTitle();
      });
    }
  }
  return json_({ ev: ev, h: h, m: memo_(props), at: fmt_(new Date(), 'H:mm'), w: recentFailures_(props) });
}

// メモ欄：Google ToDoの未完了タスク。期限が近い順（期限なしは後ろ）。月ごとの絞り込みは画面側で行う
function memo_(props) {
  if (typeof Tasks === 'undefined') return null; // Tasks API が未追加
  try {
    let ids = (props.getProperty('TASKLIST_IDS') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) ids = (Tasks.Tasklists.list({ maxResults: 100 }).items || []).map(l => l.id);
    const out = [];
    ids.forEach(id => {
      let pageToken;
      do {
        const r = Tasks.Tasks.list(id, { showCompleted: false, showHidden: false, maxResults: 100, pageToken: pageToken });
        (r.items || []).forEach(t => { if (t.title) out.push({ t: t.title, due: t.due ? t.due.slice(0, 10) : '', p: t.position || '' }); });
        pageToken = r.nextPageToken;
      } while (pageToken);
    });
    out.sort((a, b) => (a.due || '9') < (b.due || '9') ? -1 : (a.due || '9') > (b.due || '9') ? 1 : (a.p < b.p ? -1 : 1));
    return out.slice(0, 500).map(x => ({ t: x.t, due: x.due }));
  } catch (err) {
    console.error('ToDoを読めませんでした: ' + err);
    return null;
  }
}

function calendars_(props) {
  const ids = (props.getProperty('CALENDAR_IDS') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length) return ids.map(id => CalendarApp.getCalendarById(id)).filter(Boolean);
  return CalendarApp.getAllCalendars().filter(c => !/holiday@group\.v\.calendar|#contacts@/.test(c.getId()));
}

// 予定1件を画面用の形に変換。s〜e は両端を含む日付。
function conv_(x) {
  let s, e, tm = '';
  if (x.isAllDayEvent()) {
    s = x.getAllDayStartDate();
    e = new Date(x.getAllDayEndDate().getTime() - 864e5); // 終了日は翌日表記なので1日戻す
  } else {
    s = x.getStartTime();
    e = new Date(x.getEndTime().getTime() - 1); // 0:00ちょうどに終わる予定は前日まで
    if (e < s) e = s;
    tm = fmt_(s, 'H:mm');
  }
  const sd = fmt_(s, 'yyyy-MM-dd'), ed = fmt_(e, 'yyyy-MM-dd');
  return { k: x.getId() + '@' + sd + tm, t: x.getTitle(), s: sd, e: ed < sd ? sd : ed, tm: tm };
}

// ---- 不審なアクセス（合言葉の違うアクセス）の記録と通知 ----
function recordFailure_(props) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    const now = Date.now();
    const log = JSON.parse(props.getProperty('FAIL_LOG') || '[]').filter(t => now - t < 864e5);
    log.push(now);
    props.setProperty('FAIL_LOG', JSON.stringify(log.slice(-200)));
    const last = +(props.getProperty('FAIL_MAILED') || 0);
    if (now - last >= ALERT_INTERVAL_MIN * 60000) {
      try {
        sendAlert_(log.length, now);
        props.setProperty('FAIL_MAILED', String(now)); // 送れたときだけ間隔をあける
      } catch (err) {
        console.error('通知メールを送れませんでした: ' + err);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function sendAlert_(count, now) {
  MailApp.sendEmail(alertTo_(),
    '【電子ペーパーカレンダー】合言葉の違うアクセスがありました',
    '直近24時間で ' + count + ' 件、合言葉の違うアクセスがありました（最新：' +
    fmt_(new Date(now), 'M月d日 H:mm') + '）。\n\n' +
    '心当たりがない場合は、Apps Scriptで次のどちらかを行ってください。\n' +
    '・すぐ止める：「デプロイ」→「デプロイを管理」で今のデプロイをアーカイブ\n' +
    '・合言葉を変える：関数「resetToken」を実行し、iPad用URLを作り直す\n\n' +
    '（この通知は多くても' + ALERT_INTERVAL_MIN + '分に1通です）');
}

// 送り先：スクリプト プロパティ ALERT_TO があればそこへ、なければこのスクリプトの持ち主
function alertTo_() {
  return PropertiesService.getScriptProperties().getProperty('ALERT_TO') || Session.getEffectiveUser().getEmail();
}

function recentFailures_(props) {
  const now = Date.now();
  return JSON.parse(props.getProperty('FAIL_LOG') || '[]').filter(t => now - t < 864e5).length;
}

// ---- 手動で実行する関数 ----
function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  ['CALENDAR_IDS', 'TASKLIST_IDS', 'ALERT_TO'].forEach(k => { if (props.getProperty(k) === null) props.setProperty(k, ''); });
  CalendarApp.getAllCalendars();            // カレンダーの権限の確認用
  MailApp.getRemainingDailyQuota();         // メール送信の権限の確認用
  Logger.log('合言葉: ' + token);
  Logger.log('通知の送り先: ' + alertTo_());
  Logger.log('表示するカレンダー: ' + (props.getProperty('CALENDAR_IDS') || '（全カレンダー）'));
  const m = memo_(props);
  Logger.log(m === null ? 'メモ欄：Tasks API が追加されていないか、読めませんでした' : 'メモ欄：未完了のタスク ' + m.length + ' 件');
  Logger.log('iPad用URL: https://satosu-n.github.io/epaper-calendar/#d=（デプロイID）&k=' + token);
}

function resetToken() {
  const props = PropertiesService.getScriptProperties();
  const token = Utilities.getUuid().replace(/-/g, '');
  props.setProperty('TOKEN', token);
  props.deleteProperty('FAIL_LOG');
  Logger.log('新しい合言葉: ' + token);
  Logger.log('iPad用URLを作り直してください: https://satosu-n.github.io/epaper-calendar/#d=（デプロイID）&k=' + token);
}

// 通知メールのテスト：実行するとすぐに1通送る
function testAlert() {
  sendAlert_(0, Date.now());
  Logger.log('テストメールを送りました: ' + alertTo_() + '（残り送信可能数: ' + MailApp.getRemainingDailyQuota() + '）');
}

function listCalendars() {
  CalendarApp.getAllCalendars().forEach(c => Logger.log(c.getName() + '  →  ' + c.getId()));
}

function listTaskLists() {
  (Tasks.Tasklists.list({ maxResults: 100 }).items || []).forEach(l => Logger.log(l.title + '  →  ' + l.id));
}

function parse_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  return Utilities.parseDate(s, TZ, 'yyyy-MM-dd');
}
function fmt_(d, f) { return Utilities.formatDate(d, TZ, f); }
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
