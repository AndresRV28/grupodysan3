// Recibe el aviso de Efipay y, si el pago fue aprobado, registra el pago en Zoho Invoice
// (medio de pago: transferencia bancaria). La factura queda en "Pagada" si el pago la cubre.

const crypto = require("crypto");

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

async function zohoGet(path) {
  const t = await getToken();
  const r = await fetch(`${API}${path}?organization_id=${ORG}`, {
    headers: { Authorization: `Zoho-oauthtoken ${t}` },
  });
  return r.json();
}

async function zohoPost(path, body) {
  const t = await getToken();
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${t}`,
      "Content-Type": "application/json",
      "X-com-zoho-invoice-organizationid": ORG,
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

const resp = (code, text) => ({ statusCode: code, body: text });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, "Método no permitido");

  // 1) Verificar la firma sobre el cuerpo CRUDO
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");
  const esperada = crypto
    .createHmac("sha256", process.env.EFIPAY_WEBHOOK_TOKEN || "")
    .update(raw)
    .digest("hex");
  const recibida = String((event.headers || {}).signature || "").trim();
  if (
    !process.env.EFIPAY_WEBHOOK_TOKEN ||
    recibida.length !== esperada.length ||
    !crypto.timingSafeEqual(Buffer.from(recibida), Buffer.from(esperada))
  ) {
    return resp(403, "Firma no válida");
  }

  try {
    const p = JSON.parse(raw.toString("utf8"));
    const tipo = p.meta && p.meta.event_type;
    const t = p.transaction || {};

    // 2) Solo pagos aprobados
    if (tipo !== "transaction.status_changed" || t.status_key !== "approved") {
      return resp(200, "Ignorado");
    }
    // Los pagos de prueba NO se registran en Zoho (a menos que lo actives)
    if (t.production !== true && process.env.ALLOW_TEST_PAYMENTS !== "true") {
      console.log("Pago de prueba ignorado:", t.transaction_id);
      return resp(200, "Prueba ignorada");
    }

    // 3) Identificar la factura (la guardamos en metadata al crear el cobro)
    const md = (p.checkout && p.checkout.payment_referenceable && p.checkout.payment_referenceable.metadata) || {};
    const invoiceId = String(md.zoho_invoice_id || "");
    if (!/^\d+$/.test(invoiceId)) {
      console.error("Pago aprobado sin zoho_invoice_id. transaction_id:", t.transaction_id);
      return resp(200, "Sin factura asociada");
    }

    // 4) Leer la factura en Zoho (así el valor nunca depende solo del aviso)
    const inv = (await zohoGet(`/invoices/${invoiceId}`)).invoice;
    if (!inv) throw new Error("No se encontró la factura en Zoho");
    if (Number(inv.balance) <= 0 || inv.status === "paid" || inv.status === "void") {
      return resp(200, "La factura ya estaba pagada"); // también cubre reintentos duplicados
    }
    if (inv.currency_code && t.currency_type && inv.currency_code !== t.currency_type) {
      console.error("Moneda distinta", inv.currency_code, t.currency_type);
    }

    const monto = Math.round(Math.min(Number(t.amount), Number(inv.balance)) * 100) / 100;
    const fecha = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10); // hora de Colombia

    // 5) Registrar el pago como transferencia bancaria
    const r = await zohoPost("/customerpayments", {
      customer_id: inv.customer_id,
      payment_mode: "banktransfer",
      amount: monto,
      date: fecha,
      reference_number: `EFIPAY-${t.transaction_id}`,
      description: `Pago en línea Efipay - transacción ${t.transaction_id}`,
      invoices: [{ invoice_id: invoiceId, amount_applied: monto }],
    });
    if (r.code !== 0) {
      console.error("Zoho rechazó el pago:", JSON.stringify(r));
      return resp(500, "Error al registrar en Zoho"); // Efipay reintenta
    }
    console.log("Pago registrado en Zoho. Factura:", inv.invoice_number, "Monto:", monto);
    return resp(200, "Registrado");
  } catch (e) {
    console.error(e);
    return resp(500, "Error"); // Efipay reintenta
  }
};
