// Consulta facturas pendientes en Zoho Invoice por cédula.
// Las credenciales se guardan como variables de entorno en Netlify (nunca en la página).

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const API = process.env.ZOHO_API_URL || "https://www.zohoapis.com/invoice/v3";
const ORG = process.env.ZOHO_ORG_ID;

let cache = { token: null, exp: 0 };

async function getToken() {
  if (cache.token && Date.now() < cache.exp) return cache.token;
  const p = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token?${p}`, { method: "POST" });
  const j = await r.json();
  if (!j.access_token) throw new Error("No se obtuvo token de Zoho");
  cache = { token: j.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return cache.token;
}

async function zoho(path, params = {}) {
  const t = await getToken();
  const q = new URLSearchParams({ organization_id: ORG, ...params });
  const r = await fetch(`${API}${path}?${q}`, {
    headers: { Authorization: `Zoho-oauthtoken ${t}` },
  });
  return r.json();
}

const limpiar = (v) => String(v == null ? "" : v).replace(/[.\s-]/g, "");

function coincide(c, cedula) {
  const valores = [c.contact_name, c.company_name, c.notes];
  (c.custom_fields || []).forEach((f) => valores.push(f.value));
  return valores.some((v) => limpiar(v) === cedula);
}

function enmascarar(nombre) {
  return String(nombre || "cliente")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w : w[0] + "***"))
    .join(" ");
}

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, mensaje: "Método no permitido" });
  try {
    const { cedula: raw } = JSON.parse(event.body || "{}");
    const cedula = limpiar(raw);
    if (!/^\d{5,15}$/.test(cedula)) return json(400, { ok: false, mensaje: "Cédula no válida." });

    const noEncontrado = {
      ok: false,
      mensaje: "No encontramos facturas con esos datos. Revisa tu cédula o escríbenos por WhatsApp.",
    };

    // 1) Buscar al cliente
    const lista = await zoho("/contacts", { search_text: cedula });
    const candidatos = (lista.contacts || []).slice(0, 5);
    let cliente = null;
    for (const c of candidatos) {
      const d = await zoho(`/contacts/${c.contact_id}`);
      if (d.contact && coincide(d.contact, cedula)) { cliente = d.contact; break; }
    }
    if (!cliente) return json(200, noEncontrado);

    // 2) Traer sus facturas pendientes
    const inv = await zoho("/invoices", { customer_id: cliente.contact_id, per_page: "25" });
    const pendientes = (inv.invoices || [])
      .filter((f) => Number(f.balance) > 0 && !["paid", "void", "draft"].includes(f.status))
      .slice(0, 5)
      .map((f) => ({
        numero: f.invoice_number,
        valor: f.balance,
        vence: f.due_date,
        estado: f.status,
        url: f.invoice_url || "",
        moneda: f.currency_code,
      }));

    if (!pendientes.length) {
      return json(200, { ok: false, mensaje: "No tienes facturas pendientes. ¡Gracias por estar al día!" });
    }
    return json(200, { ok: true, nombre: enmascarar(cliente.contact_name), facturas: pendientes });
  } catch (e) {
    console.error(e);
    return json(500, { ok: false, mensaje: "No pudimos consultar en este momento. Intenta más tarde." });
  }
};