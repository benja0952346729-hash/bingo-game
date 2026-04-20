require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

// 🔐 ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN = process.env.ADMIN_ID;

// 🤖 Telegram Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// 🔥 Firebase (FROM .env JSON)
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: "https://house-rent-app-3674a-default-rtdb.firebaseio.com/"
});

const db = admin.database();

/* =========================
   START
========================= */
bot.onText(/\/start/, (msg) => {

  bot.sendMessage(msg.chat.id, "🎁 Package ምረጥ", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "50 ብር", callback_data: "pkg_50" }],
        [{ text: "100 ብር", callback_data: "pkg_100" }],
        [{ text: "200 ብር", callback_data: "pkg_200" }]
      ]
    }
  });

});

/* =========================
   PACKAGE SELECT
========================= */
bot.on("callback_query", async (q) => {

  try {
    let amount = q.data.split("_")[1];
    let user = q.from.id.toString();
    let id = Date.now().toString();

    await db.ref("payments/" + id).set({
      user,
      amount: Number(amount),
      status: "waiting_proof",
      time: Date.now()
    });

    bot.sendMessage(q.message.chat.id,
`💰 ${amount} ብር

📲 Telebirr: 09XXXXXXXX
🏦 CBE: 1000XXXXXXXX

📤 screenshot ላክ`
    );

  } catch (err) {
    console.log(err);
  }

});

/* =========================
   PHOTO (SCREENSHOT)
========================= */
bot.on("photo", async (msg) => {

  try {
    let user = msg.from.id.toString();

    let fileId = msg.photo[msg.photo.length - 1].file_id;
    let file = await bot.getFileLink(fileId);

    let snap = await db.ref("payments")
      .orderByChild("user")
      .equalTo(user)
      .once("value");

    let data = snap.val();
    if (!data) return;

    let lastKey = Object.keys(data).pop();

    await db.ref("payments/" + lastKey).update({
      photo: file,
      status: "pending"
    });

    bot.sendMessage(ADMIN,
`📥 New Payment

👤 User: ${user}
💰 Amount: ${data[lastKey].amount}
🆔 ID: ${lastKey}

Approve:
/approve ${lastKey}

Reject:
/reject ${lastKey}`
    );

    bot.sendMessage(msg.chat.id, "⏳ በመጠበቅ ላይ...");

  } catch (err) {
    console.log(err);
  }

});

/* =========================
   APPROVE
========================= */
bot.onText(/\/approve (.+)/, async (msg, match) => {

  try {
    if (msg.from.id.toString() !== ADMIN) return;

    let id = match[1];

    let ref = db.ref("payments/" + id);
    let snap = await ref.once("value");
    let data = snap.val();

    if (!data) return;

    let userRef = db.ref("users/" + data.user + "/balance");

    let userSnap = await userRef.once("value");
    let current = userSnap.val() || 0;

    await userRef.set(current + data.amount);

    await ref.update({ status: "approved" });

    bot.sendMessage(data.user, "✅ ብር ገብቷል!");

  } catch (err) {
    console.log(err);
  }

});

/* =========================
   REJECT
========================= */
bot.onText(/\/reject (.+)/, async (msg, match) => {

  try {
    if (msg.from.id.toString() !== ADMIN) return;

    let id = match[1];

    await db.ref("payments/" + id).update({
      status: "rejected"
    });

  } catch (err) {
    console.log(err);
  }

});

/* =========================
   ERROR HANDLING
========================= */
bot.on("polling_error", (err) => console.log(err));

console.log("🤖 Bot is running...");
