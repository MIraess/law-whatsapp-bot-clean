require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: true }));

// ✅ Test route
app.get("/", (req, res) => {
  res.send("Server is alive 🔥");
});

// 🧠 Rate limiter
const userLimits = {};

// 💸 Daily usage limiter
const dailyUsage = {};
const DAILY_LIMIT = 20;

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

// 🧠 Memory
const conversations = {};

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

// 🧠 FIXED Smart clarification
function needsClarification(message) {
  const msg = message.toLowerCase().trim();

  // ✅ Greetings
  const greetings = ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"];
  if (greetings.includes(msg)) return false;

  // ✅ Legal keywords
  const legalKeywords = [
    "negligence", "contract", "tort", "crime",
    "offer", "acceptance", "consideration",
    "liability", "damages", "battery", "assault"
  ];
  if (legalKeywords.includes(msg)) return false;

  // ✅ Short meaningful phrases (2 words)
  if (msg.split(" ").length === 2) return false;

  // ❗ Truly vague
  const vagueWords = ["law", "case", "help", "explain"];
  if (vagueWords.includes(msg)) return true;

  return false;
}

// 🧠 Prompt builder
function buildPrompt(mode, language) {
  let base = "";

  if (mode === "exam") {
    base =
      "You are a Nigerian law lecturer. Answer using IRAC:\nIssue\nRule\nApplication\nConclusion\nBe structured and analytical.";
  } else if (mode === "argue") {
    base =
      "You are a Nigerian lawyer. Present persuasive legal arguments with authority and reasoning.";
  } else if (mode === "simple") {
    base =
      "You are a Nigerian law tutor. Explain in simple terms with examples.";
  } else {
    base =
      "You are a Nigerian law tutor. Explain clearly and concisely.";
  }

  base += "\nAsk one short follow-up question.";

  if (language === "igbo") base += "\nRespond in Igbo.";
  if (language === "yoruba") base += "\nRespond in Yoruba.";
  if (language === "hausa") base += "\nRespond in Hausa.";

  base += "\nEnd with: 'This is for educational purposes only, not legal advice.'";

  return { role: "system", content: base };
}

// 🔥 Webhook
app.post("/webhook", async (req, res) => {
  console.log("🔥 Webhook hit!");

  let userMessage = req.body.Body || "";
  const userNumber = req.body.From;

  // 💸 Daily limit
  if (isDailyLimited(userNumber)) {
    res.type("text/xml");
    return res.send(`
      <Response>
        <Message>You’ve reached your daily limit. Try again tomorrow.</Message>
      </Response>
    `);
  }

  // 🔒 Rate limit
  if (isRateLimited(userNumber)) {
    res.type("text/xml");
    return res.send(`
      <Response>
        <Message>Please slow down. Try again in a few seconds.</Message>
      </Response>
    `);
  }

  // 📊 Log
  fs.appendFileSync("logs.txt", `${new Date()} | ${userNumber} | ${userMessage}\n`);

  const msgLower = userMessage.toLowerCase().trim();

  // 👋 Greeting handler
  const greetings = ["hi", "hello", "hey"];
  if (greetings.includes(msgLower)) {
    res.type("text/xml");
    return res.send(`
      <Response>
        <Message>Hi 👋 I’m your Nigerian law assistant. You can ask me about cases, explanations, or exam questions.</Message>
      </Response>
    `);
  }

  // 🧠 Clarification check
  if (needsClarification(userMessage)) {
    res.type("text/xml");
    return res.send(`
      <Response>
        <Message>Could you clarify your question? For example: "Explain negligence in Nigerian law" or "Discuss contract law."</Message>
      </Response>
    `);
  }

  const language = detectLanguage(userMessage);
  const mode = detectMode(userMessage);
  const systemPrompt = buildPrompt(mode, language);

  // 🧠 Memory setup
  if (!conversations[userNumber]) conversations[userNumber] = [];

  conversations[userNumber].push({
    role: "user",
    content: userMessage,
  });

  try {
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 800,
        messages: [
          systemPrompt,
          ...conversations[userNumber].slice(-6),
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

    // 🧠 Save response
    conversations[userNumber].push({
      role: "assistant",
      content: reply,
    });

    const MessagingResponse = require("twilio").twiml.MessagingResponse;
    const twiml = new MessagingResponse();

    // ✂️ Smart splitting
    const parts = reply.split("\n");
    let current = "";

    parts.forEach(p => {
      if ((current + p).length > 1500) {
        twiml.message(current.trim());
        current = p;
      } else {
        current += "\n" + p;
      }
    });

    if (current) twiml.message(current.trim());

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (error) {
    console.error(error.response?.data || error.message);

    res.type("text/xml");
    res.send(`
      <Response>
        <Message>Sorry, something went wrong.</Message>
      </Response>
    `);
  }
});

// 🚀 Start server
app.listen(3000, () => {
  console.log("Server running on port 3000");
});
