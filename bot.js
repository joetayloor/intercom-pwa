const https = require('https');

// ── CONFIG ──
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const API_TOKEN = process.env.API_TOKEN || '';
const API_BASE = 'https://voip.flightdev.ru';
const POLL_INTERVAL = 4000; // 4 секунды

const DOORS = {
  54: 'Вход с улицы',
  57: 'Вход со двора',
  51: 'Калитка 1',
  52: 'Калитка 2',
  53: 'Калитка 3',
};

let lastEventId = null;
let isFirstRun = true;

// ── HTTP helpers ──
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'flightintercom1/5 CFNetwork/1496.0.7 Darwin/23.5.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname, path,
      method: 'POST', port: 443,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Telegram API ──
function tgCall(method, body) {
  return httpsPost('api.telegram.org', `/bot${BOT_TOKEN}/${method}`, body);
}

function sendMessage(text, extra = {}) {
  return tgCall('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML', ...extra });
}

function sendPhoto(photo, caption, extra = {}) {
  return tgCall('sendPhoto', { chat_id: CHAT_ID, photo, caption, parse_mode: 'HTML', ...extra });
}

function answerCallback(callback_query_id, text) {
  return tgCall('answerCallbackQuery', { callback_query_id, text });
}

// ── Door keyboard ──
function doorsKeyboard() {
  const buttons = Object.entries(DOORS).map(([id, name]) => ([{
    text: `🔓 ${name}`,
    callback_data: `open_${id}`
  }]));
  return { inline_keyboard: buttons };
}

// ── Open door ──
async function openDoor(doorId) {
  const url = `${API_BASE}/api/sendtask?token=${API_TOKEN}&doorid=${doorId}&task=10`;
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'flightintercom1/5' } }, res => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

// ── Poll events ──
async function pollEvents() {
  try {
    const data = await httpsGet(`${API_BASE}/api/events?token=${API_TOKEN}`);
    if (!data || !data.eventarray || !data.eventarray.length) return;

    const events = data.eventarray;
    const latest = events[0];
    const latestId = latest.eventid;

    // На первом запуске просто запоминаем последнее событие
    if (isFirstRun) {
      lastEventId = latestId;
      isFirstRun = false;
      console.log(`✓ Бот запущен. Последнее событие: ${latestId} (${latest.time})`);
      await sendMessage(`✅ <b>Домофон бот запущен</b>\n\nБуду присылать уведомления о звонках.\n\nПоследнее событие: ${latest.time}`);
      return;
    }

    // Ищем новые события
    const newEvents = [];
    for (const e of events) {
      if (e.eventid === lastEventId) break;
      newEvents.push(e);
    }

    if (!newEvents.length) return;

    // Обрабатываем новые события (от старых к новым)
    for (const e of newEvents.reverse()) {
      if (e.type === 'call') {
        console.log(`📞 Звонок: ${e.name} в ${e.time} | img: ${e.imgurl}`);
        const caption = `🔔 <b>Звонок!</b>\n📍 ${e.name}\n🕐 ${e.time}`;
        if (e.imgurl && !e.imgurl.includes('default.jpg')) {
          try {
            await sendPhoto(e.imgurl, caption, { reply_markup: doorsKeyboard() });
          } catch {
            await sendMessage(caption, { reply_markup: doorsKeyboard() });
          }
        } else {
          await sendMessage(caption, { reply_markup: doorsKeyboard() });
        }
      }
    }

    lastEventId = latestId;
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

// ── Handle Telegram updates (button presses) ──
let tgOffset = 0;

async function pollTelegram() {
  try {
    const data = await tgCall('getUpdates', { offset: tgOffset, timeout: 5, allowed_updates: ['callback_query', 'message'] });
    if (!data || !data.result) return;

    for (const update of data.result) {
      tgOffset = update.update_id + 1;

      // Кнопка открытия двери
      if (update.callback_query) {
        const cb = update.callback_query;
        const data = cb.data;

        if (data.startsWith('open_')) {
          const doorId = parseInt(data.replace('open_', ''));
          const doorName = DOORS[doorId] || `Дверь ${doorId}`;
          console.log(`🔓 Открываю дверь ${doorId} (${doorName})`);

          await answerCallback(cb.id, '⏳ Открываю...');
          const ok = await openDoor(doorId);

          if (ok) {
            await answerCallback(cb.id, `✅ ${doorName} открыта!`);
            await sendMessage(`✅ <b>${doorName}</b> — открыта`);
          } else {
            await answerCallback(cb.id, '❌ Ошибка');
            await sendMessage(`❌ Не удалось открыть ${doorName}`);
          }
        }
      }

      // Команды
      if (update.message && update.message.text) {
        const text = update.message.text;
        if (text === '/start' || text === '/doors') {
          await sendMessage('🚪 <b>Выбери дверь для открытия:</b>', { reply_markup: doorsKeyboard() });
        } else if (text === '/status') {
          await sendMessage(`✅ Бот работает\n📡 Опрос каждые ${POLL_INTERVAL/1000} сек\n🆔 Последнее событие: ${lastEventId || 'нет'}`);
        }
      }
    }
  } catch (e) {
    console.error('Telegram poll error:', e.message);
  }
}

// ── Main loop ──
console.log('🤖 Запускаю домофон-бота...');

// Опрос событий домофона
setInterval(pollEvents, POLL_INTERVAL);
pollEvents(); // сразу при старте

// Опрос Telegram (кнопки)
setInterval(pollTelegram, 1000);
pollTelegram();

// ── Keep-alive HTTP сервер для UptimeRobot ──
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(process.env.PORT || 3000);
