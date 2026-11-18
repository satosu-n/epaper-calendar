/**
 * 電子ペーパーカレンダー用の予定配信（Google Apps Script）
 *
 * 設定はすべて「プロジェクトの設定」→「スクリプト プロパティ」に置く（このファイルには書かない）
 *   TOKEN         … 合言葉。setup() が自動で作る
 *   CALENDAR_IDS  … 表示するカレンダーのID。複数ならカンマ区切り。空なら祝日・誕生日以外の全カレンダー
 *   TASKLIST_IDS  … メモ欄に出すToDoリストのID。複数ならカンマ区切り。空ならすべてのリスト
 *   ALERT_TO      … 不審なアクセスの通知先メールアドレス。空ならこのスクリプトの持ち主
 *   ADD_CALENDAR_ID … 壁から予定を追加するカレンダーのID（家族の共有カレンダー）。空なら追加は使えない
 *   GEMINI_API_KEY … 話して予定を登録（読み取り）に使う Gemini API のキー。空なら「話して入れる」は出ない
 *   VOICE          … off にすると「話して入れる」を止める（キーは残したまま）
 *   GEMINI_MODEL   … 使うモデル。空なら gemini-3.5-flash-lite
 *
 * 話して予定を登録（入力画面の「話して入れる」）
 *  ・話した文を Gemini に送り、日付・時刻・予定名を読み取って入力画面に入れるだけ（登録は人が「登録する」を押す）
 *  ・Gemini に送るのは：話した文、今日の日付・曜日・今の時刻、1年先までの祝日、
 *    よく使う予定名（表示するカレンダーの過去1年で2回以上出てきた予定名、多い順に30件。日付や時刻は送らない）
 *  ・祝日とよく使う予定名は1日1回作ってスクリプト プロパティ VOICE_CTX に置く
 *  ・読み取りは1日60件まで、文は200文字まで
 *  ・初めて使うときは関数「testParse」を実行し、外部サービスへの接続を許可する（作り物の文で試す）
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
const PARSE_MAX_PER_DAY = 60;  // 話して入れる（読み取り）は1日にこの件数まで
const VOICE_TEXT_MAX = 200;    // 読み取りに送る文の最大文字数
const NAMES_MAX = 30;          // AIに渡す「よく使う予定名」の件数
const DEFAULT_MODEL = 'gemini-3.5-flash-lite'; // 考える機能は初期設定で最小（速さ優先）

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
  const voice = voiceOn_(props);
  if (voice) { // 祝日・よく使う予定名を1日1回作っておく（読み取りを速くするため）
    try { voiceCtx_(props); } catch (err) { console.error('読み取り用の材料を作れませんでした: ' + err); }
  }
  return json_({ ev: ev, h: h, m: memo_(props, minS, maxS), at: fmt_(new Date(), 'H:mm'), w: recentFailures_(props),
    add: !!(props.getProperty('ADD_CALENDAR_ID') || '').trim(), voice: voice });
}

// ---- 予定の追加・取り消し（壁の「＋予定を追加」から） ----
// 本文（JSON）：{ k: 合言葉, act: 'add', d: 'yyyy-MM-dd', t: 予定名, s: 'H:mm'（空なら終日）, e: 'H:mm'（空なら1時間） }
//              { k: 合言葉, act: 'undo', id: 追加したときに返したID }
//              { k: 合言葉, act: 'parse', text: 話した文, base: 選んでいる日 'yyyy-MM-dd' } … 読み取るだけ（登録はしない）
//              { k: 合言葉, act: 'ping' } … 入力画面を開いたときの準備運動（何もしない）
function doPost(e) {
  let p;
  try { p = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ error: 'bad request' }); }
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TOKEN');
  if (!token || p.k !== token) {
    recordFailure_(props);
    return json_({ error: 'forbidden' });
  }
  if (p.act === 'ping') return json_({ ok: true });
  if (p.act === 'parse') {
    try {
      return json_(parseText_(props, p));
    } catch (err) {
      console.error('読み取りでエラー: ' + err);
      return json_({ error: 'server', msg: String(err && err.message || err).slice(0, 200) });
    }
  }
  if (p.act === 'done' || p.act === 'undone') {
    try {
      return json_(p.act === 'done' ? doneTask_(props, p) : undoneTask_(props, p));
    } catch (err) {
      console.error('メモの完了でエラー: ' + err); // 「実行数」の詳細に出る
      return json_({ error: 'server', msg: String(err && err.message || err).slice(0, 200) });
    }
  }
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

// ---- 話して予定を登録（読み取りだけ） ----
function voiceOn_(props) {
  return !!(props.getProperty('GEMINI_API_KEY') || '').trim() && (props.getProperty('VOICE') || '').trim() !== 'off';
}

// AIに渡す材料（1日1回作る）：1年先までの祝日、よく使う予定名（過去1年で2回以上、多い順に NAMES_MAX 件。名前だけ）
function voiceCtx_(props) {
  const todayS = fmt_(new Date(), 'yyyy-MM-dd');
  try {
    const c = JSON.parse(props.getProperty('VOICE_CTX') || 'null');
    if (c && c.d === todayS) return c;
  } catch (err) {}
  const today = parse_(todayS);
  const h = [];
  const hc = CalendarApp.getCalendarById(HOLIDAY_ID);
  if (hc) {
    hc.getEvents(today, new Date(today.getTime() + FUTURE_DAYS * 864e5)).forEach(x => {
      const d = x.getDescription() || '';
      if (d && !/祝日|休日/.test(d)) return;
      h.push(fmt_(x.getAllDayStartDate(), 'yyyy-MM-dd') + ' ' + x.getTitle());
    });
    h.sort();
  }
  const cnt = {};
  calendars_(props).forEach(c => c.getEvents(new Date(today.getTime() - 366 * 864e5), today).forEach(x => {
    const t = (x.getTitle() || '').trim();
    if (t && t.length <= 30) cnt[t] = (cnt[t] || 0) + 1;
  }));
  const names = Object.keys(cnt).filter(t => cnt[t] >= 2).sort((a, b) => cnt[b] - cnt[a]).slice(0, NAMES_MAX);
  const c = { d: todayS, h: h, names: names };
  props.setProperty('VOICE_CTX', JSON.stringify(c));
  return c;
}

const PARSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ok: { type: 'BOOLEAN' }, dateSaid: { type: 'BOOLEAN' }, date: { type: 'STRING' }, allDay: { type: 'BOOLEAN' },
    start: { type: 'STRING' }, end: { type: 'STRING' }, title: { type: 'STRING' }
  },
  required: ['ok', 'dateSaid', 'date', 'allDay', 'start', 'end', 'title'],
  propertyOrdering: ['ok', 'dateSaid', 'date', 'allDay', 'start', 'end', 'title']
};

function parseText_(props, p) {
  const t0 = Date.now();
  if (!voiceOn_(props)) return { error: 'voice off' };
  const text = String(p.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return { error: 'empty' };
  if (text.length > VOICE_TEXT_MAX) return { error: 'too long' };
  const now = new Date(), todayS = fmt_(now, 'yyyy-MM-dd');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { error: 'busy' };
  try {
    const log = JSON.parse(props.getProperty('PARSE_LOG') || '{}');
    const n = log.d === todayS ? log.n : 0;
    if (n >= PARSE_MAX_PER_DAY) return { error: 'limit' };
    props.setProperty('PARSE_LOG', JSON.stringify({ d: todayS, n: n + 1 }));
  } finally {
    lock.releaseLock();
  }
  const ctx = voiceCtx_(props);
  // 選んでいる日（日付を言わなかったときに、AIの答えの日付をこれに置き換える。AIには渡さない）。今日〜1年先でなければ使わない
  const bd = parse_(p.base), td = parse_(todayS);
  const baseS = bd && bd >= td && bd <= new Date(td.getTime() + FUTURE_DAYS * 864e5) ? p.base : '';
  const sys = [
    'あなたは家族のカレンダーへの予定の登録を手伝う。話し言葉の文から予定を1件読み取り、決まった形のJSONだけを返す。',
    '今日：' + todayS + '（' + '日月火水木金土'.charAt(+fmt_(now, 'u') % 7) + '）　今の時刻：' + fmt_(now, 'H:mm'),
    '週は日曜から土曜まで。',
    '祝日：' + (ctx.h.join('、') || 'なし'),
    'よく使う予定名：' + (ctx.names.join('、') || 'なし'),
    '決まり：',
    '- dateSaid は、文に日付の言葉（今日、あした、来週の○曜、○日、○月○日など）があれば true、なければ false。',
    '- date は YYYY-MM-DD で、今日を基準に読む。日付の言葉がなければ今日。「○曜」「今度の○曜」だけなら、今日より後で一番近いその曜日。「来週の○曜」は、次の日曜から始まる週のその曜日。「○日」だけで今月のその日が過ぎていれば来月。今日より前の日付にはしない。',
    '- start・end は24時間制の H:mm。「午前」「朝」がなく1〜6時と言ったときは午後（13〜18時）とみなす。「半」は30分。',
    '- 終わりの時刻を言っていなければ end は空文字。時刻を言っていなければ allDay を true にし、start・end は空文字。',
    '- title は予定の中身だけを短く（日付・時刻・「から」「まで」などは入れない）。よく使う予定名と同じ予定なら、その書き方に合わせる。音声入力の聞き間違いらしいときは、よく使う予定名に直してよい。',
    '- 予定として読めないときは ok を false にし、ほかは空にする。'
  ].join('\n');
  const model = (props.getProperty('GEMINI_MODEL') || '').trim() || DEFAULT_MODEL;
  const gen = { maxOutputTokens: 256, responseMimeType: 'application/json', responseSchema: PARSE_SCHEMA };
  if (/^gemini-2\./.test(model)) { gen.temperature = 0; gen.thinkingConfig = { thinkingBudget: 0 }; } // 古いモデルのとき
  // Gemini 3 以降は温度を初期値のままにする（下げると答えが崩れることがあるため）
  const t1 = Date.now();
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': props.getProperty('GEMINI_API_KEY').trim() },
    payload: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: text }] }], generationConfig: gen })
  });
  const aiMs = Date.now() - t1;
  const code = res.getResponseCode();
  if (code === 429) return { error: 'quota', aiMs: aiMs };
  if (code !== 200) {
    console.error('Gemini のエラー ' + code + ': ' + res.getContentText().slice(0, 300)); // 「実行数」の詳細に出る
    return { error: 'ai', msg: 'Gemini ' + code, aiMs: aiMs };
  }
  let r;
  try {
    const j = JSON.parse(res.getContentText());
    r = JSON.parse(j.candidates[0].content.parts[0].text);
  } catch (err) {
    return { error: 'unknown', aiMs: aiMs };
  }
  if (r && r.ok === true && r.dateSaid === false && baseS) r.date = baseS; // 日付を言わなかったときは、選んでいる日
  const out = checkParsed_(r, todayS);
  out.aiMs = aiMs;
  out.ms = Date.now() - t0;
  return out;
}

// AIの答えを確かめて、入力画面に入れる形にする（登録の制限と同じ範囲に収める）
function checkParsed_(r, todayS) {
  if (!r || r.ok !== true) return { error: 'unknown' };
  const day = parse_(r.date), today = parse_(todayS);
  if (!day) return { error: 'unknown' };
  if (day < today || day > new Date(today.getTime() + FUTURE_DAYS * 864e5)) return { error: 'bad date', d: r.date };
  let s = '', e = '';
  const sm = r.allDay ? null : minutes_(r.start);
  if (sm !== null) {
    s = hm_(sm);
    const em = minutes_(r.end);
    if (em !== null && em > sm) e = hm_(em);
  }
  const t = String(r.title || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TITLE_MAX);
  return { ok: true, d: r.date, s: s, e: e, t: t };
}
function hm_(m) { return Math.floor(m / 60) + ':' + ('0' + m % 60).slice(-2); }

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
  ['CALENDAR_IDS', 'TASKLIST_IDS', 'ALERT_TO', 'ADD_CALENDAR_ID', 'GEMINI_API_KEY'].forEach(k => { if (props.getProperty(k) === null) props.setProperty(k, ''); });
  CalendarApp.getAllCalendars();            // カレンダーの権限の確認用
  MailApp.getRemainingDailyQuota();         // メール送信の権限の確認用
  Logger.log('合言葉: ' + token);
  Logger.log('通知の送り先: ' + alertTo_());
  Logger.log('表示するカレンダー: ' + (props.getProperty('CALENDAR_IDS') || '（全カレンダー）'));
  const addId = (props.getProperty('ADD_CALENDAR_ID') || '').trim();
  const addCal = addId ? CalendarApp.getCalendarById(addId) : null;
  Logger.log('予定を追加するカレンダー: ' + (addCal ? addCal.getName() : addId ? '（IDが見つかりません）' : '（未設定：追加は使えません）'));
  Logger.log('話して入れる: ' + (voiceOn_(props) ? '使える（モデル ' + ((props.getProperty('GEMINI_MODEL') || '').trim() || DEFAULT_MODEL) + '）' :
    (props.getProperty('GEMINI_API_KEY') || '').trim() ? '止めてあります（VOICE=off）' : '（未設定：GEMINI_API_KEY が空）'));
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

// 話して入れるのテスト：作り物の文を読み取ってログに出す（初回はここで外部サービスへの接続を許可する）
function testParse() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('VOICE_CTX'); // 材料を作り直して確かめる
  // 選んでいる日は10日後にして試す（日付を言わない文は、その日になるはず）
  const base = fmt_(new Date(Date.now() + 10 * 864e5), 'yyyy-MM-dd');
  Logger.log('選んでいる日：' + base);
  ['来週の火曜、3時から歯医者', 'あした終日 地域の清掃', '25日の午前10時半から11時半まで面談', '4時から面談'].forEach(s => {
    Logger.log(s + '  →  ' + JSON.stringify(parseText_(props, { text: s, base: base })));
  });
  const c = voiceCtx_(props);
  Logger.log('材料：祝日 ' + c.h.length + ' 件、よく使う予定名 ' + c.names.length + ' 件');
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
