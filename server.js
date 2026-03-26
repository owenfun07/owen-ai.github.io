const express = require("express");
const dotenv = require("dotenv");
const fetch = require("node-fetch");

dotenv.config(); // load GEMINI_API_KEY

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const GEMINI_MODEL_URL_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "";
const SYSTEM_INSTRUCTION = [
  "You are Owen.Ai.",
  "Personality: friendly, playful, funny, and always genuinely helpful.",
  "Identity knowledge: You live on the game website Owen.fun.",
  "Behavior: you enjoy helping people in whatever way you can.",
  "Response quality: keep responses clear, complete, and avoid cutting thoughts off mid-sentence."
].join(" ");

let memory = [];
const MAX_MEMORY_MESSAGES = 10;

function buildGeminiUrl() {
  return `${GEMINI_MODEL_URL_BASE}/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY || "")}`;
}

function extractModelText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map(part => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function extractModelIssue(json) {
  const apiErrorMessage = json?.error?.message;
  if (apiErrorMessage) return apiErrorMessage;

  const blockReason = json?.promptFeedback?.blockReason;
  if (blockReason) return `Request blocked by Gemini safety filter (${blockReason}).`;

  const finishReason = json?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    return `Gemini finished with reason: ${finishReason}.`;
  }

  return "Gemini returned no text content.";
}

function isQuotaExceeded(statusCode, rawText, json) {
  if (statusCode === 429) return true;
  const reason = json?.error?.status || "";
  const message = json?.error?.message || rawText || "";
  const combined = `${reason} ${message}`.toLowerCase();
  return combined.includes("resource_exhausted")
    || combined.includes("quota")
    || combined.includes("daily limit")
    || combined.includes("rate limit");
}

function summarizeGeminiResponse(json) {
  return {
    model: GEMINI_MODEL,
    hasCandidates: Array.isArray(json?.candidates),
    candidateCount: Array.isArray(json?.candidates) ? json.candidates.length : 0,
    firstFinishReason: json?.candidates?.[0]?.finishReason || null,
    firstSafetyRatings: json?.candidates?.[0]?.safetyRatings || [],
    blockReason: json?.promptFeedback?.blockReason || null,
    promptFeedback: json?.promptFeedback || {}
  };
}

async function callAuthService(action, username, password) {
  if (!AUTH_SERVICE_URL) {
    throw new Error("AUTH_SERVICE_URL is not configured.");
  }

  const response = await fetch(AUTH_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, username, password })
  });

  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    json = { ok: false, message: "Auth service returned invalid JSON." };
  }

  if (!response.ok) {
    return { ok: false, message: json?.message || `Auth service failed (${response.status}).` };
  }

  return { ok: Boolean(json?.ok), message: json?.message || "", user: json?.user || null };
}

app.post("/auth/login", async (req, res) => {
  try {
    const username = req.body?.username?.trim();
    const password = req.body?.password;

    if (!username || !password) {
      return res.status(400).json({ ok: false, message: "Username and password are required." });
    }

    const result = await callAuthService("login", username, password);
    if (!result.ok) {
      return res.status(401).json({ ok: false, message: result.message || "Invalid credentials." });
    }

    return res.json({ ok: true, user: { username: result.user?.username || username } });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || "Login failed." });
  }
});

app.post("/auth/signup", async (req, res) => {
  try {
    const username = req.body?.username?.trim();
    const password = req.body?.password;

    if (!username || !password) {
      return res.status(400).json({ ok: false, message: "Username and password are required." });
    }

    if (password.length < 6) {
      return res.status(400).json({ ok: false, message: "Password must be at least 6 characters." });
    }

    const result = await callAuthService("signup", username, password);
    if (!result.ok) {
      return res.status(400).json({ ok: false, message: result.message || "Signup failed." });
    }

    return res.json({ ok: true, user: { username: result.user?.username || username } });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || "Signup failed." });
  }
});

app.post("/chat", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ reply: "Server is missing GEMINI_API_KEY." });
    }

    const userMessage = req.body?.message?.trim();
    if (!userMessage) {
      return res.status(400).json({ reply: "Please send a non-empty message." });
    }

    const contents = [];
    memory.forEach(m => contents.push({ role: m.role, parts: [{ text: m.text }] }));
    contents.push({ role: "user", parts: [{ text: userMessage }] });

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 700 }
    };

    const response = await fetch(buildGeminiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini API error:", response.status, errorText);
      let errorJson = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch (error) {
        // Non-JSON error; fall back to generic provider error.
      }
      if (isQuotaExceeded(response.status, errorText, errorJson)) {
        return res.status(429).json({
          reply: "I hit my free daily API limit. Please try again tomorrow (or later if the quota resets sooner)."
        });
      }
      return res.status(502).json({ reply: "AI provider error. Please try again shortly." });
    }

    const json = await response.json();
    const aiText = extractModelText(json);
    if (!aiText) {
      const issue = extractModelIssue(json);
      console.error("Gemini empty response:", issue, JSON.stringify(json).slice(0, 800));
      return res.status(502).json({ reply: `I couldn't generate text. ${issue}` });
    }

    memory.push({ role: "user", text: userMessage });
    memory.push({ role: "model", text: aiText });
    memory = memory.slice(-MAX_MEMORY_MESSAGES);

    res.json({ reply: aiText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Hmm… network or API error. Try again?" });
  }
});

// Temporary test route to check Gemini API key
app.get("/test-gemini", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).send("Missing GEMINI_API_KEY in environment.");
    }

    const payload = {
      systemInstruction: { parts: [{ text: "You are a test AI." }] },
      contents: [
        { role: "user", parts: [{ text: "Say hello in a single sentence." }] }
      ],
      generationConfig: { maxOutputTokens: 50 }
    };

    const response = await fetch(buildGeminiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch (error) {
        // Non-JSON error; fall back to generic provider error.
      }
      if (isQuotaExceeded(response.status, errorText, errorJson)) {
        return res.status(429).send(
          "Gemini test failed: free-tier quota exceeded. Please wait for quota reset or use a different key."
        );
      }
      return res
        .status(502)
        .send(`Gemini test failed with status ${response.status}: ${errorText}`);
    }

    const json = await response.json();
    const aiText = extractModelText(json);
    if (!aiText) {
      const issue = extractModelIssue(json);
      return res.status(502).send(`Gemini test failed: ${issue}`);
    }

    res.send(`Gemini test success: "${aiText}" (model: ${GEMINI_MODEL})`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`Gemini test failed: ${err.message}`);
  }
});

app.get("/debug-gemini", async (req, res) => {
  if (process.env.ENABLE_GEMINI_DEBUG !== "true") {
    return res.status(404).send("Not found");
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY in environment." });
    }

    const payload = {
      systemInstruction: { parts: [{ text: "You are a debug assistant. Reply with one short sentence." }] },
      contents: [{ role: "user", parts: [{ text: "Say hello and include the word DEBUG." }] }],
      generationConfig: { maxOutputTokens: 60 }
    };

    const response = await fetch(buildGeminiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const bodyText = await response.text();
    let json = null;
    try {
      json = JSON.parse(bodyText);
    } catch (error) {
      // Keep null json; this route is specifically for debugging malformed upstream responses.
    }

    return res.status(response.ok ? 200 : 502).json({
      ok: response.ok,
      status: response.status,
      model: GEMINI_MODEL,
      extractedText: json ? extractModelText(json) : "",
      issue: json ? extractModelIssue(json) : "Non-JSON response from Gemini",
      summary: json ? summarizeGeminiResponse(json) : null,
      rawPreview: bodyText.slice(0, 2000)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
