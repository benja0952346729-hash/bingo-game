const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const AMHARIC_NUMBERS = {
  1:'አንድ',2:'ሁለት',3:'ሶስት',4:'አራት',5:'አምስት',
  6:'ስድስት',7:'ሰባት',8:'ስምንት',9:'ዘጠኝ',10:'አስር',
  11:'አስራ አንድ',12:'አስራ ሁለት',13:'አስራ ሶስት',14:'አስራ አራት',15:'አስራ አምስት',
  16:'አስራ ስድስት',17:'አስራ ሰባት',18:'አስራ ስምንት',19:'አስራ ዘጠኝ',20:'ሃያ',
  21:'ሃያ አንድ',22:'ሃያ ሁለት',23:'ሃያ ሶስት',24:'ሃያ አራት',25:'ሃያ አምስት',
  26:'ሃያ ስድስት',27:'ሃያ ሰባት',28:'ሃያ ስምንት',29:'ሃያ ዘጠኝ',30:'ሰላሳ',
  31:'ሰላሳ አንድ',32:'ሰላሳ ሁለት',33:'ሰላሳ ሶስት',34:'ሰላሳ አራት',35:'ሰላሳ አምስት',
  36:'ሰላሳ ስድስት',37:'ሰላሳ ሰባት',38:'ሰላሳ ስምንት',39:'ሰላሳ ዘጠኝ',40:'አርባ',
  41:'አርባ አንድ',42:'አርባ ሁለት',43:'አርባ ሶስት',44:'አርባ አራት',45:'አርባ አምስት',
  46:'አርባ ስድስት',47:'አርባ ሰባት',48:'አርባ ስምንት',49:'አርባ ዘጠኝ',50:'ሃምሳ',
  51:'ሃምሳ አንድ',52:'ሃምሳ ሁለት',53:'ሃምሳ ሶስት',54:'ሃምሳ አራት',55:'ሃምሳ አምስት',
  56:'ሃምሳ ስድስት',57:'ሃምሳ ሰባት',58:'ሃምሳ ስምንት',59:'ሃምሳ ዘጠኝ',60:'ስልሳ',
  61:'ስልሳ አንድ',62:'ስልሳ ሁለት',63:'ስልሳ ሶስት',64:'ስልሳ አራት',65:'ስልሳ አምስት',
  66:'ስልሳ ስድስት',67:'ስልሳ ሰባት',68:'ስልሳ ስምንት',69:'ስልሳ ዘጠኝ',70:'ሰባ',
  71:'ሰባ አንድ',72:'ሰባ ሁለት',73:'ሰባ ሶስት',74:'ሰባ አራት',75:'ሰባ አምስት'
};

function getBingoLetter(n) {
  if (n <= 15) return 'ቢ';
  if (n <= 30) return 'አይ';
  if (n <= 45) return 'ኤን';
  if (n <= 60) return 'ጂ';
  return 'ኦ';
}

const ttsCache = {};

async function fetchTTS(text) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(text);
    const options = {
      hostname: 'translate.google.com',
      path: `/translate_tts?ie=UTF-8&q=${encoded}&tl=am&client=tw-ob`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = https.get(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = new URL(res.headers.location);
        https.get({
          hostname: redirectUrl.hostname,
          path: redirectUrl.pathname + redirectUrl.search,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (res2) => {
          const chunks = [];
          res2.on('data', chunk => chunks.push(chunk));
          res2.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (buffer.length < 100) reject(new Error('Empty response'));
            else resolve({ buffer, type: 'audio/mpeg' });
          });
          res2.on('error', reject);
        }).on('error', reject);
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 100) reject(new Error('Empty response'));
        else resolve({ buffer, type: 'audio/mpeg' });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

app.get('/tts/number/:n', async (req, res) => {
  const n = parseInt(req.params.n);
  if (isNaN(n) || n < 1 || n > 75)
    return res.status(400).json({ error: 'Invalid number' });

  const key = 'num_' + n;
  if (ttsCache[key]) {
    res.set('Content-Type', 'audio/mpeg');
    return res.send(ttsCache[key]);
  }

  try {
    const text = `${getBingoLetter(n)} ${AMHARIC_NUMBERS[n]}`;
    console.log(`TTS: ${text}`);
    const { buffer } = await fetchTTS(text);
    ttsCache[key] = buffer;
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (e) {
    console.error('TTS error:', e.message);
    res.status(500).json({ error: 'TTS failed' });
  }
});

app.get('/tts/winner', async (req, res) => {
  if (ttsCache['winner']) {
    res.set('Content-Type', 'audio/mpeg');
    return res.send(ttsCache['winner']);
  }
  try {
    const { buffer } = await fetchTTS('ቢንጎ አሸናፊ ተገኘ');
    ttsCache['winner'] = buffer;
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: 'TTS failed' });
  }
});
app.get('/tts/winner-announce', async (req, res) => {
  if(ttsCache['winner_announce']) {
    res.set('Content-Type', 'audio/mpeg');
    return res.send(ttsCache['winner_announce']);
  }
  try {
    const { buffer } = await fetchTTS('ቢንጎ አሸናፊ ተገኝቷል');
    ttsCache['winner_announce'] = buffer;
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch(e) { res.status(500).json({ error: 'TTS failed' }); }
});

app.get('/tts/bingo', async (req, res) => {
  if(ttsCache['bingo']) {
    res.set('Content-Type', 'audio/mpeg');
    return res.send(ttsCache['bingo']);
  }
  try {
    const { buffer } = await fetchTTS('ቢንጎ');
    ttsCache['bingo'] = buffer;
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch(e) { res.status(500).json({ error: 'TTS failed' }); }
});

app.get('/tts/warmup', async (req, res) => {
  res.json({ ok: true });
  for (let n = 1; n <= 75; n++) {
    const key = 'num_' + n;
    if (ttsCache[key]) continue;
    try {
      const text = `${getBingoLetter(n)} ${AMHARIC_NUMBERS[n]}`;
      const { buffer } = await fetchTTS(text);
      ttsCache[key] = buffer;
      console.log(`Warmup: ${n}/75`);
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`Warmup failed: ${n}`);
    }
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cached: Object.keys(ttsCache).length
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🎙️ TTS ready`);
});
