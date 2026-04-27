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

// ================= STATE =================
const conversations = {};
const userProfiles = {};
const userLimits = {};
const dailyUsage = {};
const DAILY_LIMIT = 20;

// ================= STAGE 1: INPUT PROCESSING =================
function normalize(msg) {
  return (msg || "").toLowerCase().trim();
}

function detectEmotion(msg) {
  if (/😂|🤣/.test(msg)) return "funny";
  if (/😭|😩/.test(msg)) return "confused";
  if (/🔥/.test(msg)) return "impressed";
  if (/😊|🙂/.test(msg)) return "friendly";
  return "neutral";
}

function isGreeting(msg) {
  const m = normalize(msg);
  return ["hi", "hello", "hey"].includes(m);
}

function isGratitude(msg) {
  const m = msg.toLowerCase();
  return /(thank|thanks|thx|ty)/.test(m);
}
function hasOnlyEmoji(msg) {
  return /^[\p{Emoji}\s]+$/u.test(msg);
}

// ================= STAGE 2: CONTROL LOGIC =================
function needsClarification(msg) {
  const m = msg.toLowerCase().trim();

  if (isGreeting(m)) return false;
  if (isGratitude(m)) return false;

  // ignore emoji-only or short friendly texts
  if (/^[\p{Emoji}\s]+$/u.test(msg)) return false;
  if (m.split(" ").length <= 2) return false;

  return ["law", "case", "help"].includes(m);
}
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

// ================= STAGE 3: PERSONALITY =================
function updateUserProfile(user, msg) {
  if (!userProfiles[user]) {
    userProfiles[user] = {
      prefersSimple: false,
      prefersExam: false,
      emotionalTone: "neutral",
    };
  }

  const emotion = detectEmotion(msg);
  userProfiles[user].emotionalTone = emotion;

  if (/explain/i.test(msg) || emotion === "confused") {
    userProfiles[user].prefersSimple = true;
  }

  if (/argue|critically|discuss/i.test(msg)) {
    userProfiles[user].prefersExam = true;
  }
}

function buildPrompt(profile) {
  let styleInstruction = "";

  if (profile.prefersExam) {
    styleInstruction = "Answer using IRAC (Issue, Rule, Application, Conclusion).";
  } else if (profile.prefersSimple) {
    styleInstruction = "Explain in very simple terms with relatable examples.";
  } else {
    styleInstruction = "Explain clearly and concisely.";
  }

  return {
    role: "system",
    content: `
${styleInstruction}

Structure strictly as:
Introduction
Explanation
Conclusion

Use light emojis (⚖️📚).
End with ONE follow-up question.
    `,
  };
}

// ================= STAGE 4: VOICE =================
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

async function generateVoice(text) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/audio/speech",
      {
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: text,
        format: "mp3" // IMPORTANT
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
      format: "mp3", // IMPORTANT
      public_id: `voice_${Date.now()}`
    });

    fs.unlinkSync(tempPath);

    console.log("VOICE URL:", upload.secure_url);

    return upload.secure_url;

  } catch (err) {
    console.error("VOICE ERROR:", err.response?.data || err.message);
    throw err;
  }
}
// ================= STAGE 5: RESPONSE STRUCTURE =================
function extractFollowUp(reply) {
  let followUp = "";
  const matches = reply.match(/[^.?!]*\?/g);

  if (matches && matches.length > 0) {
    followUp = matches[matches.length - 1].trim();
    reply = reply.replace(followUp, "").trim();
  }

  return { reply, followUp };
}

function chunkResponse(text) {
  const lines = text.split("\n").filter(l => l.trim() !== "");
  const chunks = [];
  let current = "";

  for (let line of lines) {
    if ((current + "\n" + line).length > 1200) {
      chunks.push(current.trim());
      current = line;
    } else {
      current += "\n" + line;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks;
}

// ================= STAGE 6: DELIVERY =================
async function sendResponse(user, chunks, followUp) {
  for (let part of chunks) {
    await client.messages.create({
      body: part,
      from: "whatsapp:+14155238886",
      to: user,
    });

    try {
      const voiceUrl = await generateVoice(part);
      await client.messages.create({
        mediaUrl: [voiceUrl],
        body: "🔊 Voice note",
        from: "whatsapp:+14155238886",
        to: user,
      });
    } catch {}

    await new Promise(r => setTimeout(r, 800));
  }

  if (followUp) {
    await client.messages.create({
      body: followUp,
      from: "whatsapp:+14155238886",
      to: user,
    });
  }
}

// ================= MAIN WEBHOOK =================
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
      return res.send(`<Response><Message>😊 You're welcome!</Message></Response>`);

    if (isDailyLimited(user))
      return res.send(`<Response><Message>Daily limit reached.</Message></Response>`);

    if (isRateLimited(user))
      return res.send(`<Response><Message>Please slow down.</Message></Response>`);

    if (needsClarification(msg))
      return res.send(`<Response><Message>Please clarify your question.</Message></Response>`);

    updateUserProfile(user, msg);

    res.send(`<Response><Message>⚖️ Let me think about that...</Message></Response>`);

    // Async processing
    (async () => {
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

      const structured = extractFollowUp(reply);
      const chunks = chunkResponse(structured.reply);

      await sendResponse(user, chunks, structured.followUp);
    })();

  } catch (err) {
    console.error(err.message);
    return res.send(`<Response><Message>Error occurred.</Message></Response>`);
  }
});

app.listen(3000, () => console.log("Server running"));
