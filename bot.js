const http = require('http');
const httpsLib = require('https');

// ── CONFIG ──
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_IDS = (process.env.CHAT_ID || '').split(',').map(id => id.trim()).filter(Boolean);
const API_TOKEN = process.env.API_TOKEN || '';
const PROXY_URL = process.env.PROXY_URL || 'https://intercom-proxy-30wm.onrender.com';
const API_BASE = 'https://voip.flightdev.ru';
const POLL_INTERVAL = 4000;

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
    httpsLib.get(url, { headers: { 'User-Agent': 'flightintercom1/5 CFNetwork/1496.0.7 Darwin/23.5.0' } }, res => {
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

// ── Download image as buffer via proxy ──
function downloadImage(imgurl) {
  const proxyUrl = imgurl.replace('https://voip.flightdev.ru', PROXY_URL);
  const urlObj = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    httpsLib.get({ hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, port: 443,
      headers: { 'User-Agent': 'flightintercom1/5' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ── Send photo buffer as multipart ──
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

function answerCallback(callback_query_id, text) {
  return tgCall('answerCallbackQuery', { callback_query_id, text });
}

// ── Door keyboard ──
function doorsKeyboard() {
  const buttons = Object.entries(DOORS).map(([id, name]) => ([{
    text: `🔓 ${name}`, callback_data: `open_${id}`
  }]));
  return { inline_keyboard: buttons };
}

// ── Open door ──
async function openDoor(doorId) {
  const url = `${API_BASE}/api/sendtask?token=${API_TOKEN}&doorid=${doorId}&task=10`;
  return new Promise((resolve) => {
    httpsLib.get(url, { headers: { 'User-Agent': 'flightintercom1/5' } }, res => {
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

    if (isFirstRun) {
      lastEventId = latestId;
      isFirstRun = false;
      console.log(`✓ Бот запущен. Пользователей: ${CHAT_IDS.length}. Последнее событие: ${latestId}`);
      return;
    }

    const newEvents = [];
    for (const e of events) {
      if (e.eventid === lastEventId) break;
      newEvents.push(e);
    }

    if (!newEvents.length) return;

    for (const e of newEvents.reverse()) {
      if (e.type === 'call') {
        cconsole.log(`📞 Звонок: ${e.name} в ${e.time} | doorid: ${e.doorid} | img: ${e.imgurl}`);
        const caption = `🔔 <b>Звонок!</b>\n📍 ${e.name}\n🕐 ${e.time}`;
        const keyboard = doorsKeyboard();

        if (e.imgurl && !e.imgurl.includes('default.jpg')) {
          try {
            const buffer = await downloadImage(e.imgurl);
            console.log(`📸 Скачал фото ${buffer.length} байт`);
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

    lastEventId = latestId;
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

// ── Handle Telegram updates ──
let tgOffset = 0;

async function pollTelegram() {
  try {
    const data = await tgCall('getUpdates', { offset: tgOffset, timeout: 5, allowed_updates: ['callback_query', 'message'] });
    if (!data || !data.result) return;

    for (const update of data.result) {
      tgOffset = update.update_id + 1;

      if (update.callback_query) {
        const cb = update.callback_query;
        const cbData = cb.data;
        const fromId = cb.from.id.toString();

        if (!CHAT_IDS.includes(fromId)) {
          await answerCallback(cb.id, '❌ Нет доступа');
          continue;
        }

        if (cbData.startsWith('open_')) {
          const doorId = parseInt(cbData.replace('open_', ''));
          const doorName = DOORS[doorId] || `Дверь ${doorId}`;
          console.log(`🔓 ${fromId} открывает дверь ${doorId} (${doorName})`);
          await answerCallback(cb.id, '⏳ Открываю...');
          const ok = await openDoor(doorId);
          if (ok) {
            await answerCallback(cb.id, `✅ ${doorName} открыта!`);
            await sendMessage(`✅ <b>${doorName}</b> — открыта`);
          } else {
            await answerCallback(cb.id, '❌ Ошибка');
            await sendMessageTo(fromId, `❌ Не удалось открыть ${doorName}`);
          }
        }
      }

      if (update.message && update.message.text) {
        const text = update.message.text;
        const fromId = update.message.from.id.toString();

        if (!CHAT_IDS.includes(fromId)) {
          await sendMessageTo(fromId, '❌ Нет доступа');
          continue;
        }

        if (text === '/start' || text === '/doors') {
          await sendMessageTo(fromId, '🚪 <b>Выбери дверь для открытия:</b>', { reply_markup: doorsKeyboard() });
        } else if (text === '/status') {
          await sendMessageTo(fromId, `✅ Бот работает\n📡 Опрос каждые ${POLL_INTERVAL/1000} сек\n👥 Пользователей: ${CHAT_IDS.length}\n🆔 Последнее событие: ${lastEventId || 'нет'}`);
        }
      }
    }
  } catch (e) {
    console.error('Telegram poll error:', e.message);
  }
}

// ── Keep-alive HTTP сервер для UptimeRobot ──
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(process.env.PORT || 3000);

// ── Main loop ──
console.log('🤖 Запускаю домофон-бота...');
setInterval(pollEvents, POLL_INTERVAL);
pollEvents();
setInterval(pollTelegram, 1000);
pollTelegram();
