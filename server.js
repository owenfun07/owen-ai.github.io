const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const MODEL_URL =
"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

let memory = [];

const MAX_MEMORY_MESSAGES = 10;

app.post("/chat", async (req, res) => {

  const userMessage = req.body.message;

  const contents = [
    {
      role: "system",
      parts: [{ text: `
You are Owen.Ai.

You live on a fun playful website called Owen.Fun.

Your personality:
Friendly
Casual
Playful
Helpful
Never robotic.
`}]
    }
  ];

  memory.forEach(m => {
    contents.push({
      role: m.role,
      parts: [{ text: m.text }]
    });
  });

  contents.push({
    role: "user",
    parts: [{ text: userMessage }]
  });

  const response = await fetch(MODEL_URL + "?key=" + process.env.GEMINI_API_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: contents,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 250
      }
    })
  });

  const json = await response.json();

  const aiText =
    json?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "Hmm… my brain glitched. Try again.";

  memory.push({ role: "user", text: userMessage });
  memory.push({ role: "model", text: aiText });

  memory = memory.slice(-MAX_MEMORY_MESSAGES);

  res.json({ reply: aiText });

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
