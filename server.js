require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: true }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ================= MEMORY =================
const conversations = {};
const userProfiles = {};
const userLimits = {};
const dailyUsage = {};
const DAILY_LIMIT = 20;

// ================= UTILITIES =================
function cleanMessage(message) {
  return message.toLowerCase().replace(/[^\w\s]/gi, "").trim();
}

function detectEmotion(message) {
  if (/😂|🤣/.test(message)) return "funny";
  if (/😭|😩/.test(message)) return "confused";
  if (/🔥/.test(message)) return "impressed";
  if (/😊|🙂/.test(message)) return "friendly";
  return "neutral";
}

function getReaction(message) {
  if (/😂|🤣/.test(message)) return "😄 Got it, let’s look at this...";
  if (/😭|😩/.test(message)) return "😅 Don’t worry, I’ll simplify it...";
  if (/🔥/.test(message)) return "🔥 Nice one, let’s dive in...";
  return "⚖️ Analyzing...";
}

function detectMode(message) {
  const msg = message.toLowerCase();
  if (msg.includes("argue") || msg.includes("justify")) return "exam";
  if (msg.includes("discuss") || msg.includes("critically")) return "exam";
  if (msg.includes("explain") || msg.includes("what is")) return "simple";
  return "default";
}

function needsClarification(message) {
  const msg = cleanMessage(message);

  const greetings = ["hi", "hello", "hey"];
  if (greetings.includes(msg)) return false;

  if (msg.split(" ").length <= 1) return true;

  const vague = ["law", "case", "help"];
  return vague.includes(msg);
}

function updateUserProfile(user, message) {
  if (!userProfiles[user]) {
    userProfiles[user] = { style: "default" };
  }

  const msg = message.toLowerCase();

  if (msg.includes("explain")) userProfiles[user].style = "simple";
  if (msg.includes("discuss") || msg.includes("argue"))
    userProfiles[user].style = "exam";

  if (/😭|😩/.test(message)) userProfiles[user].style = "simple";
}

// ================= PROMPT =================
function buildPrompt(mode, userProfile) {
  let style = userProfile?.style || mode;

  let base = "";

  if (style === "exam") {
    base = "Answer using IRAC: Issue, Rule, Application, Conclusion.";
  } else if (style === "simple") {
    base = "Explain in very simple terms with examples.";
  } else {
    base = "Explain clearly and concisely.";
  }

  base += "\nUse light professional emojis (⚖️📚✅).";
  base += "\nAsk one short follow-up question at the end.";
  base += "\nEnd with: 'This is for educational purposes only, not legal advice.'";

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

// ================= VOICE =================
async function transcribeAudio(mediaUrl) {
  const audio = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });

  const response = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    audio.data,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "audio/ogg",
      },
    }
  );

  return response.data.text;
}

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  let userMessage = req.body.Body || "";
  const userNumber = req.body.From;

  // 🎤 Voice note
  if (req.body.NumMedia && req.body.NumMedia !== "0") {
    try {
      userMessage = await transcribeAudio(req.body.MediaUrl0);
    } catch {
      return res.send(`<Response><Message>Couldn't process voice note.</Message></Response>`);
    }
  }

  const msgLower = cleanMessage(userMessage);
  const emotion = detectEmotion(userMessage);

  // 👋 Greeting
  if (["hi", "hello", "hey"].includes(msgLower)) {
    return res.send(`<Response><Message>Hi 👋 Ask me anything about law.</Message></Response>`);
  }

  // 💬 Emotion quick response
  if (emotion === "impressed") {
    return res.send(`<Response><Message>😄 Glad you like it! Want more?</Message></Response>`);
  }

  // 💸 Limits
  if (isDailyLimited(userNumber)) {
    return res.send(`<Response><Message>Daily limit reached.</Message></Response>`);
  }

  if (isRateLimited(userNumber)) {
    return res.send(`<Response><Message>Please slow down.</Message></Response>`);
  }

  // ❗ Clarification
  if (needsClarification(userMessage)) {
    return res.send(`<Response><Message>Please clarify your question.</Message></Response>`);
  }

  // 🧠 Personality update
  updateUserProfile(userNumber, userMessage);

  // ⚡ Reaction
  res.send(`<Response><Message>${getReaction(userMessage)}</Message></Response>`);

  // ================= AI PROCESS =================
  (async () => {
    try {
      const mode = detectMode(userMessage);
      const systemPrompt = buildPrompt(mode, userProfiles[userNumber]);

      if (!conversations[userNumber]) conversations[userNumber] = [];

      conversations[userNumber].push({ role: "user", content: userMessage });

      const aiResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          max_tokens: 800,
          messages: [systemPrompt, ...conversations[userNumber].slice(-6)],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
        }
      );

      let reply = aiResponse.data.choices[0].message.content;

      conversations[userNumber].push({ role: "assistant", content: reply });

      // 🧠 Extract follow-up
      let followUp = "";
      const matches = reply.match(/[^.?!]*\?/g);

      if (matches && matches.length > 0) {
        followUp = matches[matches.length - 1].trim();
        reply = reply.replace(followUp, "").trim();
      }

      // 🧠 Split response properly
      let lines = reply.split("\n").filter(l => l.trim() !== "");
      let messages = [];
      let current = "";

      lines.forEach(line => {
        if ((current + line).length > 1200) {
          messages.push(current.trim());
          current = line;
        } else {
          current += "\n" + line;
        }
      });

      if (current) messages.push(current.trim());

      // 🚀 Send messages
      for (let msg of messages) {
        await client.messages.create({
          body: msg,
          from: "whatsapp:+14155238886",
          to: userNumber,
        });

        await new Promise(r => setTimeout(r, 700));
      }

      // ✅ Follow-up LAST
      if (followUp) {
        await client.messages.create({
          body: followUp,
          from: "whatsapp:+14155238886",
          to: userNumber,
        });
      }

    } catch (err) {
      await client.messages.create({
        body: "Something went wrong. Try again.",
        from: "whatsapp:+14155238886",
        to: userNumber,
      });
    }
  })();
});

// ================= START =================
app.listen(3000, () => {
  console.log("Server running on port 3000");
});
