// Crea un cobro en Efipay con el valor EXACTO de la factura pendiente en Zoho.
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
  Object.keys(c.custom_field_hash || {}).forEach((k) => valores.push(c.custom_field_hash[k]));
  Object.keys(c).forEach((k) => { if (k.indexOf("cf_") === 0) valores.push(c[k]); });
  return valores.some((v) => limpiar(v) === cedula);
}

async function buscarCliente(cedula) {
  // 1) Búsqueda directa
  const lista = await zoho("/contacts", { search_text: cedula });
  for (const c of (lista.contacts || []).slice(0, 5)) {
    if (coincide(c, cedula)) return c;
    const d = await zoho(`/contacts/${c.contact_id}`);
    if (d.contact && coincide(d.contact, cedula)) return d.contact;
  }
  // 2) Recorrer los clientes por páginas (hasta 600)
  for (let page = 1; page <= 3; page++) {
    const r = await zoho("/contacts", { page: String(page), per_page: "200" });
    const cs = r.contacts || [];
    const hit = cs.find((c) => coincide(c, cedula));
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

const EFI = process.env.EFIPAY_API_URL || "https://sag.efipay.co/api/v1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, mensaje: "Método no permitido" });
  try {
    const body = JSON.parse(event.body || "{}");
    const cedula = limpiar(body.cedula);
    const numero = String(body.factura || "").trim().slice(0, 50);
    if (!/^\d{5,15}$/.test(cedula) || !numero) {
      return json(400, { ok: false, mensaje: "Datos no válidos." });
    }

    // El valor SIEMPRE se toma de Zoho, nunca de la página.
    const cliente = await buscarCliente(cedula);
    if (!cliente) return json(200, { ok: false, mensaje: "No encontramos esa factura." });
    const inv = await zoho("/invoices", { customer_id: cliente.contact_id, per_page: "25" });
    const f = (inv.invoices || []).find(
      (x) =>
        String(x.invoice_number) === numero &&
        Number(x.balance) > 0 &&
        !["paid", "void", "draft"].includes(x.status)
    );
    if (!f) return json(200, { ok: false, mensaje: "Esa factura ya no está pendiente." });

    const moneda = ["COP", "USD", "EUR"].includes(f.currency_code) ? f.currency_code : "COP";
    const base = process.env.SITE_URL || event.headers.origin || `https://${event.headers.host}`;
    const limite = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

    const pago = {
      payment: {
        description: `Factura ${f.invoice_number} - Internet`,
        amount: Math.round(Number(f.balance) * 100) / 100,
        currency_type: moneda,
        checkout_type: "redirect",
        metadata: { factura: String(f.invoice_number), zoho_invoice_id: String(f.invoice_id) },
      },
      advanced_options: {
        limit_date: limite,
        references: [String(f.invoice_number)],
        result_urls: {
          approved: `${base}/?pago=aprobado`,
          rejected: `${base}/?pago=rechazado`,
          pending: `${base}/?pago=pendiente`,
        },
      },
      office: Number(process.env.EFIPAY_OFFICE_ID),
    };

    const r = await fetch(`${EFI}/payment/generate-payment`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.EFIPAY_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(pago),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.url) {
      console.error("Efipay respondió:", r.status, JSON.stringify(d));
      return json(200, { ok: false, mensaje: "No pudimos iniciar el pago. Intenta de nuevo o escríbenos por WhatsApp." });
    }
    return json(200, { ok: true, url: d.url });
  } catch (e) {
    console.error(e);
    return json(500, { ok: false, mensaje: "No pudimos iniciar el pago en este momento." });
  }
};