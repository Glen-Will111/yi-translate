// Relays the app's requests to Anthropic so the API key never reaches the phone.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   ANTHROPIC_API_KEY  required
//   APP_PASSCODE       optional. When set, the app must send the same passcode
//                      (entered once in the app's ⚙ Settings), so nobody else who
//                      finds the site address can run up charges on your key.

const MAX_TOKENS_CAP = 2000;

export default async (request) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-app-passcode",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const required = process.env.APP_PASSCODE;
  if (required && request.headers.get("x-app-passcode") !== required) {
    return new Response(JSON.stringify({ error: "Passcode required" }), { status: 401, headers });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY is not set in Netlify" }), { status: 500, headers });
  }

  try {
    const body = await request.json();
    const payload = {
      model: body.model,
      max_tokens: Math.min(Number(body.max_tokens) || 1000, MAX_TOKENS_CAP),
      system: body.system,
      messages: body.messages,
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      return new Response(JSON.stringify({ error: data }), { status: response.status, headers });
    }
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};

export const config = {
  path: "/api/translate",
};
