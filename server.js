const express = require("express");
const dotenv = require("dotenv");
const fetch = require("node-fetch");

dotenv.config(); // load GEMINI_API_KEY

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
app.get("/chat", (req, res) => res.sendFile(`${__dirname}/public/chat.html`));
app.get("/login", (req, res) => res.sendFile(`${__dirname}/public/login.html`));

const GEMINI_MODEL_URL_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const SYSTEM_INSTRUCTION = [
  "You are Owen.Ai.",
  "Personality: friendly, playful, funny, and always genuinely helpful.",
  "Identity knowledge: You live on the game website Owen.fun.",
  "Behavior: you enjoy helping people in whatever way you can.",
  "Response quality: keep responses clear, complete, and avoid cutting thoughts off mid-sentence."
].join(" ");
const DAILY_TOKEN_BUDGET = Number(process.env.DAILY_TOKEN_BUDGET || 250000);

let memory = [];
const MAX_MEMORY_MESSAGES = 10;
let globalUsedOutputTokens = 0;

function buildGeminiUrl(stream = false) {
  const key = encodeURIComponent(process.env.GEMINI_API_KEY || "");
  if (stream) {
    return `${GEMINI_MODEL_URL_BASE}/${encodeURIComponent(GEMINI_MODEL)}:streamGenerateContent?alt=sse&key=${key}`;
  }
  return `${GEMINI_MODEL_URL_BASE}/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${key}`;
}

function extractModelText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map(part => (typeof part?.text === "string" ? part.text : ""))
    .join("");
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

app.get("/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.status(500).send("Google OAuth is not configured.");
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("access_type", "online");
  authUrl.searchParams.set("prompt", "select_account");
  return res.redirect(authUrl.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
      return res.status(500).send("Google OAuth is not configured.");
    }
    const code = req.query?.code;
    if (!code) return res.status(400).send("Missing Google authorization code.");

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      }).toString()
    });
    const tokenJson = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenJson.access_token) {
      return res.status(502).send("Google token exchange failed.");
    }

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` }
    });
    const profile = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok || !profile.sub) {
      return res.status(502).send("Failed to read Google profile.");
    }

    const googleUsername = `google_${profile.sub}`;
    const safeUsername = escapeHtml(googleUsername);
    const safeName = escapeHtml(profile.name || profile.given_name || googleUsername);
    return res.send(`<!doctype html><html><body><script>
      const payload = { type: "google-auth-success", username: "${safeUsername}", name: "${safeName}" };
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
          window.close();
        } else {
          localStorage.setItem("owen_user", payload.username);
          localStorage.setItem("owen_user_name", payload.name);
          window.location.href = "/chat";
        }
      } catch (e) {
        localStorage.setItem("owen_user", payload.username);
        localStorage.setItem("owen_user_name", payload.name);
        window.location.href = "/chat";
      }
    </script></body></html>`);
  } catch (error) {
    return res.status(500).send("Google login failed.");
  }
});

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

    const userMessage = req.body?.message?.trim() || "";
    const image = req.body?.image || null;
    const hasImage = Boolean(image?.data && image?.mimeType);

    if (!userMessage && !hasImage) {
      return res.status(400).json({ reply: "Please send a message or an image." });
    }

    if (hasImage && !String(image.mimeType).startsWith("image/")) {
      return res.status(400).json({ reply: "Only image uploads are supported." });
    }

    if (hasImage && String(image.data).length > 6_000_000) {
      return res.status(400).json({ reply: "Image is too large. Please upload a smaller image." });
    }

    const contents = [];
    memory.forEach(m => contents.push({ role: m.role, parts: [{ text: m.text }] }));
    const userParts = [];
    if (userMessage) userParts.push({ text: userMessage });
    if (hasImage) {
      userParts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data
        }
      });
    }
    contents.push({ role: "user", parts: userParts });

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 8192 }
    };

    const response = await fetch(buildGeminiUrl(true), {
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
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write(": stream-open\n\n");
    const keepAlive = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);
    req.on("close", () => {
      clearInterval(keepAlive);
    });

    let buffer = "";
    let rawAll = "";
    let fullText = "";
    let usedOutputTokens = 0;

    for await (const chunk of response.body) {
      const chunkText = chunk.toString("utf8");
      rawAll += chunkText;
      buffer += chunkText;
      
      // Keep splitting until there are no more complete events in the buffer
      let splitIndex;
      while ((splitIndex = buffer.indexOf("\n\n")) >= 0) {
        // Extract one complete event
        const eventData = buffer.slice(0, splitIndex);
        // Remove the processed event and the newline delimiters from the buffer
        buffer = buffer.slice(splitIndex + 2);

        // Process the extracted event
        const lines = eventData.split("\n");
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                const payload = line.slice(6).trim();
                if (!payload || payload === "[DONE]") continue;
                
                let parsed = null;
                try {
                  parsed = JSON.parse(payload);
                } catch (error) {
                  // Skip invalid JSON lines
                  continue;
                }
                const delta = extractModelText(parsed);
                if (delta) {
                  fullText += delta;
                  res.write(`data: ${JSON.stringify({ delta, usedOutputTokens })}\n\n`);
                }
                usedOutputTokens = parsed?.usageMetadata?.candidatesTokenCount || usedOutputTokens;
            }
        }
      }
    }

    if (!fullText.trim()) {
      // Fallback for environments that return full JSON instead of SSE framing.
      const fallbackPayload = rawAll.trim();
      if (fallbackPayload) {
        try {
          const parsed = JSON.parse(fallbackPayload);
          if (Array.isArray(parsed)) {
            fullText = parsed.map(extractModelText).join("");
            for (const item of parsed) {
              usedOutputTokens = item?.usageMetadata?.candidatesTokenCount || usedOutputTokens;
            }
          } else {
            fullText = extractModelText(parsed);
            usedOutputTokens = parsed?.usageMetadata?.candidatesTokenCount || usedOutputTokens;
          }
          if (fullText) {
            res.write(`data: ${JSON.stringify({ delta: fullText, usedOutputTokens })}\n\n`);
          }
        } catch (error) {
          // Keep empty fullText and return fallback message below.
        }
      }
    }

    if (!fullText.trim()) {
      clearInterval(keepAlive);
      return res.end(`data: ${JSON.stringify({ delta: "I couldn't generate a response.", usedOutputTokens })}\n\ndata: [DONE]\n\n`);
    }

    memory.push({ role: "user", text: userMessage || "[User sent an image]" });
    memory.push({ role: "model", text: fullText.trim() });
    memory = memory.slice(-MAX_MEMORY_MESSAGES);
    globalUsedOutputTokens += usedOutputTokens;
    res.write(`data: ${JSON.stringify({ usedOutputTokens })}\n\n`);
    clearInterval(keepAlive);
    return res.end("data: [DONE]\n\n");
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Hmm… network or API error. Try again?" });
  }
});

app.get("/usage", (req, res) => {
  const used = Math.max(0, globalUsedOutputTokens);
  const remaining = Math.max(0, DAILY_TOKEN_BUDGET - used);
  res.json({
    dailyTokenBudget: DAILY_TOKEN_BUDGET,
    usedOutputTokens: used,
    remainingOutputTokens: remaining
  });
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

    const extractedText = json ? extractModelText(json) : "";
    const issue = json
      ? (extractedText ? null : extractModelIssue(json))
      : "Non-JSON response from Gemini";

    return res.status(response.ok ? 200 : 502).json({
      ok: response.ok,
      status: response.status,
      model: GEMINI_MODEL,
      extractedText,
      issue,
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
