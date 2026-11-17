/**
 * 電子ペーパーカレンダー用の予定配信（Google Apps Script）
 *
 * 設定はすべて「プロジェクトの設定」→「スクリプト プロパティ」に置く（このファイルには書かない）
 *   TOKEN         … 合言葉。setup() が自動で作る
 *   CALENDAR_IDS  … 表示するカレンダーのID。複数ならカンマ区切り。空なら祝日・誕生日以外の全カレンダー
 *   TASKLIST_IDS  … メモ欄に出すToDoリストのID。複数ならカンマ区切り。空ならすべてのリスト
 *   ALERT_TO      … 不審なアクセスの通知先メールアドレス。空ならこのスクリプトの持ち主
 *   ADD_CALENDAR_ID … 壁から予定を追加するカレンダーのID（家族の共有カレンダー）。空なら追加は使えない
 *
 * 予定の追加（壁の「＋予定を追加」）の安全のための制限
 *  ・書き込めるのは ADD_CALENDAR_ID のカレンダーだけ
 *  ・日付は今日から1年先まで、予定名は60文字まで、同じ日のうちに終わる予定だけ
 *  ・追加できるのは1日20件まで
 *  ・壁から登録した予定には見えない目印（タグ epc=wall）を付ける。「取り消す」で消せるのは、
 *    この目印があり、登録から2分以内の予定だけ（既存の予定は消せない）
 *
 * メモの完了（壁のメモ欄をタップ →「完了にする」）の安全のための制限
 *  ・できるのは「完了にする」と、壁から完了にした直後（2分以内）の「未完了に戻す」だけ（削除・変更・作成はしない）
 *  ・完了にできるのは、メモ欄に出す範囲（TASKLIST_IDS のリスト、期限が取得期間内、未完了）のタスクだけ
 *  ・壁から完了にできるのは1日30件まで
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
const ADD_MAX_PER_DAY = 20;    // 壁から追加できる予定は1日にこの件数まで
const UNDO_MINUTES = 2;        // 「取り消す」で消せるのは、登録からこの分数以内の予定だけ
const TITLE_MAX = 60;          // 予定名の最大文字数
const DONE_MAX_PER_DAY = 30;   // 壁からメモを完了にできるのは1日にこの件数まで

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
  const minS = fmt_(min, 'yyyy-MM-dd'), maxS = fmt_(max, 'yyyy-MM-dd');
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
  return json_({ ev: ev, h: h, m: memo_(props, minS, maxS), at: fmt_(new Date(), 'H:mm'), w: recentFailures_(props),
    add: !!(props.getProperty('ADD_CALENDAR_ID') || '').trim() });
}

// ---- 予定の追加・取り消し（壁の「＋予定を追加」から） ----
// 本文（JSON）：{ k: 合言葉, act: 'add', d: 'yyyy-MM-dd', t: 予定名, s: 'H:mm'（空なら終日）, e: 'H:mm'（空なら1時間） }
//              { k: 合言葉, act: 'undo', id: 追加したときに返したID }
function doPost(e) {
  let p;
  try { p = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ error: 'bad request' }); }
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TOKEN');
  if (!token || p.k !== token) {
    recordFailure_(props);
    return json_({ error: 'forbidden' });
  }
  if (p.act === 'done') return json_(doneTask_(props, p));
  if (p.act === 'undone') return json_(undoneTask_(props, p));
  const calId = (props.getProperty('ADD_CALENDAR_ID') || '').trim();
  const cal = calId ? CalendarApp.getCalendarById(calId) : null;
  if (!cal) return json_({ error: 'add disabled' });
  if (p.act === 'add') return json_(addEvent_(props, cal, p));
  if (p.act === 'undo') return json_(undoEvent_(cal, p));
  return json_({ error: 'bad request' });
}

function addEvent_(props, cal, p) {
  const title = String(p.t || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!title || title.length > TITLE_MAX) return { error: 'bad title' };
  const day = parse_(p.d);
  const today = parse_(fmt_(new Date(), 'yyyy-MM-dd'));
  if (!day || day < today || day > new Date(today.getTime() + FUTURE_DAYS * 864e5)) return { error: 'bad date' };
  let start = null, end = null;
  if (p.s) {
    const sm = minutes_(p.s);
    const em = p.e ? minutes_(p.e) : (sm === null ? null : Math.min(sm + 60, 24 * 60));
    if (sm === null || em === null || em <= sm || em > 24 * 60) return { error: 'bad time' };
    start = new Date(day.getTime() + sm * 60000);
    end = new Date(day.getTime() + em * 60000);
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { error: 'busy' };
  try {
    const todayS = fmt_(new Date(), 'yyyy-MM-dd');
    const log = JSON.parse(props.getProperty('ADD_LOG') || '{}');
    const n = log.d === todayS ? log.n : 0;
    if (n >= ADD_MAX_PER_DAY) return { error: 'limit' };
    const ev = start ? cal.createEvent(title, start, end) : cal.createAllDayEvent(title, day);
    ev.setTag('epc', 'wall');
    props.setProperty('ADD_LOG', JSON.stringify({ d: todayS, n: n + 1 }));
    return { ok: true, id: ev.getId(), ev: conv_(ev) };
  } finally {
    lock.releaseLock();
  }
}

// 取り消し：壁から登録した予定（目印つき）で、登録から UNDO_MINUTES 分以内のものだけ消せる
function undoEvent_(cal, p) {
  const ev = p.id ? cal.getEventById(String(p.id)) : null;
  if (!ev || ev.getTag('epc') !== 'wall') return { error: 'not found' };
  if (Date.now() - ev.getDateCreated().getTime() > UNDO_MINUTES * 60000) return { error: 'too old' };
  ev.deleteEvent();
  return { ok: true };
}

// ---- メモの完了・取り消し（壁のメモ欄から） ----
// 本文（JSON）：{ k: 合言葉, act: 'done', id: 'リストID:タスクID' } ／ { k: 合言葉, act: 'undone', id: 同じID }
function taskRef_(props, id) {
  const m = /^([^:]+):([^:]+)$/.exec(String(id || ''));
  if (!m) return null;
  let ids = (props.getProperty('TASKLIST_IDS') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) ids = (Tasks.Tasklists.list({ maxResults: 100 }).items || []).map(l => l.id);
  if (ids.indexOf(m[1]) < 0) return null;
  try { return { list: m[1], task: m[2], t: Tasks.Tasks.get(m[1], m[2]) }; } catch (err) { return null; }
}
function doneTask_(props, p) {
  if (typeof Tasks === 'undefined') return { error: 'no tasks' };
  const r = taskRef_(props, p.id);
  if (!r || !r.t.due) return { error: 'not found' };
  if (r.t.status === 'completed') return { error: 'already' };
  const due = r.t.due.slice(0, 10);
  const today = parse_(fmt_(new Date(), 'yyyy-MM-dd'));
  const minS = fmt_(new Date(today.getTime() - PAST_DAYS * 864e5), 'yyyy-MM-dd');
  const maxS = fmt_(new Date(today.getTime() + FUTURE_DAYS * 864e5), 'yyyy-MM-dd');
  if (due < minS || due > maxS) return { error: 'not found' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { error: 'busy' };
  try {
    const todayS = fmt_(new Date(), 'yyyy-MM-dd');
    const log = JSON.parse(props.getProperty('DONE_LOG') || '{}');
    const n = log.d === todayS ? log.n : 0;
    if (n >= DONE_MAX_PER_DAY) return { error: 'limit' };
    Tasks.Tasks.patch({ status: 'completed' }, r.list, r.task);
    props.setProperty('DONE_LOG', JSON.stringify({ d: todayS, n: n + 1 }));
    props.setProperty('DONE_LAST', JSON.stringify({ id: String(p.id), at: Date.now() })); // 取り消し用（直近の1件だけ）
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
// 未完了に戻す：壁から完了にした直近の1件で、UNDO_MINUTES 分以内のものだけ
function undoneTask_(props, p) {
  if (typeof Tasks === 'undefined') return { error: 'no tasks' };
  const last = JSON.parse(props.getProperty('DONE_LAST') || '{}');
  if (!last.id || last.id !== String(p.id) || Date.now() - last.at > UNDO_MINUTES * 60000) return { error: 'too old' };
  const r = taskRef_(props, p.id);
  if (!r) return { error: 'not found' };
  const t = r.t;
  t.status = 'needsAction';
  delete t.completed;
  Tasks.Tasks.update(t, r.list, r.task); // 丸ごと書き戻して、完了日時を消す
  props.deleteProperty('DONE_LAST');
  return { ok: true };
}

function minutes_(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

// メモ欄：Google ToDoの未完了タスクのうち、期限が取得できる期間（minS〜maxS）に入るもの。月ごとの絞り込みは画面側で行う
// メモ欄：期限つきの未完了タスク＋毎年のメモの「予定」（f:1）
//  ・Googleの繰り返しタスクは、先の回をAPIで読めない（その日になると、去年の日付の記録が今年の日付に進む）
//  ・そこで、過去1年のうち期限が1日のタスク（完了済みも含む）を、1年後の同じ日の「予定」として返す
//  ・返すのは今日より先の日の分だけ。同じ日・同じ題名の本物があれば本物だけ
function memo_(props, minS, maxS) {
  if (typeof Tasks === 'undefined') return null; // Tasks API が未追加
  try {
    let ids = (props.getProperty('TASKLIST_IDS') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) ids = (Tasks.Tasklists.list({ maxResults: 100 }).items || []).map(l => l.id);
    const todayS = fmt_(new Date(), 'yyyy-MM-dd');
    const yearAgo = new Date(parse_(todayS).getTime() - 366 * 864e5);
    const out = [], fc = [], real = {};
    ids.forEach(id => {
      let pageToken;
      do {
        const r = Tasks.Tasks.list(id, { showCompleted: true, showHidden: true, dueMin: yearAgo.toISOString(), maxResults: 100, pageToken: pageToken });
        (r.items || []).forEach(t => {
          const due = t.due ? t.due.slice(0, 10) : '';
          if (!t.title || !due) return;               // 期限なしは表示しない
          real[due + '|' + t.title] = true;
          if (due.slice(8) === '01') {                // 毎年のメモ（1日が期限）の1年後の予定
            const f = (+due.slice(0, 4) + 1) + due.slice(4);
            if (f > todayS && (!minS || (f >= minS && f <= maxS))) fc.push({ t: t.title, due: f, p: t.position || '', f: 1 });
          }
          if (t.status === 'completed') return;       // 完了済みは予定の材料にだけ使う
          if (minS && (due < minS || due > maxS)) return; // 期間外（昔の未完了など）は送らない
          out.push({ t: t.title, due: due, p: t.position || '', id: id + ':' + t.id });
        });
        pageToken = r.nextPageToken;
      } while (pageToken);
    });
    const seen = {};
    fc.forEach(x => {
      const k = x.due + '|' + x.t;
      if (real[k] || seen[k]) return;
      seen[k] = true;
      out.push(x);
    });
    out.sort((a, b) => a.due < b.due ? -1 : a.due > b.due ? 1 : (a.f || 0) - (b.f || 0) || (a.p < b.p ? -1 : 1));
    return out.slice(0, 500).map(x => x.f ? { t: x.t, due: x.due, f: 1 } : { t: x.t, due: x.due, id: x.id });
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
  ['CALENDAR_IDS', 'TASKLIST_IDS', 'ALERT_TO', 'ADD_CALENDAR_ID'].forEach(k => { if (props.getProperty(k) === null) props.setProperty(k, ''); });
  CalendarApp.getAllCalendars();            // カレンダーの権限の確認用
  MailApp.getRemainingDailyQuota();         // メール送信の権限の確認用
  Logger.log('合言葉: ' + token);
  Logger.log('通知の送り先: ' + alertTo_());
  Logger.log('表示するカレンダー: ' + (props.getProperty('CALENDAR_IDS') || '（全カレンダー）'));
  const addId = (props.getProperty('ADD_CALENDAR_ID') || '').trim();
  const addCal = addId ? CalendarApp.getCalendarById(addId) : null;
  Logger.log('予定を追加するカレンダー: ' + (addCal ? addCal.getName() : addId ? '（IDが見つかりません）' : '（未設定：追加は使えません）'));
  const m = memo_(props, '', '');
  Logger.log(m === null ? 'メモ欄：Tasks API が追加されていないか、読めませんでした' : 'メモ欄：期限つきの未完了タスク ' + m.filter(x => !x.f).length + ' 件、毎年のメモの予定 ' + m.filter(x => x.f).length + ' 件');
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

// 確認用：未完了タスクをリストごとに全部ログに出す（期限・繰り返しの有無つき）
function listTasks() {
  (Tasks.Tasklists.list({ maxResults: 100 }).items || []).forEach(l => {
    Logger.log('■ ' + l.title + '  →  ' + l.id);
    let pageToken, n = 0;
    do {
      const r = Tasks.Tasks.list(l.id, { showCompleted: false, showHidden: false, maxResults: 100, pageToken: pageToken });
      (r.items || []).forEach(t => {
        n++;
        Logger.log('  ' + (t.due ? t.due.slice(0, 10) : '期限なし') + '  ' + t.title + (t.recurrence || t.recurringTaskId ? '（繰り返し）' : ''));
      });
      pageToken = r.nextPageToken;
    } while (pageToken);
    Logger.log('  → ' + n + ' 件');
  });
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
