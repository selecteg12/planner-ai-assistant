require("dotenv").config({ path: ".env.local" });

console.log("Проверка .env.local:");
console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "ЕСТЬ" : "НЕТ");
console.log("OPENAI_BASE_URL:", process.env.OPENAI_BASE_URL || "НЕТ");

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

async function main() {
  console.log("\nОтправляю запрос в AITUNNEL...");

  const response = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [
      {
        role: "user",
        content: "Привет! Ответь коротко: AITUNNEL работает?",
      },
    ],
  });

  console.log("\nОтвет модели:");
  console.log(response.choices[0].message.content);
}

main().catch((error) => {
  console.error("\nОшибка запроса:");
  console.error(error.message);
});