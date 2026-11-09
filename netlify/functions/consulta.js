// Consulta facturas pendientes en Zoho Invoice por número de cliente.
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

const limpiar = (v) => String(v == null ? "" : v).toUpperCase().replace(/[\s.\-]/g, "");

function coincide(c, codigo) {
  const valores = [c.contact_name, c.company_name, c.notes];
  (c.custom_fields || []).forEach((f) => valores.push(f.value));
  Object.keys(c.custom_field_hash || {}).forEach((k) => valores.push(c.custom_field_hash[k]));
  Object.keys(c).forEach((k) => { if (k.indexOf("cf_") === 0) valores.push(c[k]); });
  return valores.some((v) => limpiar(v) === codigo);
}

async function buscarCliente(codigo) {
  // 1) Búsqueda directa
  const lista = await zoho("/contacts", { search_text: codigo });
  for (const c of (lista.contacts || []).slice(0, 5)) {
    if (coincide(c, codigo)) return c;
    const d = await zoho(`/contacts/${c.contact_id}`);
    if (d.contact && coincide(d.contact, codigo)) return d.contact;
  }
  // 2) Recorrer los clientes por páginas (hasta 600)
  for (let page = 1; page <= 3; page++) {
    const r = await zoho("/contacts", { page: String(page), per_page: "200" });
    const cs = r.contacts || [];
    const hit = cs.find((c) => coincide(c, codigo));
    if (hit) return hit;
    if (cs.length < 200) break;
  }
  return null;
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
    const { cliente: raw } = JSON.parse(event.body || "{}");
    const codigo = limpiar(raw);
    if (!/^[A-Z0-9]{3,20}$/.test(codigo)) return json(400, { ok: false, mensaje: "Número de cliente no válido." });

    const noEncontrado = {
      ok: false,
      mensaje: "No encontramos facturas con esos datos. Revisa tu número de cliente o escríbenos por WhatsApp.",
    };

    // 1) Buscar al cliente
    const cliente = await buscarCliente(codigo);
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
