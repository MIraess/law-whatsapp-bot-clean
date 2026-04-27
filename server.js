require("dotenv").config();
const express = require("express");
const axios = require("axios");
const twilio = require("twilio");
const FormData = require("form-data");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.urlencoded({ extended: true }));

// ================= CONFIG =================
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ================= MEMORY =================
const conversations = {};
const userProfiles = {};
const userLimits = {};
const dailyUsage = {};
const DAILY_LIMIT = 20;

// ================= HELPERS =================
function cleanMessage(msg) {
  return (msg || "").toLowerCase().trim();
}

function isGreeting(msg) {
  const m = cleanMessage(msg);
  return ["hi", "hello", "hey"].includes(m);
}

// ✅ FIXED GRATITUDE (handles emojis & sentences)
function isGratitude(msg) {
  const m = cleanMessage(msg);
  return (
    m.includes("thank") ||
    m.includes("thanks") ||
    m.includes("thx") ||
    m.includes("ty")
  );
}

function detectEmotion(msg) {
  if (/😂|🤣/.test(msg)) return "funny";
  if (/😭|😩/.test(msg)) return "confused";
  if (/🔥/.test(msg)) return "impressed";
  return "neutral";
}

function getReaction(msg) {
  if (/😂|🤣/.test(msg)) return "😄 Got it, let’s look at this...";
  if (/😭|😩/.test(msg)) return "😅 Don’t worry, I’ll simplify it...";
  if (/🔥/.test(msg)) return "🔥 Nice one, let’s dive in...";
  return "⚖️ Analyzing your question...";
}

// SMART clarification
function needsClarification(msg) {
  const m = cleanMessage(msg);
  if (isGreeting(m) || isGratitude(m)) return false;
  if (m.split(" ").length <= 1) return false;
  return ["law", "case", "help"].includes(m);
}

// PERSONALITY
function updateUserProfile(user, msg) {
  if (!userProfiles[user]) userProfiles[user] = { style: "default" };

  if (/explain/i.test(msg)) userProfiles[user].style = "simple";
  if (/argue|discuss|critically/i.test(msg)) userProfiles[user].style = "exam";
  if (/😭|😩/.test(msg)) userProfiles[user].style = "simple";
}

function buildPrompt(style) {
  let base = "";

  if (style === "exam") {
    base = "Answer using IRAC: Issue, Rule, Application, Conclusion.";
  } else if (style === "simple") {
    base = "Explain in simple terms with examples.";
  } else {
    base = "Explain clearly and concisely.";
  }

  base += "\nUse emojis (⚖️📚).";
  base += "\nEnd with one follow-up question.";

  return { role: "system", content: base };
}

// ================= LIMITS =================
function isRateLimited(user) {
  const now = Date.now();
  if (!userLimits[user]) {
    userLimits[user] = { count: 1, time: now };
    return false;
  }
  const diff = now - userLimits[user].time;
  if (diff > 30000) {
    userLimits[user] = { count: 1, time: now };
    return false;
  }
  userLimits[user].count++;
  return userLimits[user].count > 5;
}

function isDailyLimited(user) {
  const today = new Date().toDateString();
  if (!dailyUsage[user]) {
    dailyUsage[user] = { date: today, count: 1 };
    return false;
  }
  if (dailyUsage[user].date !== today) {
    dailyUsage[user] = { date: today, count: 1 };
    return false;
  }
  dailyUsage[user].count++;
  return dailyUsage[user].count > DAILY_LIMIT;
}

// ================= VOICE INPUT =================
async function transcribeAudio(url, type) {
  const audio = await axios.get(url, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });

  const form = new FormData();
  form.append("file", audio.data, {
    filename: "audio.ogg",
    contentType: type || "audio/ogg",
  });
  form.append("model", "gpt-4o-mini-transcribe");

  const res = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  return res.data.text;
}

// ================= VOICE OUTPUT (FIXED) =================
async function generateVoice(text) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/audio/speech",
      {
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: text,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        responseType: "arraybuffer",
      }
    );

    // Save temp file
    const filePath = path.join(__dirname, "temp.mp3");
    fs.writeFileSync(filePath, res.data);

    // Upload to Cloudinary
    const upload = await cloudinary.uploader.upload(filePath, {
      resource_type: "video",
      folder: "voice-replies",
    });

    // Delete temp file
    fs.unlinkSync(filePath);

    return upload.secure_url;

  } catch (err) {
    console.error("VOICE ERROR:", err.message);
    throw err;
  }
}

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  let msg = req.body.Body || "";
  const user = req.body.From;

  try {
    if (req.body.NumMedia && req.body.NumMedia !== "0") {
      msg = await transcribeAudio(
        req.body.MediaUrl0,
        req.body.MediaContentType0
      );
    }

    // ✅ FIXED ORDER (gratitude BEFORE reaction)
    if (isGreeting(msg))
      return res.send(`<Response><Message>Hi 👋 Ask me anything about law.</Message></Response>`);

    if (isGratitude(msg))
      return res.send(`<Response><Message>😊 You're welcome! Always here to help.</Message></Response>`);

    if (isDailyLimited(user))
      return res.send(`<Response><Message>Daily limit reached.</Message></Response>`);

    if (isRateLimited(user))
      return res.send(`<Response><Message>Please slow down.</Message></Response>`);

    if (needsClarification(msg))
      return res.send(`<Response><Message>Please clarify your question.</Message></Response>`);

    updateUserProfile(user, msg);

    res.send(`<Response><Message>${getReaction(msg)}</Message></Response>`);

    (async () => {
      const style = userProfiles[user]?.style || "default";

      if (!conversations[user]) conversations[user] = [];
      conversations[user].push({ role: "user", content: msg });

      const ai = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          max_tokens: 900,
          messages: [buildPrompt(style), ...conversations[user].slice(-6)],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
        }
      );

      let reply = ai.data.choices[0].message.content;

      // Extract follow-up
      let followUp = "";
      const q = reply.match(/[^.?!]*\?/g);
      if (q) {
        followUp = q[q.length - 1];
        reply = reply.replace(followUp, "");
      }

      // Chunking
      let parts = [];
      let current = "";
      reply.split("\n").forEach(line => {
        if ((current + line).length > 1200) {
          parts.push(current);
          current = line;
        } else {
          current += "\n" + line;
        }
      });
      if (current) parts.push(current);

      // Send messages
      for (let part of parts) {
        await client.messages.create({
          body: part,
          from: "whatsapp:+14155238886",
          to: user,
        });

        try {
          const voice = await generateVoice(part);
          await client.messages.create({
            mediaUrl: [voice],
            from: "whatsapp:+14155238886",
            to: user,
          });
        } catch {}

        await new Promise(r => setTimeout(r, 800));
      }

      // Follow-up LAST
      if (followUp) {
        await client.messages.create({
          body: followUp,
          from: "whatsapp:+14155238886",
          to: user,
        });
      }
    })();

  } catch (err) {
    console.error("ERROR:", err.message);
    return res.send(`<Response><Message>Error occurred.</Message></Response>`);
  }
});

app.listen(3000, () => console.log("Server running"));
