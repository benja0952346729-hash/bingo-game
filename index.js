const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

/*
🔥 FIREBASE SETUP
*/
let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
  console.error("❌ FIREBASE_KEY invalid");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/*
🏠 TEST ROUTE
*/
app.get("/", (req, res) => {
  res.send("🔥 House Rent API working!");
});

/*
🏠 ADD HOUSE (POST)
*/
app.post("/add-house", async (req, res) => {
  try {
    const { title, price, location } = req.body;

    if (!title || !price || !location) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const doc = await db.collection("houses").add({
      title,
      price,
      location,
      createdAt: new Date(),
    });

    res.json({
      message: "✅ House added",
      id: doc.id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
🏠 GET ALL HOUSES
*/
app.get("/houses", async (req, res) => {
  try {
    const snapshot = await db.collection("houses").get();

    const houses = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(houses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
🚀 START SERVER
*/
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
