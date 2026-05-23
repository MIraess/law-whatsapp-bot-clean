const fs = require("fs");
const pdf = require("pdf-parse");

async function parseConstitution() {

  const dataBuffer = fs.readFileSync(
    "./constitution-of-the-federal-republic-of-nigeria.pdf"
  );

  const data = await pdf(dataBuffer);

  const text = data.text;

  // Match sections like:
  // "33. Right to life"
  const sectionRegex =
  /(\d+)\.\s*([^\n]+)\n([\s\S]*?)(?=\n\s*\d+\.\s*[^\n]+|\Z)/g;

  const constitution = {};

  let match;

  while ((match = sectionRegex.exec(text)) !== null) {

    const sectionNumber = match[1];

    const title = match[2].trim();

    const sectionText = match[3]
      .replace(/\s+/g, " ")
      .trim();

    constitution[sectionNumber] = {
      title,
      keywords: [
        title.toLowerCase()
      ],
      text: sectionText
    };
  }

  fs.writeFileSync(
    "./constitution.json",
    JSON.stringify(constitution, null, 2)
  );

  console.log(
    "Constitution JSON generated successfully!"
  );

  console.log(
    `Extracted ${Object.keys(constitution).length} sections.`
  );
}

parseConstitution();