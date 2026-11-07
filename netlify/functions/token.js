exports.handler = async (event) => {
  const code = (event.queryStringParameters || {}).code;
  if (!code) return { statusCode: 400, body: "Falta el código" };
  const p = new URLSearchParams({
    code,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "authorization_code",
  });
  const r = await fetch("https://accounts.zoho.com/oauth/v2/token?" + p, { method: "POST" });
  const t = await r.text();
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: t,
  };
};
