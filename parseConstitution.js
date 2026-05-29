const fs = require("fs");

function parseConstitution() {
  const text = fs.readFileSync("rawText.txt", "utf8");

  const constitution = {};

  // Match ONLY actual section headings
  const regex = /Section\s+(\d+)\.\s([\s\S]*?)(?=Section\s+\d+\.|$)/g;

  let match;

  while ((match = regex.exec(text)) !== null) {
    const sectionNumber = match[1];
    const sectionContent = match[2].trim();

    constitution[sectionNumber] = sectionContent;
  }

  fs.writeFileSync(
    "constitution.json",
    JSON.stringify(constitution, null, 2)
  );

  console.log(
    `Constitution JSON generated successfully!\nExtracted ${
      Object.keys(constitution).length
    } sections.`
  );

  console.log("\nSECTION 33:\n");
  console.log(constitution["33"]?.slice(0, 500));

  console.log("\nSECTION 44:\n");
  console.log(constitution["44"]?.slice(0, 500));
}

parseConstitution();