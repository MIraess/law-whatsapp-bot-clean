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

// 🧠 Memory storage
const conversations = {};

// 🌍 Language detection
function detectLanguage(message) {
  if (/kedu|iwu|gịnị/i.test(message)) return "igbo";
  if (/kini|ofin|ṣe/i.test(message)) return "yoruba";
  if (/menene|doka/i.test(message)) return "hausa";
  return "english";
}

// 🧠 Mode handler
function getModePrompt(message) {

  if (message.startsWith("/exam")) {
    return {
      role: "system",
      content:
        "You are a Nigerian law lecturer and examiner. Answer strictly using IRAC:\n" +
        "Issue\nRule\nApplication\nConclusion\n" +
        "Be clear, structured, and analytical.\n" +
        "After answering, ask one short follow-up question.\n" +
        "End every answer with: 'This is for educational purposes only, not legal advice.'",
    };
  }

  if (message.startsWith("/simple")) {
    return {
      role: "system",
      content:
        "You are a Nigerian law tutor. Explain in simple terms with examples.\n" +
        "After answering, ask one short follow-up question.\n" +
        "End every answer with: 'This is for educational purposes only, not legal advice.'",
    };
  }

  if (message.startsWith("/argue")) {
    return {
      role: "system",
      content:
        "You are a Nigerian lawyer in court. Argue persuasively with strong reasoning.\n" +
        "After answering, ask one short follow-up question.\n" +
        "End every answer with: 'This is for educational purposes only, not legal advice.'",
    };
  }

  return {
    role: "system",
    content:
      "You are a Nigerian law tutor. Explain clearly and concisely.\n" +
      "After answering, ask one short follow-up question to continue the conversation.\n" +
      "End every answer with: 'This is for educational purposes only, not legal advice.'",
  };
}

// 🔥 Webhook
app.post("/webhook", async (req, res) => {
  console.log("🔥 Webhook hit!");
  console.log("Body:", req.body);

  let userMessage = req.body.Body || "";
  const userNumber = req.body.From;

  // 🔒 Rate limiting
  if (isRateLimited(userNumber)) {
    res.type("text/xml");
    return res.send(`
      <Response>
        <Message>Please slow down. Try again in a few seconds.</Message>
      </Response>
    `);
  }

  // 📊 Logging
  const log = `${new Date().toISOString()} | ${userNumber} | ${userMessage}\n`;
  fs.appendFileSync("logs.txt", log);

  // 🌍 Detect language
  const language = detectLanguage(userMessage);

  const systemPrompt = getModePrompt(userMessage);

  // Modify system prompt based on detected language
  if (language === "igbo") {
    systemPrompt.content += "\nRespond in Igbo language.";
  } else if (language === "yoruba") {
    systemPrompt.content += "\nRespond in Yoruba language.";
  } else if (language === "hausa") {
    systemPrompt.content += "\nRespond in Hausa language.";
  }

  // ✅ Clean command
  userMessage = userMessage.replace(/^\/\w+\s*/, "").trim();

  // 🧠 Initialize memory
  if (!conversations[userNumber]) {
    conversations[userNumber] = [];
  }

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
          ...conversations[userNumber].slice(-6) // last 6 messages
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ AI RESPONSE RECEIVED");

    let reply = aiResponse.data.choices[0].message.content;

    if (!reply) {
      reply = "Sorry, something went wrong. Please try again.";
    }

    // 🧠 Save AI reply to memory
    conversations[userNumber].push({
      role: "assistant",
      content: reply,
    });

    const MessagingResponse = require("twilio").twiml.MessagingResponse;
    const twiml = new MessagingResponse();

    // ✂️ Smart paragraph splitting
    const paragraphs = reply.split("\n");

    let currentMessage = "";

    paragraphs.forEach((para) => {
      if ((currentMessage + para).length > 1500) {
        twiml.message(currentMessage.trim());
        currentMessage = para;
      } else {
        currentMessage += "\n" + para;
      }
    });

    if (currentMessage) {
      twiml.message(currentMessage.trim());
    }

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (error) {
    console.error("❌ ERROR:", error.response?.data || error.message);

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
