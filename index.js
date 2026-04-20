require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: "https://house-rent-app-3674a-default-rtdb.firebaseio.com/"
});

const db = admin.database();

/* START */
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
