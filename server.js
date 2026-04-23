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

// 🧠 Mode handler (NOW WITH LANGUAGE SUPPORT)
function getModePrompt(message) {

  // 🌍 Language modes
  if (message.startsWith("/hausa")) {
    return {
      role: "system",
      content:
        "Explain Nigerian legal concepts clearly in Hausa language. Use simple explanations and examples. End with: 'Wannan don ilmantarwa ne kawai, ba shawarar doka ba.'",
    };
  }

  if (message.startsWith("/igbo")) {
    return {
      role: "system",
      content:
        "Kọwaa iwu Nigeria n'ụzọ dị mfe n'asụsụ Igbo. Jiri ihe atụ mee ka o doo anya. Kwụsị na: 'Nke a bụ naanị maka mmụta, ọ bụghị ndụmọdụ iwu.'",
    };
  }

  if (message.startsWith("/yoruba")) {
    return {
      role: "system",
      content:
        "Ṣàlàyé òfin Nàìjíríà ní èdè Yorùbá ní kedere. Lo àpẹẹrẹ. Pari pẹlu: 'Eyi jẹ fun ẹkọ nikan, kii ṣe imọran ofin.'",
    };
  }

  // ⚖️ Existing modes
  if (message.startsWith("/exam")) {
    return {
      role: "system",
      content:
        "You are a Nigerian law lecturer and examiner. Answer strictly using IRAC:\n" +
        "Issue\nRule\nApplication\nConclusion\n" +
        "Be clear, structured, and analytical.\n" +
        "End every answer with: 'This is for educational purposes only, not legal advice.'",
    };
  }

  if (message.startsWith("/simple")) {
    return {
      role: "system",
      content:
        "You are a Nigerian law tutor. Explain in simple terms with examples.\n" +
        "End every answer with: 'This is for educational purposes only, not legal advice.'",
    };
  }

  if (message.startsWith("/argue")) {
    return {
      role: "system",
      content:
        "You are a Nigerian lawyer in court. Argue persuasively with strong reasoning.\n" +
        "End every answer with: 'This is for educational purposes only, not legal advice.'",
    };
  }

  return {
    role: "system",
    content:
      "You are a Nigerian law tutor. Explain clearly and concisely.\n" +
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

  const systemPrompt = getModePrompt(userMessage);

  // ✅ Clean command
  userMessage = userMessage.replace(/^\/\w+\s*/, "").trim();

  try {
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 800,
        messages: [
          systemPrompt,
          {
            role: "user",
            content: userMessage,
          },
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

    const MessagingResponse = require("twilio").twiml.MessagingResponse;
    const twiml = new MessagingResponse();

    // 🧠 SMART PARAGRAPH SPLITTING (FIXED FLOW)
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
