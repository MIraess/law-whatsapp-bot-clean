const axios = require("axios");
const constitution = require("../constitution.json");

// ================= STATE =================

const conversations = {};
const userProfiles = {};
const pendingFollowUps = {};

// ================= HELPERS =================

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

  return (
    /^(hi|hello|hey|yo|sup|hola)\b/.test(m) ||
    /(good morning|good afternoon|good evening)/.test(m) ||
    /(how are you|how far|what's up|wassup)/.test(m)
  );
}

function isGratitude(msg) {
  return /(thank|thanks|thx|ty)/i.test(msg);
}

function detectIntent(msg) {
  const m = normalize(msg);

  if (isGreeting(m)) return "greeting";
  if (isGratitude(m)) return "gratitude";

  if (/\?$/.test(m)) return "question";

  if (
    /(explain|define|discuss|analyze|compare|what is|why)/i.test(m)
  ) {
    return "academic";
  }

  return "casual";
}

function detectConstitutionSection(msg) {
  const match = msg.match(/section\s+(\d+)/i);

  if (!match) return null;

  return match[1];
}

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

function buildPrompt(profile, intent) {
  let styleInstruction = "";

  if (
    intent === "greeting" ||
    intent === "gratitude" ||
    intent === "casual"
  ) {
    styleInstruction = `
You are a friendly legal assistant.

Reply naturally and conversationally.
Keep responses short.
`;
  } else if (profile.prefersExam) {
    styleInstruction = `
Answer using:

Introduction
Explanation
Conclusion
`;
  } else if (profile.prefersSimple) {
    styleInstruction = `
Explain in simple terms with examples.

Structure:
Introduction
Explanation
Conclusion
`;
  } else {
    styleInstruction = `
Explain clearly and naturally.
`;
  }

  return {
    role: "system",
    content: styleInstruction,
  };
}

function generateSmartFollowUp(reply) {
  const text = reply.toLowerCase();

  if (
    /law|constitution|section|court|case|rights|crime|contract|tort/.test(text)
  ) {
    return {
      text: "⚖️ Would you like a practical example too?",
      type: "legal_followup",
    };
  }

  return {
    text: "😄 Anything else you'd like to know?",
    type: "casual",
  };
}

// ================= MAIN FUNCTION =================

async function processLegalQuery(
  message,
  userId
) {
  updateUserProfile(userId, message);

  const intent =
    detectIntent(message);

  let msg = message;

  const requestedSection =
    detectConstitutionSection(msg);

  if (
    requestedSection &&
    constitution[requestedSection]
  ) {
    msg = `
You are a Nigerian legal assistant.

First quote the constitutional provision exactly as provided.

Then explain it in simple Nigerian legal terms.

Section ${requestedSection}

${constitution[requestedSection]}
`;
  }

  if (!conversations[userId]) {
    conversations[userId] = [];
  }

  conversations[userId].push({
    role: "user",
    content: msg,
  });

  const profile =
    userProfiles[userId];

  const ai = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      max_tokens: 900,
      messages: [
        buildPrompt(profile, intent),
        ...conversations[userId].slice(-6),
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  const reply =
    ai.data.choices[0].message.content;

  const followUp =
    generateSmartFollowUp(reply);

  conversations[userId].push({
    role: "assistant",
    content: reply,
  });

  return {
    reply,
    followUp: followUp.text,
  };
}

module.exports = {
  processLegalQuery,
};