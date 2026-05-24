const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ══ ANALYTICS HELPER ══
async function updateAnalytics(key, amount) {
  try {
    await pool.query(
      'INSERT INTO analytics(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value = analytics.value + $2',
      [key, amount]
    );
  } catch(e) {
    console.error('❌ Analytics error:', key, e.message);
  }
}

pool.query(`
  CREATE TABLE IF NOT EXISTS game_state (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, display TEXT, balance NUMERIC DEFAULT 0, is_bot BOOLEAN DEFAULT false);
  CREATE TABLE IF NOT EXISTS promotions (id SERIAL PRIMARY KEY, text TEXT, photo_url TEXT, target_type TEXT, group_id TEXT, interval_ms BIGINT, next_send_at BIGINT, last_sent_at BIGINT, active BOOLEAN DEFAULT true, created_at BIGINT);
  CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, uid TEXT, message TEXT, time BIGINT, read BOOLEAN DEFAULT false);
  CREATE TABLE IF NOT EXISTS analytics (key TEXT PRIMARY KEY, value NUMERIC DEFAULT 0);
  CREATE TABLE IF NOT EXISTS all_winners (id SERIAL PRIMARY KEY, uid TEXT, display_name TEXT, card_id TEXT, prize NUMERIC, is_bot BOOLEAN, time BIGINT);
`)
.then(() => console.log('✅ DB ready!'))
.catch(e => console.error('DB error:', e.message));
pool.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity BIGINT DEFAULT 0;
`).then(() => console.log('✅ last_activity column ready!'))
  .catch(e => console.error('ALTER error:', e.message));


async function getState(key) {
  const r = await pool.query('SELECT value FROM game_state WHERE key=$1', [key]);
  return r.rows.length ? JSON.parse(r.rows[0].value) : null;
}

async function setState(key, value) {
  await pool.query(
    'INSERT INTO game_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
    [key, JSON.stringify(value)]
  );
}

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.static(__dirname));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) FROM users');
    const notifications = await pool.query('SELECT COUNT(*) FROM notifications');
    const winners = await pool.query('SELECT COUNT(*) FROM all_winners');
    const dbSize = await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size");
    res.json({
      ok: true,
      users: Number(users.rows[0].count),
      notifications: Number(notifications.rows[0].count),
      winners: Number(winners.rows[0].count),
      db_size: dbSize.rows[0].size
    });
  } catch(e) {
    res.json({ ok: true });
  }
});

app.get('/user-state', async (req, res) => {
  const { userId, firstName } = req.query;
  const displayName = firstName ? decodeURIComponent(firstName) : userId;
  if (!userId) return res.json({ balance: 0, isNew: false });
  try {
    const existing = await pool.query('SELECT uid FROM users WHERE uid=$1', [userId]);
    const isNew = existing.rows.length === 0;
    if (isNew) {
      await pool.query(
        'INSERT INTO users(uid,display,balance,is_bot) VALUES($1,$2,20,false)',
        [userId, displayName]
      );
    } else {
      await pool.query(
  'UPDATE users SET display=$2, last_activity=$3 WHERE uid=$1',
  [userId, displayName, Date.now()]
);
    }
    const u = await pool.query('SELECT balance FROM users WHERE uid=$1', [userId]);
    res.json({ balance: u.rows[0]?.balance || 0, isNew });
  } catch(e) { res.json({ balance: 0, isNew: false }); }
});

app.post('/set-not-new', async (req, res) => { res.json({ ok: true }); });

app.get('/all-winners', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT uid as user, display_name as "displayName", card_id as "cardId", prize, time FROM all_winners ORDER BY time DESC LIMIT 100'
    );
    const round = (await getState('autoMode/round')) || 1;
    res.json({ winners: r.rows, round });
  } catch(e) { res.json({ winners: [], round: 1 }); }
});

app.post('/submit-payment',
  multer({ storage: multer.memoryStorage() }).single('photo'),
  async (req, res) => {
    const { userId, amount } = req.body;
    const file = req.file;
    if (!file || !userId || !amount)
      return res.json({ ok: false, msg: '❌ Data missing' });
    try {
      const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
      const boundary = '----FormBoundary' + Date.now();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pay.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        file.buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);
      const photoUrl = await new Promise((resolve) => {
        const opts = {
          hostname: 'api.cloudinary.com',
          path: `/v1_1/${CLOUDINARY_CLOUD}/image/upload`,
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length
          }
        };
        const req2 = require('https').request(opts, r => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d).secure_url || ''); } catch { resolve(''); } });
        });
        req2.on('error', () => resolve(''));
        req2.write(body); req2.end();
      });

      const key = `pay_${userId}_${Date.now()}`;
      const existing = (await getState('bot/payments')) || {};
      existing[key] = {
        user_id: userId, amount: Number(amount),
        photo_url: photoUrl, status: 'pending',
        time: new Date().toISOString()
      };
      await setState('bot/payments', existing);
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, msg: e.message }); }
  }
);

// ══ SSE ══
let sseClients = [];
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

function broadcast(data) {
  sseClients.forEach(client => { client.write(`data: ${JSON.stringify(data)}\n\n`); });
}

// ══ TTS PROXY ══
const SOUNDS_SERVER = 'http://localhost:3001';
app.get('/tts/winner-announce', async (req, res) => {
  try {
    const response = await new Promise((resolve, reject) => {
      http.get(`${SOUNDS_SERVER}/tts/winner-announce`, (r) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(chunk));
        r.on('end', () => resolve({ buffer: Buffer.concat(chunks) }));
        r.on('error', reject);
      }).on('error', reject);
    });
    res.set('Content-Type', 'audio/mpeg');
    res.send(response.buffer);
  } catch(e) { res.status(500).json({ error: 'TTS failed' }); }
});
app.get('/tts/congrats/:prize', async (req, res) => {
  const prize = req.params.prize;
  try {
    const response = await new Promise((resolve, reject) => {
      const text = encodeURIComponent(`ቢንጎ! እንኳን ደስ አለህ! ${prize} ብር አሸነፍክ!`);
      https.get(`https://translate.google.com/translate_tts?ie=UTF-8&q=${text}&tl=am&client=tw-ob`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, (r) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(chunk));
        r.on('end', () => resolve({ buffer: Buffer.concat(chunks) }));
        r.on('error', reject);
      }).on('error', reject);
    });
    res.set('Content-Type', 'audio/mpeg');
    res.send(response.buffer);
  } catch(e) { res.status(500).json({ error: 'TTS failed' }); }
});
app.get('/tts/bingo', async (req, res) => {
  try {
    const response = await new Promise((resolve, reject) => {
      http.get(`${SOUNDS_SERVER}/tts/bingo`, (r) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(chunk));
        r.on('end', () => resolve({ buffer: Buffer.concat(chunks) }));
        r.on('error', reject);
      }).on('error', reject);
    });
    res.set('Content-Type', 'audio/mpeg');
    res.send(response.buffer);
  } catch(e) { res.status(500).json({ error: 'TTS failed' }); }
});

app.get('/tts/number/:n', async (req, res) => {
  const n = parseInt(req.params.n);
  if (isNaN(n) || n < 1 || n > 75)
    return res.status(400).json({ error: 'Invalid number' });
  try {
    const response = await new Promise((resolve, reject) => {
      http.get(`${SOUNDS_SERVER}/tts/number/${n}`, (r) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(chunk));
        r.on('end', () => resolve({ buffer: Buffer.concat(chunks), type: r.headers['content-type'] }));
        r.on('error', reject);
      }).on('error', reject);
    });
    res.set('Content-Type', 'audio/mpeg');
    res.send(response.buffer);
  } catch(e) { res.status(500).json({ error: 'TTS failed' }); }
});

app.get('/game-state', async (req, res) => {
  try {
    const rows = await pool.query('SELECT key, value FROM game_state');
    const result = {};
    rows.rows.forEach(r => {
      const keys = r.key.split('/');
      let obj = result;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      try { obj[keys[keys.length-1]] = JSON.parse(r.value); }
      catch { obj[keys[keys.length-1]] = r.value; }
    });
    const flat = result.game || {};
    flat.autoMode = result.autoMode;
    flat.smartBot = result.smartBot;
    flat.settings = result.settings;
    flat.announcement = result.game?.announcement;
    flat.winners = result.game?.winners;
    flat.pendingWinner = result.game?.pendingWinner;
    flat.status = result.game?.status;
    flat.calledNumbers = result.game?.calledNumbers;
    flat.countdown = result.game?.countdown;
    flat.bet = result.game?.bet;
    flat.prize = result.game?.prize;
    flat.percent = result.game?.percent;
    flat.confirmedNumbers = result.game?.confirmedNumbers;
    flat.paid = result.game?.paid;

    const usersRes = await pool.query('SELECT uid, display FROM users');
    const displayNames = {};
    usersRes.rows.forEach(r => { displayNames[r.uid] = r.display; });
    flat.displayNames = displayNames;

    flat['game/countdown'] = flat.countdown;
    flat['game/status'] = flat.status;
    flat['game/calledNumbers'] = flat.calledNumbers;
    flat['game/winners'] = flat.winners;
    flat['game/bet'] = flat.bet;
    flat['game/prize'] = flat.prize;
    flat['game/percent'] = flat.percent;
    flat['game/confirmedNumbers'] = flat.confirmedNumbers;
    flat['game/paid'] = flat.paid;
    flat['game/pendingWinner'] = flat.pendingWinner;
    flat['game/announcement'] = flat.announcement;
    flat['autoMode/on'] = flat.autoMode?.on;
    flat['autoMode/phase'] = flat.autoMode?.phase;
    flat['autoMode/cdMinutes'] = flat.autoMode?.cdMinutes;
    flat['autoMode/round'] = flat.autoMode?.round;
    flat['autoMode/callSpeed'] = flat.autoMode?.callSpeed;
    flat['autoMode/botWinPercent'] = flat.autoMode?.botWinPercent;
    flat['smartBot/enabled'] = result.smartBot?.enabled;
    flat['bot/withdrawals'] = result.bot?.withdrawals;
    flat['bot/settings/cbe_account'] = result.bot?.settings?.cbe_account;
    flat['bot/settings/telebirr_account'] = result.bot?.settings?.telebirr_account;
    flat['confirmedNumbers'] = flat.confirmedNumbers;

    const analyticsRows = await pool.query('SELECT key, value FROM analytics');
    const analyticsData = {};
    analyticsRows.rows.forEach(r => { analyticsData[r.key] = Number(r.value); });

    flat['analytics/totalCollected']   = analyticsData['totalCollected']   || 0;
    flat['analytics/totalPaidOut']     = analyticsData['totalPaidOut']     || 0;
    flat['analytics/totalDeposits']    = analyticsData['totalDeposits']    || 0;
    flat['analytics/totalWithdrawals'] = analyticsData['totalWithdrawals'] || 0;
    flat['analytics/houseProfit'] = analyticsData['houseProfit'] || 0;
    flat['analytics/botBet']      = analyticsData['botBet']      || 0;
    flat['analytics/botWin']      = analyticsData['botWin']      || 0;

    const history = (await getState('analytics/history')) || [];
    flat['analytics/history'] = history;

    res.json(flat);
  } catch(e) { res.json({}); }
});

// ══ WITHDRAWALS ══
app.get('/withdrawals', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM game_state WHERE key='bot/withdrawals'");
    const data = r.rows.length ? JSON.parse(r.rows[0].value) : {};
    res.json({ withdrawals: data, serverTime: Date.now() });
  } catch(e) { res.json({ withdrawals: {}, serverTime: Date.now() }); }
});

app.get('/agents', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM game_state WHERE key='agents'");
    const data = r.rows.length ? JSON.parse(r.rows[0].value) : {};
    res.json(data);
  } catch(e) { res.json({}); }
});

app.get('/promotions-list', async (req, res) => {
  try {
    const rows = await pool.query('SELECT * FROM promotions WHERE active=true ORDER BY created_at DESC');
    res.json(rows.rows);
  } catch(e) { res.json([]); }
});

app.post('/delete-promotion', async (req, res) => {
  try {
    const { id } = req.body;

    const r = await pool.query('SELECT photo_url FROM promotions WHERE id=$1', [id]);
    const photoUrl = r.rows[0]?.photo_url || '';

    if (photoUrl) {
      try {
        const match = photoUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/i);
        const publicId = match ? match[1] : null;
        if (publicId) {
          const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
          const postData = JSON.stringify({ public_ids: [publicId] });
          await new Promise((resolve) => {
            const options = {
              hostname: 'api.cloudinary.com',
              path: `/v1_1/${CLOUDINARY_CLOUD}/resources/image/upload`,
              method: 'DELETE',
              headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
              }
            };
            const req2 = https.request(options, (r2) => { r2.on('data', ()=>{}); r2.on('end', resolve); });
            req2.on('error', resolve);
            req2.write(postData); req2.end();
          });
          console.log(`🗑️ Cloudinary deleted: ${publicId}`);
        }
      } catch(e) { console.error('❌ Cloudinary delete error:', e.message); }
    }

    await pool.query('DELETE FROM promotions WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// ══ SEND NOW PHOTO SAVE ══
app.post('/save-promo-photo', multer({ storage: multer.memoryStorage() }).single('photo'), async (req, res) => {
  const photoBuffer = req.file ? req.file.buffer : null;
  if (!photoBuffer) return res.json({ ok: false, msg: '❌ Photo የለም!' });
  try {
    const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
    const boundary = '----FormBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="promo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      photoBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="upload_preset"\r\n\r\nml_default\r\n--${boundary}--\r\n`)
    ]);
    const photoUrl = await new Promise((resolve) => {
      const options = {
        hostname: 'api.cloudinary.com',
        path: `/v1_1/${CLOUDINARY_CLOUD}/image/upload`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'Authorization': `Basic ${auth}`
        }
      };
      const req2 = https.request(options, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d).secure_url || ''); } catch { resolve(''); } });
      });
      req2.on('error', () => resolve(''));
      req2.write(body); req2.end();
    });

    const result = await pool.query(
      'INSERT INTO promotions(text,photo_url,target_type,interval_ms,active,created_at) VALUES($1,$2,$3,$4,false,$5) RETURNING id',
      ['__send_now__', photoUrl, 'bot', 0, Date.now()]
    );
    res.json({ ok: true, photoUrl, promoId: result.rows[0].id });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// ══ DELETE SEND NOW PHOTO ══
app.post('/delete-promo-photo', async (req, res) => {
  try {
    const { promoId, photoUrl } = req.body;

    if (photoUrl) {
      try {
        const match = photoUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/i);
        const publicId = match ? match[1] : null;
        if (publicId) {
          const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
          const postData = JSON.stringify({ public_ids: [publicId] });
          await new Promise((resolve) => {
            const options = {
              hostname: 'api.cloudinary.com',
              path: `/v1_1/${CLOUDINARY_CLOUD}/resources/image/upload`,
              method: 'DELETE',
              headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
              }
            };
            const req2 = https.request(options, (r2) => { r2.on('data', ()=>{}); r2.on('end', resolve); });
            req2.on('error', resolve);
            req2.write(postData); req2.end();
          });
          console.log(`🗑️ Cloudinary deleted: ${publicId}`);
        }
      } catch(e) { console.error('❌ Cloudinary delete error:', e.message); }
    }

    if (promoId) await pool.query('DELETE FROM promotions WHERE id=$1', [promoId]);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/give-balance', async (req, res) => {
  try {
    const { uid, amount } = req.body;
    await pool.query(
      'INSERT INTO users(uid,display,balance) VALUES($1,$2,$3) ON CONFLICT(uid) DO UPDATE SET balance=users.balance+$3',
      [uid, uid, amount]
    );
    const r = await pool.query('SELECT balance FROM users WHERE uid=$1', [uid]);
    const newBal = r.rows[0]?.balance || 0;
    broadcast({ type: 'balance', uid, balance: newBal });
    await updateAnalytics('totalDeposits', Number(amount));
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/save-accounts', async (req, res) => {
  try {
    const { cbe, telebirr } = req.body;
    if (cbe) await setState('bot/settings/cbe_account', cbe);
    if (telebirr) await setState('bot/settings/telebirr_account', telebirr);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.post('/withdrawal-action', async (req, res) => {
  try {
    const { key, action, uid, amount } = req.body;
    const allWd = JSON.parse(
      (await pool.query("SELECT value FROM game_state WHERE key='bot/withdrawals'")).rows[0]?.value || '{}'
    );
    if (!allWd[key]) return res.json({ ok: false, msg: 'Not found' });

    allWd[key].status = action === 'approve' ? 'approved' : 'rejected';
    await setState('bot/withdrawals', allWd);

    if (action === 'approve') {
      await updateAnalytics('totalWithdrawals', amount);
      const agentsData2 = JSON.parse(
        (await pool.query("SELECT value FROM game_state WHERE key='agents'")).rows[0]?.value || '{}'
      );
      const agentCode = agentsData2[allWd[key]?.acceptedBy]?.code || allWd[key]?.acceptedBy || '—';
      await pool.query(
        "UPDATE game_state SET value='0' WHERE key=$1",
        [`users/${uid}/pending_withdrawal`]
      );
      const wd = allWd[key];
      const method = wd?.method || 'ባንክ';
      const account = wd?.account || '—';
      await pool.query(
        'INSERT INTO notifications(uid,message,time,read) VALUES($1,$2,$3,false)',
        [uid, `✅ ${amount} ብር በ ${method} ተላከ!\n📋 Account: ${account}\n🔖 Agent: ${agentCode}`, Date.now()]
      );
    } else {
      await pool.query('UPDATE users SET balance=balance+$1 WHERE uid=$2', [amount, uid]);
      const r = await pool.query('SELECT balance FROM users WHERE uid=$1', [uid]);
      const newBal = r.rows[0]?.balance || 0;
      broadcast({ type: 'balance', uid, balance: newBal });
      await pool.query(
        'INSERT INTO notifications(uid,message,time,read) VALUES($1,$2,$3,false)',
        [uid, `❌ Withdrawal rejected — ${amount} ብር balance ላይ ተመለሰ!`, Date.now()]
      );
    }
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/add-agent', async (req, res) => {
  try {
    const { name, id_number } = req.body;
    const agents = JSON.parse(
      (await pool.query("SELECT value FROM game_state WHERE key='agents'")).rows[0]?.value || '{}'
    );
    const existingCodes = Object.values(agents)
      .map(a => a.code)
      .filter(Boolean)
      .map(c => parseInt(c.replace('AGT-', '')))
      .filter(n => !isNaN(n));
    const nextNum = existingCodes.length > 0 ? Math.max(...existingCodes) + 1 : 1;
    const code = 'AGT-' + String(nextNum).padStart(3, '0');
    agents[name] = { id_number, code };
    await setState('agents', agents);
    res.json({ ok: true, code });
  } catch(e) { res.json({ ok: false }); }
});

app.post('/delete-agent', async (req, res) => {
  try {
    const { name } = req.body;
    const agents = JSON.parse(
      (await pool.query("SELECT value FROM game_state WHERE key='agents'")).rows[0]?.value || '{}'
    );
    delete agents[name];
    await setState('agents', agents);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.post('/change-agent-pass', async (req, res) => {
  try {
    const { password } = req.body;
    await setState('settings/agent_password', password);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.post('/remove-bots', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE is_bot = true');
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.get('/unread-notifications', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, uid, message FROM notifications WHERE read=false ORDER BY time ASC LIMIT 50'
    );
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/mark-notification-read', async (req, res) => {
  try {
    const { id } = req.body;
    await pool.query('UPDATE notifications SET read=true WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.post('/update-balance', async (req, res) => {
  try {
    const { uid, amount, type } = req.body;
    if (type === 'add') {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE uid=$2', [amount, uid]);
    } else {
      await pool.query('UPDATE users SET balance = GREATEST(0, balance - $1) WHERE uid=$2', [amount, uid]);
    }
    const r = await pool.query('SELECT balance FROM users WHERE uid=$1', [uid]);
    const newBal = r.rows[0]?.balance || 0;
    broadcast({ type: 'balance', uid, balance: newBal });
    res.json({ ok: true, balance: newBal });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.get('/get-balance', async (req, res) => {
  try {
    const { uid } = req.query;
    const r = await pool.query('SELECT balance FROM users WHERE uid=$1', [uid]);
    res.json({ balance: r.rows[0]?.balance || 0 });
  } catch(e) { res.json({ balance: 0 }); }
});

// ══ WITHDRAWAL TOGGLE ══
app.get('/withdrawal-status', async (req, res) => {
  try {
    const enabled = (await getState('settings/withdrawal_enabled')) ?? true;
    res.json({ enabled });
  } catch(e) { res.json({ enabled: true }); }
});

app.post('/withdrawal-toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    await setState('settings/withdrawal_enabled', enabled);
    broadcast({ type: 'withdrawal_status', enabled });
    res.json({ ok: true, enabled });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// ══ CLEAR ANALYTICS ══
app.post('/clear-analytics', async (req, res) => {
  try {
    await pool.query('DELETE FROM analytics');
    await setState('analytics/history', []);
    console.log('🔄 Analytics manually cleared');
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// ══ CLOUDINARY ══
const CLOUDINARY_CLOUD = 'diado1bxi';
const CLOUDINARY_API_KEY = '117446111831141';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_SECRET;

let soundsMap = {};

async function loadCloudinarySounds() {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUDINARY_CLOUD}/resources/video?max_results=100`,
      method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const resources = json.resources || [];
          resources.forEach(r => {
            const publicId = r.public_id;
            const match = publicId.match(/^([A-Z]+\d+)/);
            const key = match ? match[1] : publicId;
            soundsMap[key] = r.secure_url;
          });
          console.log(`✅ Loaded ${Object.keys(soundsMap).length} sounds from Cloudinary`);
        } catch(e) { console.error('❌ Cloudinary parse error:', e.message); }
        resolve();
      });
    });
    req.on('error', (e) => { console.error('❌ Cloudinary load error:', e.message); resolve(); });
    req.end();
  });
}

app.get('/get-config', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM game_state WHERE key='adminConfig'");
    const config = r.rows.length ? JSON.parse(r.rows[0].value) : { loginPassword: '1234', settingsPassword: '9999' };
    res.json(config);
  } catch(e) { res.json({ loginPassword: '1234', settingsPassword: '9999' }); }
});

app.post('/save-config', async (req, res) => {
  try {
    const { loginPassword, settingsPassword } = req.body;
    const config = { loginPassword, settingsPassword };
    await pool.query(
      "INSERT INTO game_state(key,value) VALUES('adminConfig',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(config)]
    );
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.get('/sounds-map', (req, res) => res.json(soundsMap));
loadCloudinarySounds();

// ══ PROMOTIONS ══
app.post('/create-interval-promotion', multer({ storage: multer.memoryStorage() }).single('photo'), async (req, res) => {
  const { text, targetType, groupId, intervalMs } = req.body;
  const photoBuffer = req.file ? req.file.buffer : null;
  if (!text && !photoBuffer) return res.json({ ok: false, msg: '❌ Message ወይም Photo ያስፈልጋል!' });

  res.json({ ok: true, msg: '✅ Interval promotion ተጀምሯል!' });

  try {
    let photoUrl = '';
    if (photoBuffer) {
      const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
      const boundary = '----FormBoundary' + Date.now();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="promo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        photoBuffer,
        Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="upload_preset"\r\n\r\nml_default\r\n--${boundary}--\r\n`)
      ]);
      photoUrl = await new Promise((resolve) => {
        const options = {
          hostname: 'api.cloudinary.com',
          path: `/v1_1/${CLOUDINARY_CLOUD}/image/upload`,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
            'Authorization': `Basic ${auth}`
          }
        };
        const request = require('https').request(options, (r) => {
          let d = '';
          r.on('data', chunk => d += chunk);
          r.on('end', () => { try { resolve(JSON.parse(d).secure_url || ''); } catch(e) { resolve(''); } });
        });
        request.on('error', () => resolve(''));
        request.write(body); request.end();
      });
    }
    await pool.query(
      'INSERT INTO promotions(text,photo_url,target_type,group_id,interval_ms,next_send_at,active,created_at) VALUES($1,$2,$3,$4,$5,$6,true,$7)',
      [text || '', photoUrl, targetType || 'bot', groupId || '', Number(intervalMs) || 3600000, Date.now() + (Number(intervalMs) || 3600000), Date.now()]
    );
    console.log('✅ Interval promo created!');
  } catch(e) { console.error('❌ create-interval-promotion error:', e.message); }
});

app.post('/send-promotion', multer({ storage: multer.memoryStorage() }).single('photo'), async (req, res) => {
  const { text, targetType, groupId, photoUrl } = req.body;
  const photoBuffer = req.file ? req.file.buffer : null;
  if (!text && !photoBuffer && !photoUrl)
    return res.json({ ok: false, msg: '❌ Message ወይም Photo ያስፈልጋል!' });

  res.json({ ok: true, msg: '✅ Promotion እየተላከ ነው...' });

  broadcastPromotion({ text, photoBuffer, photoUrl, targetType, groupId })
    .catch(e => console.error('❌ broadcastPromotion:', e.message));
});

// ══ PROMOTION BROADCAST ══
async function broadcastPromotion(promoData) {
  try {
    const { text, photoBuffer, photoUrl, targetType, groupId } = promoData;
    const BOT_TOKEN = process.env.BOT_TOKEN || '';

    if (!BOT_TOKEN) {
      console.error('❌ BOT_TOKEN not set!');
      return;
    }

    if (targetType === 'group' && groupId) {
      let apiPath, bodyData;
      if (photoUrl) {
        apiPath = `/bot${BOT_TOKEN}/sendPhoto`;
        bodyData = JSON.stringify({
          chat_id: groupId,
          photo: photoUrl,
          caption: text || '',
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '🎮 Play Now', url: 'https://t.me/Firstanywharebingobot' }
            ]]
          }
        });
      } else {
        apiPath = `/bot${BOT_TOKEN}/sendMessage`;
        bodyData = JSON.stringify({
          chat_id: groupId,
          text: text || '',
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '🎮 Play Now', url: 'https://t.me/Firstanywharebingobot' }
            ]]
          }
        });
      }
      await new Promise((resolve) => {
        const opts = {
          hostname: 'api.telegram.org',
          path: apiPath,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) }
        };
        const r2 = https.request(opts, (r) => { r.on('data', ()=>{}); r.on('end', resolve); });
        r2.on('error', resolve);
        r2.write(bodyData); r2.end();
      });
      console.log('✅ Group promotion sent!');
      return;
    }

    const usersRes = await pool.query('SELECT uid FROM users WHERE is_bot = false');
    const uids = usersRes.rows.map(r => r.uid);
    console.log(`📢 Sending promotion to ${uids.length} users...`);

    for (const uid of uids) {
      try {
        if (photoBuffer) {
          const replyMarkup = JSON.stringify({
            inline_keyboard: [[
              { text: '🎮 Play Now', web_app: { url: 'https://benja0952346729-hash.github.io/Game/' } }
            ]]
          });
          const boundary = '----FormBoundary' + Date.now();
          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${uid}\r\n`),
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${text || ''}\r\n`),
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`),
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${replyMarkup}\r\n`),
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="promo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
            photoBuffer,
            Buffer.from(`\r\n--${boundary}--\r\n`)
          ]);
          await new Promise((resolve) => {
            const opts = {
              hostname: 'api.telegram.org',
              path: `/bot${BOT_TOKEN}/sendPhoto`,
              method: 'POST',
              headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
              }
            };
            const r2 = https.request(opts, (r) => { r.on('data', ()=>{}); r.on('end', resolve); });
            r2.on('error', resolve);
            r2.write(body); r2.end();
          });
        } else if (photoUrl) {
          const bodyData = JSON.stringify({
            chat_id: uid,
            photo: photoUrl,
            caption: text || '',
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '🎮 Play Now', web_app: { url: 'https://game-production-7f86.up.railway.app/' } }
              ]]
            }
          });
          await new Promise((resolve) => {
            const opts = {
              hostname: 'api.telegram.org',
              path: `/bot${BOT_TOKEN}/sendPhoto`,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyData)
              }
            };
            const r2 = https.request(opts, (r) => { r.on('data', ()=>{}); r.on('end', resolve); });
            r2.on('error', resolve);
            r2.write(bodyData); r2.end();
          });
        } else {
          const bodyData = JSON.stringify({
            chat_id: uid,
            text: text || '',
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '🎮 Play Now', web_app: { url: 'https://game-production-7f86.up.railway.app/' } }
              ]]
            }
          });
          await new Promise((resolve) => {
            const opts = {
              hostname: 'api.telegram.org',
              path: `/bot${BOT_TOKEN}/sendMessage`,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyData)
              }
            };
            const r2 = https.request(opts, (r) => { r.on('data', ()=>{}); r.on('end', resolve); });
            r2.on('error', resolve);
            r2.write(bodyData); r2.end();
          });
        }
        await new Promise(r => setTimeout(r, 50));
      } catch(e) {
        console.error(`❌ Promo to ${uid}:`, e.message);
      }
    }
    console.log(`✅ Promotion sent to ${uids.length} users`);
  } catch(e) { console.error('❌ broadcastPromotion error:', e.message); }
}

async function checkPromotions() {
  try {
    const promos = (await pool.query('SELECT * FROM promotions WHERE active=true')).rows;
    const now = Date.now();
    for (const p of promos) {
      if (!p.next_send_at) continue;
      if (now < Number(p.next_send_at)) continue;
      console.log(`📢 Sending interval promotion id=${p.id}`);
      try {
        await broadcastPromotion({
          text: p.text || '',
          photoBuffer: null,
          photoUrl: p.photo_url || '',
          targetType: p.target_type || 'bot',
          groupId: p.group_id || ''
        });
        await pool.query(
          'UPDATE promotions SET next_send_at=$1, last_sent_at=$2 WHERE id=$3',
          [now + (Number(p.interval_ms) || 3600000), now, p.id]
        );
        console.log(`✅ Promotion sent! id=${p.id}`);
      } catch(e) {
        console.error('❌ Promotion send error:', e.message);
        await pool.query(
          'UPDATE promotions SET next_send_at=$1 WHERE id=$2',
          [now + (Number(p.interval_ms) || 3600000), p.id]
        );
      }
    }
  } catch(e) {
    console.error('❌ checkPromotions error:', e.message);
  }
}

setInterval(checkPromotions, 60 * 1000);
console.log('📢 Promotion interval scheduler started');

app.post('/confirm-card', async (req, res) => {
  const { userId, cardId } = req.body;
  if (!userId || !cardId) return res.json({ ok: false, msg: 'Missing data' });
  try {
    const bet = (await getState('game/bet')) || 0;
    const balRes = await pool.query('SELECT balance FROM users WHERE uid=$1', [userId]);
    const bal = balRes.rows.length ? Number(balRes.rows[0].balance) : 0;
    if (bal < bet) return res.json({ ok: false, msg: '❌ Balance አንስተኛ ነው!' });

    const status = await getState('game/status');
    if (status?.started) return res.json({ ok: false, msg: '❌ Game ጀምሯል!' });

    const allCards = (await getState('game/confirmedNumbers')) || {};
    const myCards = Object.values(allCards).filter(v => String(v) === String(userId));
    if (myCards.length >= 10) return res.json({ ok: false, msg: '❌ ከ 10 ካርድ በላይ መያዝ አይቻልም!' });
    if (allCards[cardId]) return res.json({ ok: false, msg: '❌ Card ተይዟል!' });

    allCards[cardId] = userId;
    await setState('game/confirmedNumbers', allCards);
    await pool.query('UPDATE users SET balance = balance - $1 WHERE uid=$2', [bet, userId]);

    const total = Object.keys(allCards).length;
    const pct = (await getState('game/percent')) || 80;
    const totalBet = bet * total;
    // 5 card ካልሞሉ prize = total bet ሙሉ፣ 5 እና በላይ ከሆነ percent ይቀነሳል
    const prize = total < 5 ? totalBet : Math.floor(totalBet * (pct / 100));
    await setState('game/prize', prize);
    await setState('game/total', totalBet);

    await updateAnalytics('totalCollected', bet);

    const currentBet = await getState('game/bet');
    const allC = (await getState('game/confirmedNumbers')) || {};
    const totalCards = Object.keys(allC).length;
    const totalPlayers = new Set(Object.values(allC)).size;
    broadcast({ type: 'card_taken', cardId, userId, prize, bet: currentBet, totalCards, totalPlayers });

    return res.json({ ok: true, msg: '✅ Card confirmed!' });
  } catch(e) { return res.json({ ok: false, msg: 'Error: ' + e.message }); }
});

// ══ STATE ══
let autoModeOn = false;
let autoCdMinutes = 3;
let calledNumbers = [];
let callTimer = null;
let countdownTimer = null;
let announceTimer = null;
let roundNumber = 1;
let gamePct = 80;

console.log('🚀 Bingo Server Started!');

function getLetter(n) {
  if (n <= 15) return 'B';
  if (n <= 30) return 'I';
  if (n <= 45) return 'N';
  if (n <= 60) return 'G';
  return 'O';
}

function hashSeed(n) {
  let h = n;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function generateBoard(seed) {
  let s = seed;
  function rand() {
    s = (Math.imul(s, 1664525) + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0x100000000;
  }
  function getNums(min, max) {
    let arr = [];
    while(arr.length < 5) {
      let n = Math.floor(rand() * (max - min + 1)) + min;
      if(!arr.includes(n)) arr.push(n);
    }
    return arr;
  }
  let B=getNums(1,15), I=getNums(16,30), N=getNums(31,45),
      G=getNums(46,60), O=getNums(61,75);
  let b = [];
  for(let i=0;i<5;i++) b.push(B[i],I[i],N[i],G[i],O[i]);
  b[12] = 'FREE';
  return b;
}

function checkWin(board, called) {
  const calledNums = called.map(Number);
  const g = [];
  for (let i = 0; i < 5; i++) g.push(board.slice(i * 5, (i + 1) * 5));
  for (let r = 0; r < 5; r++)
    if (g[r].every(n => n === 'FREE' || calledNums.includes(Number(n)))) return true;
  for (let c = 0; c < 5; c++)
    if ([0,1,2,3,4].every(r => g[r][c] === 'FREE' || calledNums.includes(Number(g[r][c])))) return true;
  if ([0,1,2,3,4].every(i => g[i][i] === 'FREE' || calledNums.includes(Number(g[i][i])))) return true;
  if ([0,1,2,3,4].every(i => g[i][4-i] === 'FREE' || calledNums.includes(Number(g[i][4-i])))) return true;
  return false;
}

function clearAllTimers() {
  clearInterval(callTimer); callTimer = null;
  clearInterval(countdownTimer); countdownTimer = null;
  clearInterval(announceTimer); announceTimer = null;
}

// ══ WIN LINE PATTERNS ══
const ALL_WIN_LINES = [
  [0,1,2,3,4],      // row 1
  [5,6,7,8,9],      // row 2
  [10,11,12,13,14], // row 3
  [15,16,17,18,19], // row 4
  [20,21,22,23,24], // row 5
  [0,5,10,15,20],   // col 1 (B)
  [1,6,11,16,21],   // col 2 (I)
  [2,7,12,17,22],   // col 3 (N)
  [3,8,13,18,23],   // col 4 (G)
  [4,9,14,19,24],   // col 5 (O)
  [0,6,12,18,24],   // diagonal ↘
  [4,8,12,16,20],   // diagonal ↙
];

// Target card ላይ random winning line ይምረጥ — FREE ሳይቆጠር
function getWinningLine(board) {
  // Fisher-Yates shuffle — truly random (sort() bias አይደለም)
  const lines = [...ALL_WIN_LINES];
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  for (const line of lines) {
    const nums = line.map(i => board[i]).filter(n => n !== 'FREE');
    if (nums.length > 0) return nums;
  }
  // fallback
  return ALL_WIN_LINES[0].map(i => board[i]).filter(n => n !== 'FREE');
}

setInterval(async () => {
  try {
    const val = await getState('autoMode/on');
    if (val === true && !autoModeOn) {
      autoModeOn = true;
      console.log('✅ Auto Mode ON');
      autoCdMinutes = (await getState('autoMode/cdMinutes')) || 3;
      roundNumber = (await getState('autoMode/round')) || 1;
      startAutoCountdown();
    } else if (!val && autoModeOn) {
      autoModeOn = false;
      clearAllTimers();
      await setState('autoMode/phase', 'idle');
      console.log('⏹ Auto Mode OFF');
    }
  } catch(e) { console.error('❌ autoMode poll error:', e.message); }
}, 3000);

async function startAutoCountdown() {
  if (!autoModeOn) return;
  clearAllTimers();
  const secs = autoCdMinutes * 60;
  const startAt = Date.now() + secs * 1000;
  await setState('game/countdown', { active: true, startAt, mins: autoCdMinutes, autoStart: true });
  await setState('autoMode/phase', 'countdown');
  console.log(`⏱ Countdown: ${autoCdMinutes} min`);
  let remain = secs;
  countdownTimer = setInterval(async () => {
    if (!autoModeOn) { clearInterval(countdownTimer); return; }
    remain--;
    if (remain <= 0) { clearInterval(countdownTimer); await startAutoGame(); }
  }, 1000);
}

async function startAutoGame() {
  if (!autoModeOn) return;
  try {
    calledNumbers = [];
    await setState('game/countdown', { active: false });
    await setState('game/calledNumbers', []);
    await setState('game/pendingWinner', null);
    await setState('game/winners', null);
    await setState('game/paid', false);
    await setState('game/status', { started: true, autoStarted: true });
    await setState('autoMode/phase', 'playing');
    console.log('🎮 Game Started!');

    const callSpeed = (await getState('autoMode/callSpeed')) || 6000;
    await addBotsIfNeeded();

    // ── cards ሙሉ ለሙሉ 0 ከሆነ → countdown ይደገማል ──
    const currentCards = (await getState('game/confirmedNumbers')) || {};
    if (Object.keys(currentCards).length === 0) {
      console.log('⚠️ Cards 0 ነው — countdown ይደገማል');
      broadcast({ type: 'waiting_players', current: 0, needed: 1 });
      await startAutoCountdown();
      return;
    }

    setTimeout(() => { autoCallNumber(callSpeed); }, 2000);
  } catch(e) {
    console.error('❌ startAutoGame error:', e.message);
    setTimeout(() => { if (autoModeOn) startAutoCountdown(); }, 10000);
  }
}

async function addBotsIfNeeded() {
  try {
    const enabled = await getState('smartBot/enabled');
    if (!enabled) return;

    const minCards = (await getState('smartBot/minCards')) || 5;
    const allCards = (await getState('game/confirmedNumbers')) || {};

    const totalCards = Object.keys(allCards).length;
    const botsNeeded = Math.max(0, minCards - totalCards);
    if (botsNeeded === 0) return;

    const bet = (await getState('game/bet')) || 0;
    const pct = (await getState('game/percent')) || 80;

    for (let i = 0; i < botsNeeded; i++) {
      const botId = `bot_${Date.now()}_${i}`;
      const botName = `Bot${Math.floor(Math.random() * 9000) + 1000}`;
      await pool.query(
        'INSERT INTO users(uid,display,balance,is_bot) VALUES($1,$2,$3,true) ON CONFLICT(uid) DO UPDATE SET display=$2',
        [botId, botName, bet * 10]
      );
      const cardId = String(Math.floor(Math.random() * 900000) + 100000);
      if (!allCards[cardId]) {
        allCards[cardId] = botId;
        await pool.query('UPDATE users SET balance = balance - $1 WHERE uid=$2', [bet, botId]);
      }
    }

    await setState('game/confirmedNumbers', allCards);
    const total = Object.keys(allCards).length;
    const newTotal = bet * total;
    const newPrize = total < 5 ? newTotal : Math.floor(newTotal * (pct / 100));
    await setState('game/prize', newPrize);
    await setState('game/total', newTotal);
    await updateAnalytics('botBet', bet * botsNeeded);

    console.log(`🤖 Added ${botsNeeded} bots. Total cards: ${total}, prize: ${newPrize}`);
  } catch(e) { console.error('❌ addBotsIfNeeded error:', e.message); }
}

async function autoCallNumber(speed) {
  if (!autoModeOn) return;
  clearInterval(callTimer);

  const allCards = (await getState('game/confirmedNumbers')) || {};
  console.log(`📋 Cards at game start: ${Object.keys(allCards).length}`);

  if (Object.keys(allCards).length === 0) {
    console.log('⚠️ No cards found! Skipping to next round...');
    await scheduleNextRound();
    return;
  }

  const usersSnap = await pool.query('SELECT uid, display, is_bot FROM users');
  const allUsers = {};
  usersSnap.rows.forEach(r => { allUsers[r.uid] = { display: r.display, is_bot: r.is_bot }; });

  const cardInfoMap = {}, realCards = [], botCards = [];
  for (let cardId in allCards) {
    const uid = allCards[cardId];
    const isBot = allUsers[uid]?.is_bot === true;
    const name = allUsers[uid]?.display || String(uid);
    const entry = { user: uid, displayName: name, cardId, isBot };
    cardInfoMap[cardId] = entry;
    if (isBot) botCards.push(entry);
    else realCards.push(entry);
  }

  console.log(`🎮 Real cards: ${realCards.length}, Bot cards: ${botCards.length}`);

  const bet = (await getState('game/bet')) || 0;
  gamePct = (await getState('game/percent')) || 80;
  const realBetsTotal = bet * realCards.length;
  const botBetsTotal  = bet * botCards.length;

  const totalCards = Object.keys(allCards).length;
  const totalBetAmount = bet * totalCards;
  const prize = totalCards < 5 ? totalBetAmount : Math.floor(totalBetAmount * (gamePct / 100));
  await setState('game/prize', prize);

  const botWinPercent = (await getState('autoMode/botWinPercent')) ?? 50;
  const roll = Math.floor(Math.random() * 100) + 1;
  let targetCard = null;
  if (roll <= botWinPercent) {
    targetCard = botCards.length > 0
      ? botCards[Math.floor(Math.random() * botCards.length)]
      : realCards.length > 0 ? realCards[Math.floor(Math.random() * realCards.length)] : null;
  } else {
    targetCard = realCards.length > 0
      ? realCards[Math.floor(Math.random() * realCards.length)]
      : botCards.length > 0 ? botCards[Math.floor(Math.random() * botCards.length)] : null;
  }

  if (!targetCard) {
    console.log('⚠️ No target card — scheduling next round');
    await scheduleNextRound();
    return;
  }

  const targetBoard = generateBoard(hashSeed(Number(targetCard.cardId)));
  const allBoards = {};
  for (let cardId in cardInfoMap) allBoards[cardId] = generateBoard(hashSeed(Number(cardId)));

  // ══ FIX: neededNums = አንድ random winning line ብቻ ══
  const neededNums = getWinningLine(targetBoard);
  console.log(`🎯 Target: ${targetCard.cardId} (${targetCard.isBot ? 'BOT' : 'REAL'}) | Line: [${neededNums.join(',')}]`);

  // ══ Game start ላይ አንድ ጊዜ ብቻ ያነባል — DB load ይቀንሳል ══
  const noBotBias = (await getState('autoMode/noBotBias')) ?? 0.50;
  console.log(`⚙️ noBotBias: ${noBotBias}`);

  callTimer = setInterval(async () => {
    try {
      if (!autoModeOn) { clearInterval(callTimer); return; }

      const pend = await getState('game/pendingWinner');
      if (pend && !pend.announced) {
        clearInterval(callTimer);
        startAutoAnnounce(realBetsTotal, botBetsTotal);
        return;
      }

      const used = new Set(calledNumbers);
      const remaining = [...Array(75)].map((_, i) => i + 1).filter(n => !used.has(n));

      if (!remaining.length) {
        clearInterval(callTimer);
        for (let cardId in allCards) {
          const uid = allCards[cardId];
          if (allUsers[uid]?.is_bot) continue;
          await pool.query('UPDATE users SET balance = balance + $1 WHERE uid=$2', [bet, uid]);
          const r = await pool.query('SELECT balance FROM users WHERE uid=$1', [uid]);
          broadcast({ type: 'balance', uid, balance: r.rows[0]?.balance || 0 });
          await pool.query(
            'INSERT INTO notifications(uid,message,time,read) VALUES($1,$2,$3,false)',
            [uid, `⚠️ Game ሳይጠናቀቅ ተዘጋ — ${bet} ብር ተመለሰ!`, Date.now()]
          );
        }
        await setState('game/announcement', { type: 'no_winner', message: 'ምንም አሸናፊ አልተገኘም', time: Date.now() });
        await scheduleNextRound();
        return;
      }

      // ══ FIX: neededRemaining = target winning line ውስጥ ያልወጡ ቁጥሮች ══
      const neededRemaining = neededNums.filter(n => !calledNumbers.includes(n));

      const rand = Math.random();
      let n;
      if (neededRemaining.length <= 3 && neededRemaining.length > 0 && rand < noBotBias) {
        // Target line ን ለማጠናቀቅ needed number ይምረጥ
        n = neededRemaining[Math.floor(Math.random() * neededRemaining.length)];
      } else {
        // ሙሉ random — fair ነው፣ target አትጎዳ
        n = remaining[Math.floor(Math.random() * remaining.length)];
      }

      calledNumbers.push(n);
      const called = (await getState('game/calledNumbers')) || [];
      called.push(n);
      await setState('game/calledNumbers', called);
      console.log(`📢 ${getLetter(n)}${n} | needed: [${neededRemaining.join(',')}]`);

      const winners = [];
      for (let cardId in allBoards)
        if (checkWin(allBoards[cardId], calledNumbers))
          winners.push({ ...cardInfoMap[cardId], time: Date.now() });

      if (winners.length > 0) {
        clearInterval(callTimer);
        console.log(`🏆 Winner found after ${calledNumbers.length} calls`);
        await setState('game/pendingWinner', { winners, prize, announced: false, time: Date.now() });
        startAutoAnnounce(realBetsTotal, botBetsTotal);
      }
    } catch(e) { console.error('❌ callNumber error:', e.message); }
  }, speed);
}

async function startAutoAnnounce(realBetsTotal, botBetsTotal) {
  if (!autoModeOn) return;
  clearAllTimers();
  await setState('autoMode/phase', 'announcing');
  console.log('🎉 Winner found! Announcing in 5 seconds...');
  let count = 5;
  announceTimer = setInterval(async () => {
    count--;
    console.log(`⏳ Announcing in ${count}s...`);
    if (count <= 0) {
      clearInterval(announceTimer);
      announceTimer = null;
      await announceWinner(realBetsTotal, botBetsTotal);
      await scheduleNextRound();
    }
  }, 1000);
}

async function announceWinner(realBetsTotal, botBetsTotal) {
  try {
    const data = await getState('game/pendingWinner');
    if (!data) return;
    const { winners, prize } = data;
    const share = Math.floor(prize / winners.length);

    let realWinShare = 0;
    let botWinShare = 0;
    let botWon = false;

    for (let w of winners) {
      if (w.isBot) {
        botWon = true;
        botWinShare += share;
      } else {
        realWinShare += share;
        await pool.query('UPDATE users SET balance = balance + $1 WHERE uid=$2', [share, w.user]);
        const r = await pool.query('SELECT balance FROM users WHERE uid=$1', [w.user]);
        broadcast({ type: 'balance', uid: w.user, balance: r.rows[0]?.balance || 0 });
        await pool.query(
          'INSERT INTO notifications(uid,message,time,read) VALUES($1,$2,$3,false)',
          [w.user, `🎉 Round ${roundNumber} — አሸነፍክ! ${w.displayName}!\n💰 ${share} ብር balance ላይ ታከለ!\n🎴 Card #${w.cardId}\n🕐 ${new Date().toLocaleTimeString('am-ET')}`, Date.now()]
        );
      }
    }

    const winnersObj = {};
    winners.forEach((w, i) => { winnersObj[i] = { ...w, prize: share }; });
    await setState('game/winners', winnersObj);

    for (const w of winners) {
      await pool.query(
        'INSERT INTO all_winners(uid,display_name,card_id,prize,is_bot,time) VALUES($1,$2,$3,$4,$5,$6)',
        [w.user, w.displayName, w.cardId, share, w.isBot || false, Date.now()]
      );
    }

    const winnerPayload = {
      type: 'winner',
      winners,
      prize,
      share,
      calledNumbers,
      time: Date.now()
    };
    broadcast(winnerPayload);

    broadcast({
      type: 'winner_popup',
      winners: winners.filter(w => !w.isBot),
      share,
      prize,
      calledNumbers,
      time: Date.now()
    });

    await setState('game/announcement', { type: 'winner', winners, prize, share, time: Date.now(), calledNumbers });

    // ══ TELEGRAM GROUP WINNER ANNOUNCE ══
    try {
      const BOT_TOKEN = process.env.BOT_TOKEN || '';
      const GROUP_ID = '-1003570659417';

      if (BOT_TOKEN && GROUP_ID) {
        const intervalMins = (await getState('settings/groupAnnounceInterval')) || 0;

        if (intervalMins > 0) {
          const intervalMs = intervalMins * 60 * 1000;
          const lastSent = (await getState('settings/lastGroupAnnounce')) || 0;

          if (Date.now() - lastSent >= intervalMs) {
            await setState('settings/lastGroupAnnounce', Date.now());

            const winnerLines = winners.map(w =>
              `🏆 <b>${w.displayName}</b>`
            ).join('\n');

            const msg = [
              `🎉 <b>Round ${roundNumber} — አሸናፊ ተገኘ!</b>`,
              ``,
              winnerLines,
              ``,
              `💰 Prize: <b>${share} ብር</b>`,
              `🔢 Numbers Called: <b>${calledNumbers.length}</b>`,
              `🕐 ${new Date().toLocaleTimeString('am-ET')}`,
              ``,
              `🎮 ጨዋታ ለመቀጠል Bot ይጠቀሙ!`
            ].join('\n');

            const bodyData = JSON.stringify({
              chat_id: GROUP_ID,
              text: msg,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '🎮 Play Now', url: 'https://t.me/Firstanywharebingobot' }
                ]]
              }
            });

            await new Promise((resolve) => {
              const opts = {
                hostname: 'api.telegram.org',
                path: `/bot${BOT_TOKEN}/sendMessage`,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(bodyData)
                }
              };
              const r2 = https.request(opts, (r) => {
                let d = '';
                r.on('data', c => d += c);
                r.on('end', () => {
                  console.log('📢 Group announce sent:', d.slice(0, 120));
                  resolve();
                });
              });
              r2.on('error', (e) => {
                console.error('❌ Group announce error:', e.message);
                resolve();
              });
              r2.write(bodyData);
              r2.end();
            });

            console.log('✅ Winner announced to Telegram group!');
          } else {
            console.log('⏭ Group announce skipped — interval not reached');
          }
        } else {
          console.log('⏭ Group announce off — interval is 0');
        }
      }
    } catch(e) {
      console.error('❌ Telegram group announce error:', e.message);
    }
    // ══ END TELEGRAM GROUP ANNOUNCE ══

    await setState('game/paid', true);
    await setState('game/pendingWinner', { ...data, announced: true });

    setTimeout(async () => {
      await setState('game/status', { started: false, waitingRestart: true });
    }, 6000);

    await updateAnalytics('totalPaidOut', realWinShare);
    const roundHouseProfit = realBetsTotal - realWinShare;
    await updateAnalytics('houseProfit', roundHouseProfit);
    await updateAnalytics('botWin', botWinShare);

    const todayStr = new Date().toISOString().split('T')[0];
    const history = (await getState('analytics/history')) || [];
    const todayIdx = history.findIndex(h => h.date === todayStr);
    if (todayIdx >= 0) {
      history[todayIdx].houseProfit = (history[todayIdx].houseProfit || 0) + roundHouseProfit;
      history[todayIdx].botBet = (history[todayIdx].botBet || 0) + botBetsTotal;
      history[todayIdx].botWin = (history[todayIdx].botWin || 0) + botWinShare;
      history[todayIdx].rounds = (history[todayIdx].rounds || 0) + 1;
      if (botWon) history[todayIdx].botWins = (history[todayIdx].botWins || 0) + 1;
      else history[todayIdx].playerWins = (history[todayIdx].playerWins || 0) + 1;
    } else {
      history.push({
        date: todayStr,
        houseProfit: roundHouseProfit,
        botBet: botBetsTotal,
        botWin: botWinShare,
        rounds: 1,
        botWins: botWon ? 1 : 0,
        playerWins: botWon ? 0 : 1
      });
    }
    await setState('analytics/history', history.slice(-30));

    console.log(`✅ Round done! realBets:${realBetsTotal} botBets:${botBetsTotal} paidOut:${realWinShare} houseProfit:${roundHouseProfit} botWon:${botWon}`);
  } catch(e) { console.error('❌ announceWinner error:', e.message); }
}

// ══ ኢትዮጵያ ጠዋት 12:00 (6:00 AM UTC+3) reset key ══
function getEthiopianDayKey() {
  // UTC+3 ሰዓት ያሰላል
  const now = new Date();
  const etMs = now.getTime() + (3 * 60 * 60 * 1000); // UTC+3
  const etDate = new Date(etMs);
  // ጠዋት 6:00 AM UTC+3 = Ethiopian 12:00 ጠዋት
  // ስለዚህ ቀን key = ቀኑ ጠዋት 6:00 AM ጀምሮ ቀጣዩ 6:00 AM ድረስ
  const hour = etDate.getUTCHours();
  const dateStr = etDate.toISOString().split('T')[0];
  // 6:00 AM በፊት ከሆነ ቀዳሚው ቀን key ይሆናል
  if (hour < 6) {
    const prevDay = new Date(etMs - 24 * 60 * 60 * 1000);
    return prevDay.toISOString().split('T')[0];
  }
  return dateStr;
}

async function scheduleNextRound() {
  if (!autoModeOn) return;
  try {
    const todayStr = getEthiopianDayKey();
    const lastReset = await getState('analytics/lastResetDate');
    if (lastReset !== todayStr) {
      await setState('analytics/lastResetDate', todayStr);
      roundNumber = 1;
      await setState('autoMode/round', roundNumber);
      console.log('🔄 Ethiopian Daily Reset (12:00 ጠዋት):', todayStr);
    }

    roundNumber++;
    await setState('autoMode/round', roundNumber);
    await setState('game/calledNumbers', []);
    await setState('game/status', { started: false });
    await setState('game/winners', null);

    setTimeout(async () => {
      await setState('game/pendingWinner', null);
      await setState('game/announcement', null);
    }, 10000);

    await setState('game/paid', false);
    await setState('game/confirmedNumbers', {});
    await setState('game/prize', 0);
    await setState('game/total', 0);
    calledNumbers = [];

    await pool.query('DELETE FROM users WHERE is_bot = true');

    await setState('autoMode/phase', 'countdown');
    setTimeout(async () => { if (autoModeOn) await startAutoCountdown(); }, 3000);
  } catch(e) {
    console.error('❌ scheduleNextRound error:', e.message);
    setTimeout(() => { if (autoModeOn) startAutoCountdown(); }, 15000);
  }
}

setTimeout(async () => {
  try {
    const autoOn = await getState('autoMode/on');
    if (autoOn === true) {
      console.log('🔄 Restoring auto mode after restart...');
      autoModeOn = true;
      autoCdMinutes = (await getState('autoMode/cdMinutes')) || 3;
      roundNumber = (await getState('autoMode/round')) || 1;
      gamePct = (await getState('game/percent')) || 80;
      const gameStatus = await getState('game/status');
      if (gameStatus?.started) {
        await scheduleNextRound();
      } else {
        await startAutoCountdown();
      }
    }
  } catch(e) { console.error('❌ Restore error:', e.message); }
}, 3000);

setInterval(async () => {
  try {
    await pool.query('DELETE FROM notifications WHERE time < $1', [Date.now() - (7 * 24 * 60 * 60 * 1000)]);
    await pool.query(`DELETE FROM all_winners WHERE id NOT IN (SELECT id FROM all_winners ORDER BY time DESC LIMIT 500)`);
    await pool.query('DELETE FROM promotions WHERE active=false AND created_at < $1', [Date.now() - (30 * 24 * 60 * 60 * 1000)]);

    const lastReset = (await getState('analytics/lastFullReset')) || 0;
    const fiveDays = 5 * 24 * 60 * 60 * 1000;
    if (Date.now() - lastReset >= fiveDays) {
      await pool.query('DELETE FROM analytics');
      await setState('analytics/history', []);
      await setState('analytics/lastFullReset', Date.now());
      console.log('🔄 Analytics full reset (5 days)');
    }

    console.log('✅ Auto cleanup done');
  } catch(e) { console.error('Cleanup error:', e.message); }
}, 24 * 60 * 60 * 1000);

// ══ ADMIN CONTROL ENDPOINTS ══
app.post('/admin/auto-start', async (req, res) => {
  try {
    await setState('autoMode/on', true);
    autoModeOn = true;
    autoCdMinutes = (await getState('autoMode/cdMinutes')) || 3;
    roundNumber = (await getState('autoMode/round')) || 1;
    startAutoCountdown();
    res.json({ ok: true, msg: '✅ Auto mode started!' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/admin/auto-stop', async (req, res) => {
  try {
    await setState('autoMode/on', false);
    autoModeOn = false;
    clearAllTimers();
    await setState('autoMode/phase', 'idle');
    await setState('game/countdown', { active: false });
    res.json({ ok: true, msg: '✅ Auto mode stopped!' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/admin/set-settings', async (req, res) => {
  try {
    const { bet, percent, cdMinutes, callSpeed, botWinPercent, botMinCards, noBotBias } = req.body;
    if (bet !== undefined) await setState('game/bet', Number(bet));
    if (percent !== undefined) {
      await setState('game/percent', Number(percent));
      gamePct = Number(percent);
    }
    if (cdMinutes !== undefined) await setState('autoMode/cdMinutes', Number(cdMinutes));
    if (callSpeed !== undefined) await setState('autoMode/callSpeed', Number(callSpeed));
    if (botWinPercent !== undefined) await setState('autoMode/botWinPercent', Number(botWinPercent));
    if (botMinCards !== undefined) await setState('smartBot/minCards', Number(botMinCards));
    if (noBotBias !== undefined) await setState('autoMode/noBotBias', Number(noBotBias));
    res.json({ ok: true, msg: '✅ Settings saved!' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/set-state', async (req, res) => {
  try {
    const { key, value } = req.body;
    await setState(key, value);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/start-auto', async (req, res) => {
  try {
    const { cdMinutes, callSpeed } = req.body;
    if (cdMinutes) await setState('autoMode/cdMinutes', Number(cdMinutes));
    if (callSpeed) await setState('autoMode/callSpeed', Number(callSpeed));
    await setState('autoMode/on', true);
    autoModeOn = true;
    autoCdMinutes = cdMinutes || autoCdMinutes;
    startAutoCountdown();
    res.json({ ok: true, msg: '✅ Auto started!' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// ══ AGENT ENDPOINTS ══
app.post('/withdrawal-accept', async (req, res) => {
  try {
    const { key, agentId } = req.body;
    if (!key || !agentId) return res.json({ ok: false, msg: 'Missing data' });
    const allWd = JSON.parse(
      (await pool.query("SELECT value FROM game_state WHERE key='bot/withdrawals'")).rows[0]?.value || '{}'
    );
    if (!allWd[key]) return res.json({ ok: false, msg: 'Not found' });
    const now = Date.now();
    const LOCK_MS = 3 * 60 * 1000;
    if (allWd[key].status === 'accepted' && allWd[key].acceptedBy !== agentId && now - (allWd[key].acceptedAt || 0) < LOCK_MS) {
      return res.json({ ok: false, msg: '⚠️ ሌላ Agent ወስዷል!' });
    }
    const myActive = Object.entries(allWd).find(
      ([k, v]) => v.status === 'accepted' && v.acceptedBy === agentId && k !== key
    );
    if (myActive) return res.json({ ok: false, msg: '⚠️ አሁን ያለህን Request አጠናቅ!' });
    allWd[key].status = 'accepted';
    allWd[key].acceptedBy = agentId;
    allWd[key].acceptedAt = now;
    await setState('bot/withdrawals', allWd);
    res.json({ ok: true, msg: '✅ Request ተቀበልክ! 3 ደቂቃ አለህ.' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/withdrawal-release', async (req, res) => {
  try {
    const { key, agentId } = req.body;
    if (!key || !agentId) return res.json({ ok: false, msg: 'Missing data' });
    const allWd = JSON.parse(
      (await pool.query("SELECT value FROM game_state WHERE key='bot/withdrawals'")).rows[0]?.value || '{}'
    );
    if (!allWd[key]) return res.json({ ok: false, msg: 'Not found' });
    if (allWd[key].acceptedBy !== agentId) return res.json({ ok: false, msg: '❌ ይህ request ያንተ አይደለም!' });
    allWd[key].status = 'pending';
    allWd[key].acceptedBy = null;
    allWd[key].acceptedAt = null;
    await setState('bot/withdrawals', allWd);
    res.json({ ok: true, msg: '↩ Request ለሌላ Agent ተለቀቀ!' });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post(
  '/withdrawal-paid',
  multer({ storage: multer.memoryStorage() }).single('photo'),
  async (req, res) => {
    try {
      const { key, agentId } = req.body;
      const file = req.file;
      if (!key || !agentId) return res.json({ ok: false, msg: 'Missing data' });
      const allWd = JSON.parse(
        (await pool.query("SELECT value FROM game_state WHERE key='bot/withdrawals'")).rows[0]?.value || '{}'
      );
      const wd = allWd[key];
      if (!wd) return res.json({ ok: false, msg: 'Not found' });
      if (wd.acceptedBy !== agentId) return res.json({ ok: false, msg: '❌ ይህ request ያንተ አይደለም!' });

      const uid = String(wd.user_id);
      const amount = wd.amount || 0;
      const method = wd.method || 'ባንክ';
      const account = wd.account || '—';
      const BOT_TOKEN = process.env.BOT_TOKEN || '';
      const agents = JSON.parse(
        (await pool.query("SELECT value FROM game_state WHERE key='agents'")).rows[0]?.value || '{}'
      );
      const agentCode = agents[agentId]?.code || agentId;

      if (file && BOT_TOKEN) {
        try {
          const boundary = '----FormBoundary' + Date.now();
          const caption = `✅ ${amount} ብር በ ${method} ተላከ!\n📋 Account: ${account}\n🔖 Agent: ${agentCode}`;
          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${uid}\r\n`),
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
            file.buffer,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]);
          await new Promise((resolve) => {
            const opts = {
              hostname: 'api.telegram.org',
              path: `/bot${BOT_TOKEN}/sendPhoto`,
              method: 'POST',
              headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
            };
            const r2 = require('https').request(opts, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{console.log('📸 TG photo:',d.slice(0,80));resolve();}); });
            r2.on('error', () => resolve());
            r2.write(body); r2.end();
          });
        } catch(e) { console.error('❌ TG photo error:', e.message); }
      }

      allWd[key].status = 'approved';
      await setState('bot/withdrawals', allWd);
      await updateAnalytics('totalWithdrawals', amount);

      await pool.query(
        "UPDATE game_state SET value='0' WHERE key=$1",
        [`users/${uid}/pending_withdrawal`]
      );

      await pool.query(
        'INSERT INTO notifications(uid,message,time,read) VALUES($1,$2,$3,false)',
        [uid, `✅ ${amount} ብር በ ${method} ተላከ!\n📋 Account: ${account}\n🔖 Agent: ${agentCode}`, Date.now()]
      );
      broadcast({ type: 'withdrawal_approved', key, uid, amount });
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, msg: e.message }); }
  }
);

app.post('/agent-verify', async (req, res) => {
  try {
    const { name, idNumber, password } = req.body;
    const agents = JSON.parse(
      (await pool.query("SELECT value FROM game_state WHERE key='agents'")).rows[0]?.value || '{}'
    );
    const agent = agents[name];
    if (!agent) return res.json({ ok: false, msg: '❌ Agent አልተመዘገበም!' });
    if (String(agent.id_number) !== String(idNumber))
      return res.json({ ok: false, msg: '❌ የግል ቁጥር ትክክል አይደለም!' });
    const agentPass =
      (await pool.query("SELECT value FROM game_state WHERE key='settings/agent_password'")).rows[0]?.value?.replace(/"/g, '') || 'agent2025';
    if (password !== agentPass)
      return res.json({ ok: false, msg: '❌ Password ትክክል አይደለም!' });
    res.json({ ok: true, agentName: name });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// ══ DB ENDPOINTS ══
app.get('/db-get', async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) return res.json(null);

    const r = await pool.query('SELECT value FROM game_state WHERE key=$1', [path]);
    if (r.rows.length) {
      try { return res.json(JSON.parse(r.rows[0].value)); }
      catch { return res.json(r.rows[0].value); }
    }

    const prefix = path.endsWith('/') ? path : path + '/';
    const r2 = await pool.query(
      'SELECT key, value FROM game_state WHERE key LIKE $1',
      [prefix + '%']
    );
    if (!r2.rows.length) return res.json(null);

    const result = {};
    for (const row of r2.rows) {
      const subKey = row.key.slice(prefix.length);
      try { result[subKey] = JSON.parse(row.value); }
      catch { result[subKey] = row.value; }
    }
    return res.json(result);

  } catch(e) { res.json(null); }
});

app.post('/db-set', async (req, res) => {
  try {
    const { path, value } = req.body;
    if (!path) return res.json({ ok: false });
    if (value === null || value === undefined) {
      await pool.query('DELETE FROM game_state WHERE key=$1', [path]);
    } else {
      await pool.query(
        'INSERT INTO game_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
        [path, JSON.stringify(value)]
      );
    }
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/db-push', async (req, res) => {
  try {
    const { path, value } = req.body;
    if (!path) return res.json({ ok: false });
    const r = await pool.query('SELECT value FROM game_state WHERE key=$1', [path]);
    let existing = {};
    if (r.rows.length) {
      try { existing = JSON.parse(r.rows[0].value); } catch { existing = {}; }
    }
    const key = String(Date.now()) + Math.random().toString(36).slice(2,6);
    existing[key] = value;
    await pool.query(
      'INSERT INTO game_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
      [path, JSON.stringify(existing)]
    );
    res.json({ ok: true, key });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.get('/fix-pending', async (req, res) => {
  try {
    const { uid } = req.query;
    await pool.query(
      "INSERT INTO game_state(key,value) VALUES($1,'0') ON CONFLICT(key) DO UPDATE SET value='0'",
      [`users/${uid}/pending_withdrawal`]
    );
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// ══ CLOUDINARY CLEANUP ══
app.post('/clear-cloudinary', async (req, res) => {
  try {
    const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');

    const activePromos = await pool.query('SELECT photo_url FROM promotions WHERE active=true AND photo_url IS NOT NULL');
    const activeUrls = new Set(activePromos.rows.map(r => r.photo_url).filter(Boolean));

    const resources = await new Promise((resolve) => {
      const options = {
        hostname: 'api.cloudinary.com',
        path: `/v1_1/${CLOUDINARY_CLOUD}/resources/image?max_results=100`,
        method: 'GET',
        headers: { 'Authorization': `Basic ${auth}` }
      };
      const req2 = https.request(options, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          try { resolve(JSON.parse(d).resources || []); }
          catch { resolve([]); }
        });
      });
      req2.on('error', () => resolve([]));
      req2.end();
    });

    let deleted = 0;
    for (const resource of resources) {
      const url = resource.secure_url;
      if (!activeUrls.has(url)) {
        await new Promise((resolve) => {
          const postData = JSON.stringify({ public_ids: [resource.public_id] });
          const options = {
            hostname: 'api.cloudinary.com',
            path: `/v1_1/${CLOUDINARY_CLOUD}/resources/image/upload`,
            method: 'DELETE',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData)
            }
          };
          const req2 = https.request(options, (r) => { r.on('data', ()=>{}); r.on('end', resolve); });
          req2.on('error', resolve);
          req2.write(postData); req2.end();
        });
        deleted++;
      }
    }

    console.log(`🗑️ Cloudinary cleanup: ${deleted} images deleted`);
    res.json({ ok: true, deleted, total: resources.length, kept: resources.length - deleted });
  } catch(e) {
    console.error('❌ Cloudinary cleanup error:', e.message);
    res.json({ ok: false, msg: e.message });
  }
});

// ══ SCHEDULED GROUP ANNOUNCE ══
setInterval(async () => {
  try {
    const intervalMins = (await getState('settings/groupAnnounceInterval')) || 0;
    if (!intervalMins) return;
    const intervalMs = intervalMins * 60 * 1000;
    const lastSent = (await getState('settings/lastGroupAnnounce')) || 0;
    if (Date.now() - lastSent < intervalMs) return;
    await setState('settings/lastGroupAnnounce', Date.now());
    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    const GROUP_ID = '-1003570659417';
    if (!BOT_TOKEN) return;

    const r = await pool.query(
      'SELECT display_name, card_id, prize, time FROM all_winners ORDER BY time DESC LIMIT 1'
    );
    if (!r.rows.length) return;
    const w = r.rows[0];

    const msg = [
      `🏆 <b>ቅርብ ጊዜ አሸናፊ!</b>`,
      ``,
      `👤 <b>${w.display_name}</b>`,
      `🎴 Card #${w.card_id}`,
      `💰 Prize: <b>${w.prize} ብር</b>`,
      `🕐 ${new Date(Number(w.time)).toLocaleTimeString('am-ET')}`,
      ``,
      `🎮 ጨዋታ ለመቀጠል Bot ይጠቀሙ!`
    ].join('\n');

    const bodyData = JSON.stringify({
      chat_id: GROUP_ID,
      text: msg,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '🎮 Play Now', url: 'https://t.me/Firstanywharebingobot' }
        ]]
      }
    });

    await new Promise((resolve) => {
      const opts = {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) }
      };
      const r2 = https.request(opts, (r) => { r.on('data', ()=>{}); r.on('end', resolve); });
      r2.on('error', resolve);
      r2.write(bodyData); r2.end();
    });

    console.log(`✅ Scheduled group announce sent!`);
  } catch(e) { console.error('❌ Scheduled announce error:', e.message); }
}, 60 * 1000);

app.post('/set-group-announce-interval', async (req, res) => {
  try {
    const { minutes } = req.body;
    await setState('settings/groupAnnounceInterval', Number(minutes));
    res.json({ ok: true, msg: `✅ ${minutes} ደቂቃ set ተደረገ!` });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.get('/all-balances', async (req, res) => {
  try {
    const r = await pool.query('SELECT uid, display, balance, last_activity FROM users WHERE is_bot = false');
    const balances = {};
    r.rows.forEach(row => {
      balances[row.uid] = {
        balance: Number(row.balance),
        last_activity: row.last_activity ? Number(row.last_activity) : null
      };
    });
    res.json(balances);
  } catch(e) { res.json({}); }
});

// ══ BOT USERS ══
app.get('/bot-users', async (req, res) => {
  try {
    const now = Date.now();
    const LIVE_MS = 5 * 60 * 1000;
    const r = await pool.query(
      'SELECT uid, display, balance, last_activity FROM users WHERE is_bot = false'
    );
    const users = {};
    r.rows.forEach(row => {
      const lastActivity = row.last_activity ? Number(row.last_activity) : null;
      users[row.uid] = {
        uid:          row.uid,
        name:         row.display || row.uid,
        balance:      Number(row.balance || 0),
        last_activity: lastActivity,
        is_live:      lastActivity !== null && (now - lastActivity) < LIVE_MS,
        joined_at:    '',
      };
    });
    res.json({ ok: true, users });
  } catch(e) {
    res.json({ ok: false, users: {}, msg: e.message });
  }
});

// ══ EXTRACT SMS ══
app.post('/extract-sms', (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.json({ refs: [], amount: 0 });

    const cleaned = text
      .replace(/(https?:\/\/\S+)\s*\n\s*(\/\S+)/g, '$1$2')
      .replace(/((?:DE|FT)[A-Z0-9]*)\n([A-Z0-9]+)/gi, '$1$2');

    const refs = [];
    const addRef = (r) => {
      r = r.toUpperCase().trim();
      if (r && !refs.includes(r)) refs.push(r);
    };

    for (const m of cleaned.matchAll(/\/([A-Z0-9]{8,20})-\d+/gi))
      addRef(m[1]);
    for (const m of cleaned.matchAll(/\/BranchReceipt\/([A-Z0-9]{8,20})[&\-]/gi))
      addRef(m[1]);
    for (const m of cleaned.matchAll(/[?&]id=([A-Z0-9]{8,24})/gi))
      addRef(m[1].slice(0, 14));
    for (const m of cleaned.matchAll(/Ref\s+No\s+(FT[A-Z0-9]{6,16})/gi))
      addRef(m[1]);
    for (const m of cleaned.matchAll(/bank\s+transaction\s+number\s+is\s+(FT[A-Z0-9]{6,16})/gi))
      addRef(m[1]);
    for (const m of cleaned.matchAll(/transaction\s+number\s+is\s+([A-Z]{2}[A-Z0-9]{6,14})/gi))
      addRef(m[1]);
    for (const m of cleaned.matchAll(/\/receipt\/([A-Z0-9]{8,16})/gi))
      addRef(m[1]);
    for (const m of cleaned.matchAll(/\b(FT[A-Z0-9]{6,16})\b/gi))
      addRef(m[1]);
    for (const m of cleaned.matchAll(/\b(DE[A-Z0-9]{6,14})\b/gi))
      addRef(m[1]);

    let amount = 0;
    const amtPatterns = [
      /credited\s+with\s+ETB\s+([\d,]+\.?\d*)/i,
      /has\s+been\s+credited\s+with\s+ETB\s+([\d,]+\.?\d*)/i,
      /received\s+ETB\s+([\d,]+\.?\d*)/i,
      /you\s+have\s+received\s+ETB\s+([\d,]+\.?\d*)/i,
      /transferred?\s+ETB\s+([\d,]+\.?\d*)/i,
      /ETB\s+([\d,]+\.?\d*)/i,
      /([\d,]+\.?\d*)\s*ብር/i,
    ];
    for (const pat of amtPatterns) {
      const m = cleaned.match(pat);
      if (m) {
        const val = parseFloat(m[1].replace(/,/g, '').replace(/\.$/, ''));
        if (val > 0) { amount = val; break; }
      }
    }

    const bankKeywords = [
      'from: 127', 'from: cbe',
      'ethio telecom',
      'credited with etb',
      'has been credited',
      'you have received etb',
      'received etb',
      'transferred etb',
      'transaction number is',
      'bank transaction number',
      'branchreceipt',
      'mbreciept.cbe',
      'apps.cbe.com.et',
      'ref no ft',
      'thank you for banking with cbe',
      'thank you for using telebirr',
    ];
    const lowerText = cleaned.toLowerCase();
    const is_bank = bankKeywords.some(k => lowerText.includes(k))
      || /\bFT[A-Z0-9]{6,16}\b/i.test(cleaned)
      || /\bDE[A-Z0-9]{6,14}\b/i.test(cleaned);

    console.log(`[extract-sms] refs=${JSON.stringify(refs)} amount=${amount} is_bank=${is_bank}`);

    res.json({ refs, amount, is_bank, cleaned: cleaned.slice(0, 300) });

  } catch (err) {
    console.error('[extract-sms] error:', err);
    res.status(500).json({ refs: [], amount: 0, error: err.message });
  }
});

app.post('/sms', express.text({type: '*/*'}), async (req, res) => {
  try {
    const smsText = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    console.log('📱 SMS received:', smsText.slice(0, 100));
    const body = JSON.stringify({ text: smsText });
    const options = {
      hostname: '127.0.0.1',
      port: 9000,
      path: '/sms',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const r2 = http.request(options, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res.json({ status: 'ok' }));
    });
    r2.on('error', (e) => {
      console.log('❌ Bot.py connection error:', e.message);
      res.json({ status: 'ok' });
    });
    r2.write(body);
    r2.end();
  } catch(e) {
    console.log('❌ SMS error:', e.message);
    res.json({ status: 'ok' });
  }
});

// ── Auto-release expired locks ──
setInterval(async () => {
  try {
    const LOCK_MS = 3 * 60 * 1000;
    const now = Date.now();

    const r = await pool.query(
      "SELECT value FROM game_state WHERE key='bot/withdrawals'"
    );
    const withdrawals = r.rows.length ? JSON.parse(r.rows[0].value) : {};

    let changed = false;
    for (const [key, wd] of Object.entries(withdrawals)) {
      if (wd.status !== 'accepted') continue;
      if (!wd.acceptedAt) continue;
      if (now - wd.acceptedAt > LOCK_MS) {
        withdrawals[key].status = 'pending';
        withdrawals[key].acceptedBy = null;
        withdrawals[key].acceptedAt = null;
        changed = true;
        console.log(`⏰ Auto-released: ${key}`);
      }
    }

    if (changed) {
      await setState('bot/withdrawals', withdrawals);
    }
  } catch(e) {
    console.error('❌ Auto-release error:', e.message);
  }
}, 30 * 1000);

// ══ DELETE USER ══
app.post('/delete-user', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.json({ ok: false, msg: 'uid missing' });
    const secret = req.body.secret;
    const config = await pool.query("SELECT value FROM game_state WHERE key='adminConfig'");
    const adminPass = JSON.parse(config.rows[0]?.value || '{}').loginPassword;
    if (!secret || secret !== adminPass) {
      return res.json({ ok: false, msg: 'Unauthorized' });
    }

    await pool.query('DELETE FROM users WHERE uid=$1', [uid]);

    const keys = [
      `users/${uid}`,
      `temp/${uid}`,
      `botstate_${uid}`,
      `tempwd_${uid}_amount`,
      `tempwd_${uid}_method`,
      `referrals/${uid}`,
      `displayNames/${uid}`,
    ];
    for (const k of keys) {
      await pool.query('DELETE FROM game_state WHERE key=$1', [k]);
      await pool.query('DELETE FROM game_state WHERE key LIKE $1', [k + '/%']);
    }

    await pool.query('DELETE FROM notifications WHERE uid=$1', [uid]);

    console.log(`🗑️ User deleted: ${uid}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('❌ delete-user error:', e.message);
    res.json({ ok: false, msg: e.message });
  }
});

// ══ AGENT HEARTBEAT ══
const agentStatus = {};

app.post('/agent-heartbeat', (req, res) => {
  const { agentId, status, activeRequests, lastSeen } = req.body;
  if (!agentId) return res.json({ ok: false, msg: 'agentId required' });

  agentStatus[agentId] = {
    status:         status || 'online',
    activeRequests: activeRequests || 0,
    lastSeen:       lastSeen || new Date().toISOString(),
    updatedAt:      Date.now()
  };

  clearTimeout(agentStatus[agentId]._timer);
  agentStatus[agentId]._timer = setTimeout(() => {
    if (agentStatus[agentId]) {
      agentStatus[agentId].status = 'offline';
    }
  }, 45000);

  broadcast({ type: 'agent_status_update', agents: sanitizeAgents() });
  res.json({ ok: true });
});

app.get('/agent-status', (req, res) => {
  res.json({ ok: true, agents: sanitizeAgents() });
});

function sanitizeAgents() {
  const result = {};
  for (const [id, data] of Object.entries(agentStatus)) {
    result[id] = {
      status:         data.status,
      activeRequests: data.activeRequests,
      lastSeen:       data.lastSeen,
      updatedAt:      data.updatedAt
    };
  }
  return result;
}

app.post('/open-bot', async (req, res) => {
  try {
    const { userId, type, amount } = req.body;
    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    const startParam = type === 'withdraw' ? `withdraw_${userId}` : `deposit_${amount}`;
    const msgText = type === 'withdraw' ? '🏧 ገንዘብ ማውጣት:' : `💰 ${amount} ብር ማስገባት:`;
    const btnText = type === 'withdraw' ? '🏧 ገንዘብ አውጣ' : '💳 ገንዘብ አስገባ';

    console.log('💳 open-bot called:', userId, type, amount);

    const bodyData = JSON.stringify({
      chat_id: userId,
      text: msgText,
      reply_markup: {
        inline_keyboard: [[
          { text: btnText, url: `https://t.me/Firstanywharebingobot?start=${startParam}` }
        ]]
      }
    });

    await new Promise((resolve) => {
      const opts = {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) }
      };
      const r2 = https.request(opts, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { console.log('📩 TG response:', d.slice(0,100)); resolve(); });
      });
      r2.on('error', resolve);
      r2.write(bodyData); r2.end();
    });

    res.json({ ok: true });
  } catch(e) {
    console.error('❌ open-bot error:', e.message);
    res.json({ ok: false, msg: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 Server running!'));
