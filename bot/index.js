const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// Firebase KEY
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// test
app.get("/", (req, res) => {
  res.send("🔥 Bot server working!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started");
});
