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

// ===== CONFIG =====
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ===== STATE =====
const conversations = {};
const userProfiles = {};
const userLimits = {};
const dailyUsage = {};
const DAILY_LIMIT = 20;

// ===== HELPERS =====
function normalize(msg) {
  return (msg || "").toLowerCase().trim();
}

function isGreeting(msg) {
  const m = normalize(msg);
  return ["hi", "hello", "hey"].includes(m);
}

function isGratitude(msg) {
  const m = normalize(msg);
  return (
    m.includes("thank") ||
    m.includes("thanks") ||
    m.includes("thx") ||
    m.includes("ty")
  );
}

function hasOnlyEmoji(msg) {
  return /^[\p{Emoji}\s]+$/u.test(msg);
}

function needsClarification(msg) {
  const m = normalize(msg);
  if (isGreeting(m) || isGratitude(m)) return false;
  if (hasOnlyEmoji(msg)) return false;
  if (m.split(" ").length <= 1) return false;
  return ["law", "case", "help"].includes(m);
}

function detectTone(msg) {
  if (/😭|😩/.test(msg)) return "simple";
  if (/argue|critically|discuss/i.test(msg)) return "exam";
  return "default";
}

// ===== PERSONALITY =====
function updateUserProfile(user, msg) {
  if (!userProfiles[user]) {
    userProfiles[user] = {
      style: "default",
      prefersSimple: false,
      prefersExam: false,
    };
  }

  const tone = detectTone(msg);

  if (tone === "simple") userProfiles[user].prefersSimple = true;
  if (tone === "exam") userProfiles[user].prefersExam = true;
}

function buildPrompt(profile) {
  let style = "default";

  if (profile?.prefersExam) style = "exam";
  else if (profile?.prefersSimple) style = "simple";

  let base = "";

  if (style === "exam") {
    base = "Answer using IRAC (Issue, Rule, Application, Conclusion).";
  } else if (style === "simple") {
    base = "Explain in very simple terms with relatable examples.";
  } else {
    base = "Explain clearly and concisely.";
  }

  base += "\nStructure your answer clearly:";
  base += "\n- Introduction";
  base += "\n- Explanation";
  base += "\n- Conclusion";
  base += "\nUse light emojis (⚖️📚).";
  base += "\nEnd with ONE follow-up question.";

  return { role: "system", content: base };
}

// ===== LIMITS =====
function isRateLimited(user) {
  const now = Date.now();
  if (!userLimits[user]) {
    userLimits[user] = { count: 1, time: now };
    return false;
  }

  if (now - userLimits[user].time > 30000) {
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

// ===== VOICE INPUT =====
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

// ===== VOICE OUTPUT =====
async function generateVoice(text) {
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

  const tempPath = path.join(__dirname, `temp-${Date.now()}.mp3`);
  fs.writeFileSync(tempPath, res.data);

  const upload = await cloudinary.uploader.upload(tempPath, {
    resource_type: "video",
    folder: "voice-replies",
  });

  fs.unlinkSync(tempPath);

  return upload.secure_url;
}

// ===== MAIN WEBHOOK =====
app.post("/webhook", async (req, res) => {
  let msg = req.body.Body || "";
  const user = req.body.From;

  try {
    // Voice input
    if (req.body.NumMedia && req.body.NumMedia !== "0") {
      msg = await transcribeAudio(
        req.body.MediaUrl0,
        req.body.MediaContentType0
      );
    }

    // Priority responses
    if (isGreeting(msg))
      return res.send(`<Response><Message>Hi 👋 Ask me anything about law.</Message></Response>`);

    if (isGratitude(msg))
      return res.send(`<Response><Message>😊 You're welcome! Always here to help.</Message></Response>`);

    if (isDailyLimited(user))
      return res.send(`<Response><Message>Daily limit reached.</Message></Response>`);

    if (isRateLimited(user))
      return res.send(`<Response><Message>Please slow down.</Message></Response>`);

    if (needsClarification(msg))
      return res.send(`<Response><Message>Could you clarify your question?</Message></Response>`);

    updateUserProfile(user, msg);

    res.send(`<Response><Message>⚖️ Let me think about that...</Message></Response>`);

    // Async AI processing
    (async () => {
      try {
        if (!conversations[user]) conversations[user] = [];
        conversations[user].push({ role: "user", content: msg });

        const profile = userProfiles[user];

        const ai = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-4o-mini",
            max_tokens: 900,
            messages: [buildPrompt(profile), ...conversations[user].slice(-6)],
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
          reply = reply.replace(followUp, "").trim();
        }

        // Chunking
        const chunks = [];
        let current = "";

        reply.split("\n").forEach(line => {
          if ((current + line).length > 1200) {
            chunks.push(current);
            current = line;
          } else {
            current += "\n" + line;
          }
        });
        if (current) chunks.push(current);

        // Send chunks sequentially
        for (let part of chunks) {
          await client.messages.create({
            body: part.trim(),
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

      } catch (err) {
        console.error("AI ERROR:", err.message);
        await client.messages.create({
          body: "⚠️ Something went wrong. Please try again.",
          from: "whatsapp:+14155238886",
          to: user,
        });
      }
    })();

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
    return res.send(`<Response><Message>Error occurred.</Message></Response>`);
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
