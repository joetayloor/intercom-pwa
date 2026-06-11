const http = require('http');
const httpsLib = require('https');
const fs = require('fs');

// ── CONFIG ──
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_IDS = (process.env.CHAT_ID || '').split(',').map(id => id.trim()).filter(Boolean);
const API_TOKEN = process.env.API_TOKEN || '';
const PROXY_URL = process.env.PROXY_URL || 'https://intercom-proxy-30wm.onrender.com';
const API_BASE = 'https://voip.flightdev.ru';
const POLL_INTERVAL = 4000;
const STATE_FILE = '/tmp/intercom_state.json';

const DOORS = {
  54: 'Вход с улицы',
  57: 'Вход со двора',
  51: 'Калитка 1',
  52: 'Калитка 2',
  53: 'Калитка 3',
};

const DOOR_NAME_TO_ID = {
  'вход с улицы': 54,
  'вход со двора': 57,
  'калитка 1': 51,
  'калитка 2': 52,
  'калитка 3': 53,
};

const openLocks = {};
let lastEventId = null;
let isFirstRun = true;

// ── STATE (автооткрытие) ──
let state = {
  autoOpen: false,
  scheduleEnabled: false,
  scheduleFrom: '09:00',
  scheduleTo: '22:00',
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    }
  } catch(e) {}
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch(e) {}
}

function isAutoOpenActive() {
  if (!state.autoOpen) return false;
  if (!state.scheduleEnabled) return true;
  const now = new Date();
  const [fh, fm] = state.scheduleFrom.split(':').map(Number);
  const [th, tm] = state.scheduleTo.split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = fh * 60 + fm;
  const to = th * 60 + tm;
  return cur >= from && cur <= to;
}

loadState();

// ── HTTP helpers ──
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    httpsLib.get(url, { headers: { 'User-Agent': 'flightintercom1/8 CFNetwork/1496.0.7 Darwin/23.5.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname, path, method: 'POST', port: 443,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = httpsLib.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function downloadImage(imgurl) {
  return new Promise((resolve, reject) => {
    const proxyUrl = imgurl.replace('https://voip.flightdev.ru', PROXY_URL);
    const urlObj = new URL(proxyUrl);
    httpsLib.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      port: 443,
      headers: { 'User-Agent': 'flightintercom1/8 CFNetwork/1496.0.7 Darwin/23.5.0', 'Accept': '*/*' }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function sendPhotoBuffer(chatId, buffer, caption, keyboard) {
  return new Promise((resolve, reject) => {
    const boundary = 'Boundary' + Date.now();
    const keyboardStr = JSON.stringify(keyboard);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${keyboardStr}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendPhoto`,
      method: 'POST', port: 443,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    };
    const req = httpsLib.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Telegram API ──
function tgCall(method, body) {
  return httpsPost('api.telegram.org', `/bot${BOT_TOKEN}/${method}`, body);
}

function sendMessage(text, extra = {}) {
  return Promise.all(CHAT_IDS.map(id => tgCall('sendMessage', { chat_id: id, text, parse_mode: 'HTML', ...extra })));
}

function sendMessageTo(chatId, text, extra = {}) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function editMessage(chatId, messageId, text, extra = {}) {
  return tgCall('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });
}

function answerCallback(callback_query_id, text) {
  return tgCall('answerCallbackQuery', { callback_query_id, text });
}

// ── Keyboards ──
function doorsKeyboard() {
  return { inline_keyboard: Object.entries(DOORS).map(([id, name]) => ([{ text: `🔓 ${name}`, callback_data: `open_${id}` }])) };
}

function smartKeyboard(eventName) {
  const nameLower = (eventName || '').toLowerCase();
  const matchedId = DOOR_NAME_TO_ID[nameLower];
  const buttons = [];
  if (matchedId) {
    buttons.push([{ text: `🔓 Открыть — ${DOORS[matchedId]}`, callback_data: `open_${matchedId}` }]);
  } else {
    Object.entries(DOORS).forEach(([id, name]) => buttons.push([{ text: `🔓 ${name}`, callback_data: `open_${id}` }]));
  }
  buttons.push([{ text: '🚪 Все двери', callback_data: 'show_all_doors' }]);
  return { inline_keyboard: buttons };
}

function settingsKeyboard() {
  const autoStatus = state.autoOpen ? '✅ Вкл' : '❌ Выкл';
  const schedStatus = state.scheduleEnabled ? `⏰ ${state.scheduleFrom}–${state.scheduleTo}` : '🕐 Всегда';
  return {
    inline_keyboard: [
      [{ text: `🤖 Автооткрытие: ${autoStatus}`, callback_data: 'toggle_auto' }],
      [{ text: `${schedStatus} — изменить расписание`, callback_data: 'set_schedule' }],
      [{ text: '🚪 Открыть дверь', callback_data: 'show_doors_menu' }],
    ]
  };
}

function settingsText() {
  const autoStatus = state.autoOpen ? '✅ включено' : '❌ выключено';
  const schedText = state.scheduleEnabled
    ? `⏰ По расписанию: ${state.scheduleFrom} – ${state.scheduleTo}`
    : '🕐 Работает круглосуточно';
  const activeNow = isAutoOpenActive() ? '🟢 Сейчас активно' : '🔴 Сейчас неактивно';
  return `⚙️ <b>Настройки</b>\n\n🤖 Автооткрытие: ${autoStatus}\n${schedText}\n${activeNow}`;
}

// ── Open door ──
async function openDoor(doorId) {
  const url = `${API_BASE}/api/iosv2/sendtask?token=${API_TOKEN}&doorid=${doorId}&task=10`;
  return new Promise((resolve) => {
    httpsLib.get(url, { headers: { 'User-Agent': 'flightintercom1/8' } }, res => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

// ── Poll events ──
async function pollEvents() {
  try {
    const data = await httpsGet(`${API_BASE}/api/iosv2/events?token=${API_TOKEN}`);
    if (!data || !data.eventarray || !data.eventarray.length) return;

    const events = data.eventarray;
    const latest = events[0];
    const latestId = latest.eventid;

    if (isFirstRun) {
      lastEventId = latestId;
      isFirstRun = false;
      console.log(`✓ Бот запущен. Пользователей: ${CHAT_IDS.length}. Автооткрытие: ${state.autoOpen}`);
      return;
    }

    const newEvents = [];
    for (const e of events) {
      if (e.eventid === lastEventId) break;
      newEvents.push(e);
    }

    if (!newEvents.length) return;

    lastEventId = latestId;

    for (const e of newEvents.reverse()) {
      if (e.type === 'call') {
        console.log(`📞 Звонок: ${e.name} в ${e.time} | img: ${e.imgurl}`);

        const nameLower = (e.name || '').toLowerCase();
        const doorId = DOOR_NAME_TO_ID[nameLower];

        // Автооткрытие
        if (isAutoOpenActive() && doorId) {
          console.log(`🤖 Автооткрытие двери ${doorId}`);
          await openDoor(doorId);
        }

        const autoText = isAutoOpenActive() && doorId ? '\n🤖 <i>Дверь открыта автоматически</i>' : '';
        const caption = `🔔 <b>Звонок!</b>\n📍 ${e.name}\n🕐 ${e.time}${autoText}`;
        const keyboard = smartKeyboard(e.name);

        // Ждём фото
        await new Promise(r => setTimeout(r, 2000));

        let imgurl = e.imgurl;
        if (!imgurl || imgurl.includes('default.jpg')) {
          try {
            const fresh = await httpsGet(`${API_BASE}/api/iosv2/events?token=${API_TOKEN}`);
            const freshEvent = (fresh?.eventarray || []).find(fe => fe.eventid === e.eventid);
            if (freshEvent?.imgurl && !freshEvent.imgurl.includes('default.jpg')) {
              imgurl = freshEvent.imgurl;
            }
          } catch(err) {}
        }

        if (imgurl && !imgurl.includes('default.jpg')) {
          try {
            const buffer = await downloadImage(imgurl);
            console.log(`📸 Фото ${buffer.length} байт`);
            await Promise.all(CHAT_IDS.map(id => sendPhotoBuffer(id, buffer, caption, keyboard)));
          } catch(err) {
            console.error('Ошибка фото:', err.message);
            await sendMessage(caption, { reply_markup: keyboard });
          }
        } else {
          await sendMessage(caption, { reply_markup: keyboard });
        }
      }
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

// ── Telegram updates ──
let tgOffset = 0;
const awaitingSchedule = {}; // chatId → 'from' | 'to'

async function pollTelegram() {
  try {
    const data = await tgCall('getUpdates', { offset: parseInt(tgOffset) || 0, timeout: 5, allowed_updates: ['callback_query', 'message'] });
    if (!data || !data.result) return;

    for (const update of data.result) {
      tgOffset = update.update_id + 1;

      // ── Callback кнопки ──
     if (update.callback_query) {
  console.log(`📲 Callback: ${JSON.stringify(update.callback_query.data)} от ${update.callback_query.from.id}`);
  const cb = update.callback_query;
  const cbData = cb.data;
  const fromId = cb.from.id.toString();

        if (!CHAT_IDS.includes(fromId)) { await answerCallback(cb.id, '❌ Нет доступа'); continue; }

        // Открытие двери
        if (cbData.startsWith('open_')) {
          const doorId = parseInt(cbData.replace('open_', ''));
          const doorName = DOORS[doorId] || `Дверь ${doorId}`;
          if (openLocks[doorId]) { await answerCallback(cb.id, '⏳ Уже открывается...'); continue; }
          openLocks[doorId] = true;
          setTimeout(() => { delete openLocks[doorId]; }, 5000);
          await answerCallback(cb.id, '⏳ Открываю...');
          const ok = await openDoor(doorId);
          console.log(`🚪 openDoor(${doorId}) результат: ${ok}`);
            if (ok) {
            await answerCallback(cb.id, `✅ ${doorName} открыта!`);
            await sendMessage(`✅ <b>${doorName}</b> — открыта`);
          } else {
            await answerCallback(cb.id, '❌ Ошибка');
          }
        }

        // Показать все двери
        else if (cbData === 'show_all_doors' || cbData === 'show_doors_menu') {
          await answerCallback(cb.id, '');
          await sendMessageTo(fromId, '🚪 <b>Выбери дверь:</b>', { reply_markup: doorsKeyboard() });
        }

        // Тоггл автооткрытия
        else if (cbData === 'toggle_auto') {
          state.autoOpen = !state.autoOpen;
          saveState();
          await answerCallback(cb.id, state.autoOpen ? '✅ Автооткрытие включено' : '❌ Автооткрытие выключено');
          await sendMessage(settingsText(), { reply_markup: settingsKeyboard() });
        }

        // Настройка расписания
        else if (cbData === 'set_schedule') {
          await answerCallback(cb.id, '');
          await sendMessageTo(fromId, '⏰ <b>Настройка расписания</b>\n\nВведи время начала в формате <code>HH:MM</code>\nНапример: <code>09:00</code>');
          awaitingSchedule[fromId] = 'from';
        }

        // Настройки
        else if (cbData === 'settings') {
          await answerCallback(cb.id, '');
          await sendMessageTo(fromId, settingsText(), { reply_markup: settingsKeyboard() });
        }
      }

      // ── Текстовые сообщения ──
      if (update.message) {
        const text = (update.message.text || '').trim();
        const fromId = update.message.from.id.toString();

        if (!CHAT_IDS.includes(fromId)) { await sendMessageTo(fromId, '❌ Нет доступа'); continue; }

        // Ввод расписания
        if (awaitingSchedule[fromId]) {
          const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
          if (timeRegex.test(text)) {
            if (awaitingSchedule[fromId] === 'from') {
              state.scheduleFrom = text;
              state.scheduleEnabled = true;
              awaitingSchedule[fromId] = 'to';
              await sendMessageTo(fromId, `✅ Начало: <b>${text}</b>\n\nТеперь введи время окончания в формате <code>HH:MM</code>`);
            } else {
              state.scheduleTo = text;
              saveState();
              delete awaitingSchedule[fromId];
              await sendMessageTo(fromId, settingsText(), { reply_markup: settingsKeyboard() });
            }
          } else {
            await sendMessageTo(fromId, '❌ Неверный формат. Введи время в формате <code>HH:MM</code>, например <code>09:00</code>');
          }
          continue;
        }

        // Команды
        if (text === '/start') {
          await sendMessageTo(fromId, '👋 <b>Домофон бот</b>\n\n/doors — открыть дверь\n/settings — настройки\n/status — статус');
        } else if (text === '/doors') {
          await sendMessageTo(fromId, '🚪 <b>Выбери дверь:</b>', { reply_markup: doorsKeyboard() });
        } else if (text === '/settings') {
          await sendMessageTo(fromId, settingsText(), { reply_markup: settingsKeyboard() });
        } else if (text === '/status') {
          await sendMessageTo(fromId, `✅ Бот работает\n📡 Опрос каждые ${POLL_INTERVAL/1000} сек\n👥 Пользователей: ${CHAT_IDS.length}\n🤖 Автооткрытие: ${state.autoOpen ? 'вкл' : 'выкл'}\n🆔 Последнее событие: ${lastEventId || 'нет'}`);
        }
      }
    }
  } catch (e) {
    console.error('Telegram poll error:', e.message);
  }
}

// ── Keep-alive ──
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log(`✓ HTTP сервер запущен на порту ${process.env.PORT || 3000}`);
});

// ── Main ──
console.log('🤖 Запускаю домофон-бота...');
setInterval(pollEvents, POLL_INTERVAL);
pollEvents();
setInterval(pollTelegram, 1000);
pollTelegram();
