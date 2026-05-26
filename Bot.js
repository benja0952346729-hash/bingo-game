const { Pool } = require('pg');
const express = require('express');
const app = express();
app.use(express.json());

// ══ POSTGRESQL CONFIG ══
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ══ DB HELPERS ══
async function getState(key) {
  try {
    const r = await pool.query('SELECT value FROM game_state WHERE key=$1', [key]);
    return r.rows.length ? JSON.parse(r.rows[0].value) : null;
  } catch (e) {
    log(`❌ getState(${key}) error: ${e.message}`);
    return null;
  }
}

async function setState(key, value) {
  try {
    await pool.query(
      'INSERT INTO game_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
      [key, JSON.stringify(value)]
    );
  } catch (e) {
    log(`❌ setState(${key}) error: ${e.message}`);
  }
}

async function upsertUser(uid, display, isBot, balance) {
  try {
    await pool.query(
      'INSERT INTO users(uid,display,is_bot,balance) VALUES($1,$2,$3,$4) ON CONFLICT(uid) DO UPDATE SET display=$2,is_bot=$3',
      [uid, display, isBot, balance]
    );
  } catch (e) {
    log(`❌ upsertUser error: ${e.message}`);
  }
}

// ══ NAME SYSTEM ══
const ethNames = [
  "Abebe","Kebede","Tadesse","Girma","Haile","Bekele","Tesfaye","Alemu","Demeke","Mulugeta",
  "Dawit","Yonas","Eyob","Nahom","Elias","Henok","Binyam","Samson","Yohannes","Amanuel",
  "Bereket","Fitsum","Ermias","Haben","Tekle","Meles","Yirgalem","Wondwossen","Abiy","Getnet",
  "Tomas","Ayele","Asefa","Sisay","Fekadu","Desalegn","Tilahun","Getachew","Tamiru","Negash",
  "Asfaw","Worku","Mekonnen","Seyoum","Zeleke","Andargachew","Mengistu","Kifle","Habtamu","Kefyalew",
  "Mehari","Temesgen","Mekonen","Gebremichael","Tesfamichael","Weldemichael","Hailegebriel","Girmay","Hagos","Berhane",
  "Kibrom","Mekdes","Tsehay","Yodit","Hiwot","Tigist","Meron","Selamawit","Bethel","Rahel",
  "Selam","Hanna","Firehiwot","Lidya","Rediet","Nardos","Sosina","Aster","Eden","Sara",
  "Liya","Beti","Feven","Tsion","Misgana","Yeshi","Almaz","Azeb","Nigist","Zinash",
  "Kalid","Hussein","Abdi","Omar","Suleiman","Jemal","Hamid","Yusuf","Ahmed","Mustafa",
  "Abdulaziz","Nasir","Idris","Bilal","Anwar","Jamal","Kadir","Aman","Bashir","Farid",
  "Lemi","Daba","Geda","Chala","Feyisa","Diriba","Gemechu","Tolosa","Negasa","Regasa",
  "Bikila","Dereje","Wubie","Shimelis","Mulatu","Gashaw","Belayneh","Tsegaye","Adane","Amare",
  "Natnael","Robel","Kaleab","Yabsra","Kidus","Abel","Mikael","Raphael","Gabriel","Daniel",
  "Leul","Andom","Teame","Goitom","Abreham","Biniam","Berhe","Tesfamariam","Woldu","Adhanom",
  "Sindu","Netsanet","Meklit","Melkam","Abebech","Worknesh","Meseret","Mahlet","Bezawit","Kokeb",
  "Tsega","Genet","Emebet","Tadelech","Woinshet","Yenealem","Birhan","Saba","Roza",
  "Miriam","Lulit","Bruck","Sirak","Yordanos","Kidan","Semhar","Freweini","Senait","Miruts",
  "Tesfay","Gebru","Hadush","Aregawi","Guesh","Tewolde","Abraha","Neguse","Zewdu","Tadele",
  "Muluneh","Aklilu","Fantahun","Endale","Belay","Meaza","Tigabu","Yalew","Zemen","Kebrom"
];

const amNames = [
  "አበበ","ከበደ","ሰላም","ሚካኤል","ማርታ","ሄለን","ዮናስ","ሶፊያ","ናርዶስ","ሃና",
  "ልዩ","አስቴር","ቤቴል","ሜሮን","ሰብለ","ፍቅር","ሩት","ሃይማኖት","ዘካሪያስ","ታደሰ",
  "ብርሃኔ","ሙሉወርቅ","ትዕግስት","አዳነ","ፍሬህይወት","ሃይሌ","ቃልኪዳን","ፀሃይ","ዮርዳኖስ","ቅድስት",
  "ናትናኤል","ዘሪቱ","ስምረት","ምህረት","ሃብቴ","ፍሬሰብ","ዓለምሰገድ","ክብሮም","ሃይለሚካኤል","ጸጋዬ",
  "ሙሉቀን","ወርቅነሽ","አሸናፊ","ዮሴፍ","ሃይካል","ቢኒያም","ሰሎሞን","ዮሐንስ","ጌታቸው","ያሬድ"
];

const tgNames = [
  "king.abel","ethio.star","bingo.master","lucky777","fastwin",
  "darkpro","alphauser","betagamer","proplay","luckyeth",
  "ethboss","tgking","nightwolf","fireplay","topwinner",
  "bingoeth","flashboy","cryptowin","megapro","soloking",
  "ghostplay","silentwolf","fasteth","darkangel","starpro",
  "winfast","ethlion","addisguy","megawin","topeth",
  "luckystar","hyenapro","nightpro","ethchamp","bingostar",
  "cashking","rapidwin","darkstar","speedpro","ethwinner",
  "thunderboy","stormpro","eaglewin","flashpro","lioneth",
  "wolfking","ninjapro","shadowwin","turboeth","blazepro"
];

function getRandomName() {
  const r = Math.random();
  if (r < 0.67) return ethNames[Math.floor(Math.random() * ethNames.length)];
  else if (r < 0.84) return amNames[Math.floor(Math.random() * amNames.length)];
  else return tgNames[Math.floor(Math.random() * tgNames.length)];
}

// ══ LOGGING ══
function log(msg) {
  const now = new Date().toLocaleTimeString('en-ET');
  console.log(`[${now}] 🤖 ${msg}`);
}

// ══ STATE ══
let smartBotEnabled = false;
let botEngineRunning = false;
let botEngineTimer = null;
let lastBotAddedTime = 0;
let currentCdMinutes = 3;
let prevRealCount = 0;

// ══ REAL PLAYER RATE TRACKER ══
const realPlayerHistory = [];

function updateRealPlayerHistory(realCount) {
  const now = Date.now();
  realPlayerHistory.push({ count: realCount, time: now });
  while (realPlayerHistory.length > 0 && now - realPlayerHistory[0].time > 30000) {
    realPlayerHistory.shift();
  }
}

function getRealPlayerRate() {
  const now = Date.now();
  const window = 10000;
  const recent = realPlayerHistory.filter(h => now - h.time <= window);
  if (recent.length < 2) return 0;
  const oldest = recent[0];
  const newest = recent[recent.length - 1];
  const countDiff = Math.max(0, newest.count - oldest.count);
  const timeDiff = (newest.time - oldest.time) / 1000;
  if (timeDiff < 0.5) return 0;
  return countDiff / timeDiff;
}

// ══ TIME-OF-DAY MULTIPLIER ══
function getEthiopianHour() {
  const now = new Date();
  let ethHours = (now.getUTCHours() + 3) - 6;
  if (ethHours < 0) ethHours += 24;
  return ethHours + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
}

function getTimeMultiplier() {
  const ethHour = getEthiopianHour();
  if (ethHour >= 18.5) return null;
  if (ethHour < 4.833) {
    const progress = ethHour / 4.833;
    return 4.0 - (progress * 3.0);
  }
  if (ethHour < 16.75) return 1.0;
  const progress = (ethHour - 16.75) / (18.5 - 16.75);
  return 1.0 + (progress * 3.0);
}

// ══ CARD COUNT DISTRIBUTION ══
function getCardCount(availableCount) {
  if (availableCount <= 0) return 0;
  const r = Math.random();
  let cardCount;
  if (r < 0.50) cardCount = 1;
  else if (r < 0.77) cardCount = 2;
  else if (r < 0.92) cardCount = 3;
  else cardCount = 4;
  return Math.min(cardCount, availableCount);
}

// ══════════════════════════════════════════
// ══ ENDPOINTS ══
// ══════════════════════════════════════════

// GET /admin/bot-fill — አሁን ያለውን fill አሳያል
app.get('/admin/bot-fill', async (req, res) => {
  try {
    const fill = await getState('game/botFill') ?? 50;
    const speedMultiplier = fill / 50;
    res.json({ ok: true, fill, speedMultiplier: speedMultiplier.toFixed(2) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /admin/bot-fill — speed fill ይቀይራል
// body: { fill: 1-100 }
// 50  = baseline (normal speed)
// 1   = እጅግ በጣም ቀርፋፋ  (×0.02)
// 100 = እጅግ በጣም ፈጣን   (×2.00)
app.post('/admin/bot-fill', async (req, res) => {
  try {
    const fill = Math.max(1, Math.min(100, Number(req.body.fill)));
    if (isNaN(fill)) return res.json({ ok: false, error: 'Invalid value. Use 1-100.' });
    await setState('game/botFill', fill);
    const speedMultiplier = fill / 50;
    log(`Admin set botFill → ${fill} (speed ×${speedMultiplier.toFixed(2)})`);
    res.json({ ok: true, fill, speedMultiplier: speedMultiplier.toFixed(2) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ══ SERVER START ══
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => log(`🌐 Admin API running on port ${PORT}`));

// ══ POLL: smartBot/enabled (every 3s) ══
async function pollSmartBotEnabled() {
  try {
    const val = await getState('smartBot/enabled');
    if (val === true && !smartBotEnabled) {
      smartBotEnabled = true;
      log('Smart Bot ENABLED by admin');
      startBotEngine();
    } else if (!val && smartBotEnabled) {
      smartBotEnabled = false;
      log('Smart Bot DISABLED by admin');
      stopBotEngine();
    }
  } catch (e) {
    log(`❌ pollSmartBotEnabled error: ${e.message}`);
  }
}
setInterval(pollSmartBotEnabled, 3000);

// ══ POLL: real player count (every 5s) ══
async function pollRealPlayers() {
  try {
    const confData = (await getState('game/confirmedNumbers')) || {};
    const allUids = Object.values(confData);
    if (!allUids.length) { prevRealCount = 0; return; }

    const botRes = await pool.query('SELECT uid FROM users WHERE is_bot=true');
    const botIds = new Set(botRes.rows.map(r => String(r.uid)));

    const realCount = allUids.filter(uid => !botIds.has(String(uid))).length;

    if (realCount > prevRealCount) {
      log(`Real player joined! Total real: ${realCount}`);
    }

    updateRealPlayerHistory(realCount);
    prevRealCount = realCount;
  } catch (e) {
    log(`❌ pollRealPlayers error: ${e.message}`);
  }
}
setInterval(pollRealPlayers, 5000);

// ══ BOT ENGINE ══
function startBotEngine() {
  if (botEngineRunning) return;
  botEngineRunning = true;
  lastBotAddedTime = 0;
  log('Bot engine started');
  botEngineTimer = setInterval(botEngineTick, 1000);
}

function stopBotEngine() {
  if (botEngineTimer) {
    clearInterval(botEngineTimer);
    botEngineTimer = null;
  }
  botEngineRunning = false;
  log('Bot engine stopped');
}

async function botEngineTick() {
  if (!smartBotEnabled) { stopBotEngine(); return; }

  try {
    const timeMultiplier = getTimeMultiplier();
    if (timeMultiplier === null) {
      await setState('smartBot/status', 'DEAD_ZONE');
      return;
    }

    const [confData, bet, pctRaw, statusData, cdData, botFillRaw] = await Promise.all([
      getState('game/confirmedNumbers'),
      getState('game/bet'),
      getState('game/percent'),
      getState('game/status'),
      getState('game/countdown'),
      getState('game/botFill'),
    ]);

    const conf = confData || {};
    const betVal = bet || 0;
    const pct = (pctRaw || 80) / 100;
    const status = statusData || {};
    const cd = cdData || {};

    // ══════════════════════════════════════════
    // ══ SPEED MULTIPLIER ══
    //
    // Range: 1 - 100  |  Baseline: 50
    //
    //   fill=1   → ×0.02  → እጅግ በጣም ቀርፋፋ
    //   fill=25  → ×0.50  → ዝግ
    //   fill=50  → ×1.00  → ኖርማል (baseline)
    //   fill=75  → ×1.50  → ፈጣን
    //   fill=100 → ×2.00  → እጅግ በጣም ፈጣን
    // ══════════════════════════════════════════
    const fillVal = Math.max(1, Math.min(100, Number(botFillRaw) ?? 50));
    const speedMultiplier = fillVal / 50;

    // ── Game live check ──
    if (status.started) {
      await setState('smartBot/status', 'GAME_LIVE');
      return;
    }

    // ── Countdown active check ──
    if (!cd.active || !cd.startAt) {
      await setState('smartBot/status', 'WAITING');
      return;
    }

    // ── Countdown ሲያልቅ bot ይቆማል ──
    const now = Date.now();
    const remainMs = Math.max(0, cd.startAt - now);
    const remainSecs = remainMs / 1000;

    if (remainSecs <= 0) {
      await setState('smartBot/status', 'COUNTDOWN_ENDED');
      return;
    }

    const botRes = await pool.query('SELECT uid FROM users WHERE is_bot=true');
    const botIds = new Set(botRes.rows.map(r => String(r.uid)));

    const allEntries = Object.values(conf);
    let realPlayers = 0;
    allEntries.forEach(uid => { if (!botIds.has(String(uid))) realPlayers++; });

    const totalSecs = (cd.cdMinutes || cd.mins || currentCdMinutes) * 60;
    const elapsedSecs = Math.max(1, totalSecs - remainSecs);

    if (elapsedSecs < 5) {
      await setState('smartBot/status', 'WAITING_5S');
      return;
    }

    // ══════════════════════════════════════════
    // ══ CORE SPEED LOGIC ══
    //
    // Real players ፍጥነት inverse:
    //   realRate ↑ → gapMs ↑ (bot ዝግ)
    //   realRate ↓ → gapMs ↓ (bot ፈጣን)
    //
    // Formula:
    //   gapMs = BASE_GAP × (1 + realRate² × SENSITIVITY)
    //         ÷ speedMultiplier
    //         × timeMultiplier
    //         ± 15% random
    // ══════════════════════════════════════════

    const realRate = getRealPlayerRate();

    const BASE_GAP = 1500;
    const SENSITIVITY = 18.0;

    let gapMs = BASE_GAP * (1 + Math.pow(realRate, 2) * SENSITIVITY);

    // Speed multiplier (fill 1-100, baseline 50)
    gapMs = gapMs / speedMultiplier;

    // Time of day multiplier
    gapMs = gapMs * timeMultiplier;

    // ±15% random variation
    const variation = gapMs * 0.15;
    gapMs = gapMs + (Math.random() * variation * 2 - variation);

    // Clamp: min 150ms, max 12000ms
    gapMs = Math.max(150, Math.min(12000, gapMs));

    await setState('smartBot/status',
      `ACTIVE|fill:${fillVal}(×${speedMultiplier.toFixed(2)})|realRate:${realRate.toFixed(3)}/s|gap:${Math.round(gapMs)}ms|tMult:×${timeMultiplier.toFixed(2)}|remain:${Math.round(remainSecs)}s|real:${realPlayers}`
    );

    log(`📊 fill:${fillVal}(×${speedMultiplier.toFixed(2)}) | realRate:${realRate.toFixed(3)}/s | gap:${Math.round(gapMs)}ms | ×${timeMultiplier.toFixed(2)} | ${Math.round(remainSecs)}s | real:${realPlayers}`);

    if (now - lastBotAddedTime >= gapMs) {
      await addOneBot(conf, botIds, betVal, pct);
    }

  } catch (err) {
    log(`❌ Engine error: ${err.message}`);
  }
}

// ══ ADD ONE BOT ══
async function addOneBot(confData, botIds, bet, pct) {
  const taken = new Set(Object.keys(confData).map(Number));
  const avail = [];
  for (let i = 1; i <= 100; i++) {
    if (!taken.has(i)) avail.push(i);
  }
  if (!avail.length) return;

  const cardCount = getCardCount(avail.length);
  if (cardCount === 0) return;

  const botName = getRandomName();
  const fakeBotId = String(7000000000 + Math.floor(Math.random() * 999999999));
  const shuffled = avail.sort(() => Math.random() - 0.5);
  const selectedCards = shuffled.slice(0, cardCount);

  await upsertUser(fakeBotId, botName, true, 0);

  const currentConf = (await getState('game/confirmedNumbers')) || {};
  for (const cardId of selectedCards) {
    currentConf[cardId] = fakeBotId;
  }
  await setState('game/confirmedNumbers', currentConf);

  const newTotal = Object.keys(currentConf).length;
  if (bet > 0) {
    await setState('game/prize', Math.floor(bet * newTotal * pct));
    await setState('game/total', bet * newTotal);
  }

  lastBotAddedTime = Date.now();

  await setState('smartBot/lastAdded', {
    name: botName,
    cardId: selectedCards.join(','),
    cards: cardCount,
    time: Date.now(),
  });

  log(`✅ Bot: ${botName} → Card #${selectedCards.join(',')} (${cardCount} cards)`);
}

// ══ STARTUP ══
log('🚀 Smart Bot v8.0 running');
log('📌 GET  /admin/bot-fill  → አሁን ያለውን fill አሳያል');
log('📌 POST /admin/bot-fill  → { fill: 1-100 } speed ይቀይራል');
log('   1   = እጅግ በጣም ቀርፋፋ (×0.02)');
log('   50  = ኖርማል baseline  (×1.00)');
log('   100 = እጅግ በጣም ፈጣን  (×2.00)');
// ══ SELF-PING (keep-alive) ══
const SERVICE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

function keepAlive() {
  fetch(`${SERVICE_URL}/health`)
    .then(() => log('💓 Keep-alive ping sent'))
    .catch(e => log(`⚠️ Keep-alive failed: ${e.message}`));
}

setInterval(keepAlive, 10 * 60 * 1000); // Every 10 min
pollSmartBotEnabled();
