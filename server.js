const express = require("express");
const dotenv = require("dotenv");

dotenv.config(); // load GEMINI_API_KEY

const app = express();
app.use(express.json());
app.use(express.static("public"));

const MODEL_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

let memory = [];
const MAX_MEMORY_MESSAGES = 10;

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    const contents = [
      { role: "system", parts: [{ text: "You are Owen.Ai. Friendly, playful, helpful." }] }
    ];
    memory.forEach(m => contents.push({ role: m.role, parts: [{ text: m.text }] }));
    contents.push({ role: "user", parts: [{ text: userMessage }] });

    const payload = { contents, generationConfig: { temperature: 0.8, maxOutputTokens: 250 } };

    const response = await fetch(MODEL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GEMINI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const json = await response.json();
    const aiText = json?.candidates?.[0]?.content?.parts?.[0]?.text || "Hmm… my brain glitched. Try again?";

    memory.push({ role: "user", text: userMessage });
    memory.push({ role: "model", text: aiText });
    memory = memory.slice(-MAX_MEMORY_MESSAGES);

    res.json({ reply: aiText });
  } catch (err) {
    console.error(err);
    res.json({ reply: "Hmm… network or API error. Try again?" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
