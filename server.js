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

// ✅ Test route
app.get("/", (req, res) => {
  res.send("Server is alive 🔥");
});

// 🧠 Memory
const conversations = {};

// 🧠 Rate + Daily limit
const userLimits = {};
const dailyUsage = {};
const DAILY_LIMIT = 20;

// 🔒 Rate limiter
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

// 💸 Daily limit
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

// 🌍 Language detection
function detectLanguage(message) {
  if (/kedu|iwu|gịnị/i.test(message)) return "igbo";
  if (/kini|ofin|ṣe/i.test(message)) return "yoruba";
  if (/menene|doka/i.test(message)) return "hausa";
  return "english";
}

// 🧠 Mode detection
function detectMode(message) {
  const msg = message.toLowerCase();

  if (msg.includes("argue") || msg.includes("justify")) return "argue";
  if (msg.includes("discuss") || msg.includes("critically")) return "exam";
  if (msg.includes("explain") || msg.includes("what is")) return "simple";

  return "default";
}

// 🧠 Clarification
function needsClarification(message) {
  const msg = message.toLowerCase().trim();

  const greetings = ["hi", "hello", "hey"];
  if (greetings.includes(msg)) return false;

  const legalKeywords = [
    "negligence", "contract", "tort", "crime",
    "offer", "acceptance", "liability"
  ];
  if (legalKeywords.includes(msg)) return false;

  if (msg.split(" ").length === 2) return false;

  const vagueWords = ["law", "case", "help"];
  if (vagueWords.includes(msg)) return true;

  return false;
}

// 🧠 Prompt builder
function buildPrompt(mode, language) {
  let base = "";

  if (mode === "exam") {
    base = "Answer using IRAC: Issue, Rule, Application, Conclusion.";
  } else if (mode === "argue") {
    base = "Provide strong legal arguments like a Nigerian lawyer.";
  } else if (mode === "simple") {
    base = "Explain in very simple terms with examples.";
  } else {
    base = "Explain clearly and concisely.";
  }

  base += "\nAsk one short follow-up question at the end.";

  if (language === "igbo") base += "\nRespond in Igbo.";
  if (language === "yoruba") base += "\nRespond in Yoruba.";
  if (language === "hausa") base += "\nRespond in Hausa.";

  base += "\nEnd with: 'This is for educational purposes only, not legal advice.'";

  return { role: "system", content: base };
}

// 🔥 WEBHOOK
app.post("/webhook", async (req, res) => {

  let userMessage = req.body.Body || "";
  const userNumber = req.body.From;

  const msgLower = userMessage.toLowerCase().trim();

  // 👋 Greeting FIRST
  const greetings = ["hi", "hello", "hey"];
  if (greetings.includes(msgLower)) {
    return res.send(`
      <Response>
        <Message>Hi 👋 I’m your Nigerian law assistant. Ask me anything about law.</Message>
      </Response>
    `);
  }

  // 💸 Limits
  if (isDailyLimited(userNumber)) {
    return res.send(`
      <Response>
        <Message>You’ve reached your daily limit.</Message>
      </Response>
    `);
  }

  if (isRateLimited(userNumber)) {
    return res.send(`
      <Response>
        <Message>Please slow down.</Message>
      </Response>
    `);
  }

  // ❗ Clarification
  if (needsClarification(userMessage)) {
    return res.send(`
      <Response>
        <Message>Could you clarify? Example: "Explain negligence in Nigerian law."</Message>
      </Response>
    `);
  }

  // ⚡ Instant response
  res.send(`
    <Response>
      <Message>⚖️ Analyzing your question...</Message>
    </Response>
  `);

  // 🧠 Background processing
  (async () => {
    try {

      const language = detectLanguage(userMessage);
      const mode = detectMode(userMessage);
      const systemPrompt = buildPrompt(mode, language);

      if (!conversations[userNumber]) conversations[userNumber] = [];

      conversations[userNumber].push({
        role: "user",
        content: userMessage
      });

      const aiResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          max_tokens: 800,
          messages: [
            systemPrompt,
            ...conversations[userNumber].slice(-6)
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      let reply = aiResponse.data.choices[0].message.content;

      conversations[userNumber].push({
        role: "assistant",
        content: reply
      });

      // 🧠 Extract follow-up question
      let followUp = "";
      const matches = reply.match(/[^.?!]*\?/g);

      if (matches && matches.length > 0) {
        followUp = matches[matches.length - 1].trim();
        reply = reply.replace(followUp, "").trim();
      }

      // 🧠 Better splitting
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

      // 🚀 Send structured messages
      for (let msg of messages) {
        await client.messages.create({
          body: msg,
          from: "whatsapp:+14155238886",
          to: userNumber
        });

        await new Promise(r => setTimeout(r, 700));
      }

      // ✅ Send follow-up LAST
      if (followUp) {
        await client.messages.create({
          body: followUp,
          from: "whatsapp:+14155238886",
          to: userNumber
        });
      }

    } catch (err) {
      await client.messages.create({
        body: "I ran into an issue. Try rephrasing your question.",
        from: "whatsapp:+14155238886",
        to: userNumber
      });
    }
  })();
});

// 🚀 START
app.listen(3000, () => {
  console.log("Server running on port 3000");
});
