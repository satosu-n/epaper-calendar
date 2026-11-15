/**
 * 電子ペーパーカレンダー用の予定配信（Google Apps Script）
 *
 * 使い方
 *  1. このコードをApps Scriptのプロジェクトに貼り付けて保存
 *  2. 関数「setup」を実行（初回は権限の許可が必要）→ 合言葉が作られ、ログに表示される
 *  3. 必要なら関数「listCalendars」を実行し、使うカレンダーのIDを CALENDAR_IDS に入れる
 *  4. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *  5. 表示された「デプロイID」と、setupで出た合言葉を、iPad用URLに入れる
 *       https://satosu-n.github.io/epaper-calendar/#d=デプロイID&k=合言葉
 *
 * 合言葉はスクリプトのプロパティ（TOKEN）に保存されるので、このファイルには書かない。
 */

// 表示するカレンダーのID。空のままなら、祝日・誕生日以外のすべてのカレンダー。
const CALENDAR_IDS = [];

const HOLIDAY_ID = 'ja.japanese#holiday@group.v.calendar.google.com';
const TZ = 'Asia/Tokyo';

function doGet(e) {
  const p = (e && e.parameter) || {};
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || p.k !== token) return json_({ error: 'forbidden' });

  const from = parse_(p.from), to = parse_(p.to);
  if (!from || !to || to < from) return json_({ error: 'bad range' });
  const end = new Date(to.getTime() + 864e5); // toの日の終わりまで

  const cals = CALENDAR_IDS.length
    ? CALENDAR_IDS.map(id => CalendarApp.getCalendarById(id)).filter(Boolean)
    : CalendarApp.getAllCalendars().filter(c => !/holiday@group\.v\.calendar|#contacts@/.test(c.getId()));

  const ev = [];
  cals.forEach(c => c.getEvents(from, end).forEach(x => ev.push(conv_(x))));

  // 祝日（Googleの「日本の祝日」。節分などの行事は除く）
  const h = {};
  const hc = CalendarApp.getCalendarById(HOLIDAY_ID);
  if (hc) {
    hc.getEvents(from, end).forEach(x => {
      const d = x.getDescription() || '';
      if (d && !/祝日|休日/.test(d)) return;
      h[fmt_(x.getAllDayStartDate(), 'yyyy-MM-dd')] = x.getTitle();
    });
  }
  return json_({ ev: ev, h: h, at: fmt_(new Date(), 'H:mm') });
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

function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  CalendarApp.getAllCalendars(); // 権限の確認用
  Logger.log('合言葉: ' + token);
  Logger.log('iPad用URL: https://satosu-n.github.io/epaper-calendar/#d=（デプロイID）&k=' + token);
}

function listCalendars() {
  CalendarApp.getAllCalendars().forEach(c => Logger.log(c.getName() + '  →  ' + c.getId()));
}

function parse_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  return Utilities.parseDate(s, TZ, 'yyyy-MM-dd');
}
function fmt_(d, f) { return Utilities.formatDate(d, TZ, f); }
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
