require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: true }));

// 🧠 Simple in-memory rate limiter
const userLimits = {};

function isRateLimited(user) {
  const now = Date.now();

  if (!userLimits[user]) {
    userLimits[user] = { count: 1, time: now };
    return false;
  }

  const diff = now - userLimits[user].time;

  // reset after 30 seconds
  if (diff > 30000) {
    userLimits[user] = { count: 1, time: now };
    return false;
  }

  userLimits[user].count++;

  return userLimits[user].count > 5; // max 5 messages per 30 seconds
}

// 🧠 Mode handler
function getModePrompt(message) {
  if (message.startsWith("/exam")) {
    return {
      role: "system",
      content:
        "You are a Nigerian law lecturer and examiner. Answer strictly using IRAC:
-Issue
Rule (state relevant legal principles and Nigerian authorities where possible)
Application (apply law clearly to facts or scenario)
Conclusion
Your tone must be formal, precise, and exam-standard.
Where applicable, reference Nigerian cases, statutes, or common law principles used in Nigerian courts.
Avoid vague explanations. Be direct and analytical.
End every answer with: "This is for educational purposes only, not legal advice."",
    };
  }

  if (message.startsWith("/simple")) {
    return {
      role: "system",
      content:
        "You are a Nigerian law tutor.
Explain legal concepts in very simple terms as if teaching a 100-level law student.
Use:
- clear language
- relatable examples
- step-by-step explanations
Avoid unnecessary legal jargon
End every answer with 'This is for educational purposes only, not legal advice.'",
    };
  }

  if (message.startsWith("/argue")) {
    return {
      role: "system",
      content:
        "You are a Nigerian lawyer in a moot court competition.
Present strong, persuasive legal arguments.
Structure your answer like courtroom submissions:
- Clear position
- Supporting legal principles
- Authorities where relevant
- Convincing reasoning
Sound confident, logical, and assertive.
End every answer with 'This is for educational purposes only, not legal advice.'",
    };
  }

  return {
    role: "system",
    content:
      "You are a Nigerian law tutor. Explain clearly and concisely. Always end with 'for educational purposes only, not legal advice.'",
  };
}

app.post("/webhook", async (req, res) => {
  let userMessage = req.body.Body;
  const userNumber = req.body.From;

  // 🔒 Rate limiting check
  if (isRateLimited(userNumber)) {
    res.set("Content-Type", "text/xml");
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

  userMessage = userMessage.replace(/\/exam|\/simple|\/argue/, "").trim();

  try {
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 300,
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

    const reply = aiResponse.data.choices[0].message.content;

    res.set("Content-Type", "text/xml");
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  } catch (error) {
    console.error(error.response?.data || error.message);

    res.set("Content-Type", "text/xml");
    res.send(`
      <Response>
        <Message>Sorry, something went wrong.</Message>
      </Response>
    `);
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
