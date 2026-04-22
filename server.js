require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: true }));

// ✅ TEST ROUTE (VERY IMPORTANT)
app.get("/", (req, res) => {
  res.send("Server is alive 🔥");
});

// 🧠 Simple in-memory rate limiter
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

// 🧠 Mode handler
function getModePrompt(message) {
  if (message.startsWith("/exam")) {
    return {
      role: "system",
      content:
        "You are a Nigerian law lecturer and examiner. Answer strictly using IRAC:\n" +
        "- Issue\n" +
        "- Rule (state relevant legal principles and Nigerian authorities where possible)\n" +
        "- Application (apply law clearly to facts or scenario)\n" +
        "- Conclusion\n" +
        "Your tone must be formal, precise, and exam-standard.\n" +
        "Where applicable, reference Nigerian cases, statutes, or common law principles used in Nigerian courts.\n" +
        "Avoid vague explanations. Be direct and analytical.\n" +
        "End every answer with: 'This is for educational purposes only, not legal advice.'",
    };
  }

  if (message.startsWith("/simple")) {
    return {
      role: "system",
      content:
        "You are a Nigerian law tutor.\n" +
        "Explain legal concepts in very simple terms as if teaching a 100-level law student.\n" +
        "Use clear language, relatable examples, and step-by-step explanations.\n" +
        "Avoid unnecessary legal jargon.\n" +
        "End every answer with: 'This is for educational purposes only, not legal advice.'",
    };
  }

  if (message.startsWith("/argue")) {
    return {
      role: "system",
      content:
        "You are a Nigerian lawyer in a moot court competition.\n" +
        "Present strong, persuasive legal arguments.\n" +
        "Structure your answer like courtroom submissions:\n" +
        "- Clear position\n" +
        "- Supporting legal principles\n" +
        "- Authorities where relevant\n" +
        "- Convincing reasoning\n" +
        "Sound confident, logical, and assertive.\n" +
        "End every answer with: 'This is for educational purposes only, not legal advice.'",
    };
  }

  return {
    role: "system",
    content:
      "You are a Nigerian law tutor. Explain clearly and concisely. Always end with 'This is for educational purposes only, not legal advice.'",
  };
}

// 🔥 WEBHOOK ROUTE
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

  // 📊 Log messages
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

    // ✂️ Split long responses
    if (reply.length > 1500) {
      const parts = reply.match(/.{1,1500}/g);
      parts.forEach(part => twiml.message(part));
    } else {
      twiml.message(reply);
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

// 🚀 START SERVER
app.listen(3000, () => {
  console.log("Server running on port 3000");
});
