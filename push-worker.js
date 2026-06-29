// ══════════════════════════════════════════════════════════════════════════════
// El Hórreo — Push Sender + Cron Alertas (Cloudflare Worker)
//
// Variables de entorno requeridas (Cloudflare Dashboard → Worker → Settings):
//   VAPID_PUBLIC_KEY   — clave pública VAPID
//   VAPID_PRIVATE_KEY  — clave privada VAPID
//   VAPID_SUBJECT      — mailto:salvarado.snag@gmail.com
//   SUPABASE_URL       — https://xxxx.supabase.co
//   SUPABASE_KEY       — service_role key
//   WORKER_SECRET      — clave que pones tú (solo la app puede llamar al worker)
//   TG_BOT_TOKEN       — (opcional) token del bot de Telegram para alertas
//   TG_CHAT_ID         — (opcional) chat ID destino para alertas
//
// Cron Trigger: agregar en Cloudflare Dashboard → Worker → Triggers → Cron
//   Recomendado: "*/10 * * * *"  (cada 10 minutos)
// ══════════════════════════════════════════════════════════════════════════════

// ── Configuración estática de marcas y locales (espejo de la app) ─────────────
const MARCAS_CFG = {
  doggis:      { nombre: "Doggis"       },
  heladeria:   { nombre: "Heladería"    },
  tommy_zf:    { nombre: "Tommy ZF"     },
  tommy_eu:    { nombre: "Tommy EU"     },
  juanmaestro: { nombre: "Juan Maestro" },
  popcorn:     { nombre: "Pop Corn"     },
};

const LOCALES_BASE = [
  { nombre: "Juan Maestro - Zona Franca Punta Arenas",         marca: "juanmaestro" },
  { nombre: "Doggis - Espacio Urbano Pionero Punta Arenas",    marca: "doggis"      },
  { nombre: "Doggis - Heladeria Espacio Urbano Punta Arenas",  marca: "heladeria"   },
  { nombre: "Tommy Beans - Espacio Urbano Pionero 2",          marca: "tommy_eu"    },
  { nombre: "Tommy Beans - Zona Franca Punta Arenas",          marca: "tommy_zf"    },
];

const NOMBRES_CORTOS = {
  "Juan Maestro - Zona Franca Punta Arenas":         "JM · Zona Franca",
  "Doggis - Espacio Urbano Pionero Punta Arenas":    "Doggis · Esp. Urbano",
  "Doggis - Heladeria Espacio Urbano Punta Arenas":  "Heladería · Esp. Urbano",
  "Tommy Beans - Espacio Urbano Pionero 2":          "Tommy · Esp. Urbano",
  "Tommy Beans - Zona Franca Punta Arenas":          "Tommy · Zona Franca",
};

function corto(nombre) {
  return NOMBRES_CORTOS[nombre] || nombre.split(" - ").slice(1).join(" - ") || nombre;
}

function today(tz = "America/Punta_Arenas") {
  return new Date().toLocaleDateString("sv-SE", { timeZone: tz });
}

function horaLocal(tz = "America/Punta_Arenas") {
  return parseInt(new Date().toLocaleTimeString("es-CL", { timeZone: tz, hour: "2-digit", hour12: false }));
}

// ── Dedup en KV (evita reenviar la misma alerta) ─────────────────────────────
// Usa KV binding "HORREO_KV". Si no está configurado, cae silencioso (sin dedup).
async function dedupGet(env, key) {
  try { return await env.HORREO_KV?.get(key); } catch { return null; }
}
async function dedupSet(env, key, ttlSeconds = 86400) {
  try { await env.HORREO_KV?.put(key, "1", { expirationTtl: ttlSeconds }); } catch {}
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function sbGet(env, tabla, filtros = "") {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${tabla}?select=*${filtros ? "&" + filtros : ""}`, {
    headers: {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tgSend(env, texto) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: texto, parse_mode: "HTML" }),
    });
  } catch {}
}

// ── Lógica de alertas ─────────────────────────────────────────────────────────
async function runAlertas(env) {
  const fechaHoy  = today();
  const hora      = horaLocal();
  const mesActual = fechaHoy.slice(0, 7);

  // Cargar datos del día desde Supabase (solo fecha de hoy para eficiencia)
  const [ventasHoy, kpisHoy] = await Promise.all([
    sbGet(env, "ventas",  `fecha=eq.${fechaHoy}`),
    sbGet(env, "kpis",    `fecha=eq.${fechaHoy}`),
  ]);

  const resultados = [];

  for (const [marcaKey, marcaCfg] of Object.entries(MARCAS_CFG)) {
    const nombreMarca  = marcaCfg.nombre;
    const localesMarca = LOCALES_BASE.filter(l => l.marca === marcaKey).map(l => l.nombre);
    if (!localesMarca.length) continue;

    const ventasMarca = ventasHoy.filter(v => v.marca === marcaKey);

    // ── 1. Sin venta registrada — después de las 18h ──────────────────────
    if (hora >= 18) {
      const key = `sinventa_${marcaKey}_${fechaHoy}`;
      if (!await dedupGet(env, key)) {
        const conVenta = new Set(ventasMarca.map(v => v.local));
        const sinVenta = localesMarca.filter(l => !conVenta.has(l));
        if (sinVenta.length > 0) {
          const body = sinVenta.map(corto).join(", ");
          const texto = `⏰ <b>El Hórreo — ${nombreMarca}</b>\nSin venta registrada (${hora}:00h):\n` +
            sinVenta.map(l => `• ${corto(l)}`).join("\n");
          await tgSend(env, texto);
          await sendPushToAll(env, `⏰ Sin venta — ${nombreMarca}`, body, "sin_venta");
          await dedupSet(env, key, 6 * 3600); // no repetir en 6h
          resultados.push(`sinventa:${marcaKey}`);
        }
      }
    }

    // ── 2. Corte 16:00 sin registrar — entre 16h y 20h ───────────────────
    if (hora >= 16 && hora < 20) {
      const key = `corte16_${marcaKey}_${fechaHoy}`;
      if (!await dedupGet(env, key)) {
        const conCorte = new Set(
          ventasMarca.filter(v => v.turno === "Corte 16:00").map(v => v.local)
        );
        const sinCorte = localesMarca.filter(l => !conCorte.has(l));
        if (sinCorte.length > 0) {
          const body = sinCorte.map(corto).join(", ");
          const texto = `⏰ <b>El Hórreo — ${nombreMarca}</b>\nCorte 16:00 sin registrar:\n` +
            sinCorte.map(l => `• ${corto(l)}`).join("\n");
          await tgSend(env, texto);
          await sendPushToAll(env, `⏰ Corte 16:00 sin registrar — ${nombreMarca}`, body, "corte16");
          await dedupSet(env, key, 4 * 3600);
          resultados.push(`corte16:${marcaKey}`);
        }
      }
    }

    // ── 3. KPI crítico — KDS > umbral, 1 vez por marca+día ───────────────
    const kpiKey = `kpicrit_${marcaKey}_${fechaHoy}`;
    if (!await dedupGet(env, kpiKey)) {
      const KDS_UMBRAL = 8; // minutos
      const kpisMarca = kpisHoy.filter(k => k.marca === marcaKey);
      const criticos = kpisMarca.filter(k => parseFloat(k.kds_prom || 0) > KDS_UMBRAL);
      if (criticos.length > 0) {
        const resumen = criticos.map(k =>
          `• ${corto(k.local)}: KDS ${parseFloat(k.kds_prom).toFixed(1)}m`
        ).join("\n");
        const body = criticos.map(k => `${corto(k.local)}: KDS ${parseFloat(k.kds_prom).toFixed(1)}m`).join(" | ");
        const texto = `🔔 <b>El Hórreo — ${nombreMarca}</b>\nKDS alto (>${KDS_UMBRAL}min):\n${resumen}`;
        await tgSend(env, texto);
        await sendPushToAll(env, `🔔 KDS alto — ${nombreMarca}`, body, "kpi_critico");
        await dedupSet(env, kpiKey, 12 * 3600);
        resultados.push(`kpicrit:${marcaKey}`);
      }
    }

    // ── 4. Resumen diario — 1 vez por día al cierre (entre 22h y 23h) ────
    if (hora >= 22 && hora < 23) {
      const resKey = `resumen_${marcaKey}_${fechaHoy}`;
      if (!await dedupGet(env, resKey)) {
        if (ventasMarca.length > 0) {
          const totalBruta = ventasMarca.reduce((s, v) => s + parseFloat(v.venta_bruta || 0), 0);
          const totalBoletas = ventasMarca.reduce((s, v) => s + parseFloat(v.boletas || 0), 0);
          const fmtCLP = n => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
          const texto = `📊 <b>El Hórreo — ${nombreMarca}</b>\nResumen ${fechaHoy}\n` +
            `💰 Venta bruta: <b>${fmtCLP(totalBruta)}</b>\n` +
            `🧾 Boletas: ${totalBoletas}\n` +
            ventasMarca.map(v => `• ${corto(v.local)}: ${fmtCLP(parseFloat(v.venta_bruta || 0))}`).join("\n");
          await tgSend(env, texto);
          await sendPushToAll(env, `📊 Resumen ${nombreMarca} — ${fechaHoy}`,
            `Venta: ${fmtCLP(totalBruta)} · ${totalBoletas} boletas`, "resumen_dia");
          await dedupSet(env, resKey, 25 * 3600);
          resultados.push(`resumen:${marcaKey}`);
        }
      }
    }
  }

  return resultados;
}

// ── Enviar push a todos los suscriptores ──────────────────────────────────────
async function sendPushToAll(env, title, body, tag) {
  const subs = await getSubscriptions(env);
  if (!subs.length) return { sent: 0 };
  const results = await Promise.allSettled(
    subs.map(sub => sendPush(env, sub, { title, body, tag, data: { url: "/" } }))
  );
  const sent    = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
  const expired = results
    .filter(r => r.status === "fulfilled" && r.value?.expired)
    .map(r => r.value.endpoint);
  if (expired.length) await removeExpired(env, expired);
  return { sent, failed: results.length - sent };
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════
export default {
  // ── HTTP requests ──────────────────────────────────────────────────────────
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // ── POST /send — enviar push manual desde la app ─────────────────────
    if (request.method === "POST" && url.pathname === "/send") {
      const auth = request.headers.get("x-worker-secret");
      if (auth !== env.WORKER_SECRET) return json({ ok: false, error: "Unauthorized" }, 401);

      const body = await request.json().catch(() => ({}));
      const { title, message, tag, url: notifUrl } = body;
      if (!title || !message) return json({ ok: false, error: "title y message requeridos" }, 400);

      const subs = await getSubscriptions(env);
      if (!subs.length) return json({ ok: true, sent: 0, msg: "Sin suscriptores" });

      const results = await Promise.allSettled(
        subs.map(sub => sendPush(env, sub, { title, body: message, tag: tag || "horreo", data: { url: notifUrl || "/" } }))
      );
      const sent    = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
      const failed  = results.length - sent;
      const expired = results.filter(r => r.status === "fulfilled" && r.value?.expired).map(r => r.value.endpoint);
      if (expired.length) await removeExpired(env, expired);
      return json({ ok: true, sent, failed });
    }

    // ── POST /subscribe ──────────────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/subscribe") {
      const body = await request.json().catch(() => null);
      if (!body?.endpoint || !body?.keys) return json({ ok: false, error: "Suscripción inválida" }, 400);
      const saved = await saveSubscription(env, body);
      return json({ ok: saved });
    }

    // ── DELETE /unsubscribe ───────────────────────────────────────────────
    if (request.method === "DELETE" && url.pathname === "/unsubscribe") {
      const body = await request.json().catch(() => null);
      if (!body?.endpoint) return json({ ok: false, error: "endpoint requerido" }, 400);
      await removeExpired(env, [body.endpoint]);
      return json({ ok: true });
    }

    // ── GET /cron — trigger manual para testing ───────────────────────────
    if (request.method === "GET" && url.pathname === "/cron") {
      const auth = request.headers.get("x-worker-secret");
      if (auth !== env.WORKER_SECRET) return json({ ok: false, error: "Unauthorized" }, 401);
      const res = await runAlertas(env);
      return json({ ok: true, alertas: res, hora: horaLocal(), fecha: today() });
    }

    return json({ ok: false, error: "Ruta no encontrada" }, 404);
  },

  // ── Cron Trigger — se ejecuta según el schedule configurado en Cloudflare ──
  // Para activar: Cloudflare Dashboard → Worker → Triggers → Cron Triggers
  // Schedule recomendado: "*/10 * * * *"
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlertas(env));
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-worker-secret",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ── Supabase: suscripciones push ──────────────────────────────────────────────
async function getSubscriptions(env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
    headers: {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
    },
  });
  if (!res.ok) return [];
  const rows = await res.json();
  return rows.map(r => typeof r.data === "string" ? JSON.parse(r.data) : r.data);
}

async function saveSubscription(env, sub) {
  const id = btoa(sub.endpoint).slice(0, 64).replace(/[^a-zA-Z0-9]/g, "_");
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/push_subscriptions`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ id, data: sub }),
  });
  return res.ok;
}

async function removeExpired(env, endpoints) {
  for (const ep of endpoints) {
    const id = btoa(ep).slice(0, 64).replace(/[^a-zA-Z0-9]/g, "_");
    await fetch(`${env.SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${id}`, {
      method: "DELETE",
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`,
      },
    });
  }
}

// ── Web Push (VAPID) ──────────────────────────────────────────────────────────
async function sendPush(env, subscription, payload) {
  const endpoint = subscription.endpoint;
  const p256dh   = subscription.keys?.p256dh;
  const auth     = subscription.keys?.auth;
  if (!endpoint || !p256dh || !auth) return { ok: false };

  try {
    const jwt = await buildVapidJWT(env, endpoint);
    const encrypted = await encryptPayload(payload, p256dh, auth);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization:      `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
        "Content-Type":     "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL:                "86400",
      },
      body: encrypted,
    });
    if (res.status === 410 || res.status === 404) return { ok: false, expired: true, endpoint };
    return { ok: res.ok || res.status === 201 };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

async function buildVapidJWT(env, endpoint) {
  const origin  = new URL(endpoint).origin;
  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64url(JSON.stringify({ aud: origin, exp: now + 43200, sub: env.VAPID_SUBJECT }));
  const signing = `${header}.${payload}`;
  const rawKey  = base64urlDecode(env.VAPID_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    "raw", rawKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signing)
  );
  return `${signing}.${b64url(sig)}`;
}

async function encryptPayload(payload, p256dhB64, authB64) {
  const encoder       = new TextEncoder();
  const p256dh        = base64urlDecode(p256dhB64);
  const authBytes     = base64urlDecode(authB64);
  const ephemeralKey  = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
  const ephemeralPublicRaw = await crypto.subtle.exportKey("raw", ephemeralKey.publicKey);
  const receiverPublicKey  = await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: receiverPublicKey }, ephemeralKey.privateKey, 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk  = await hkdfExtract(authBytes, sharedBits, p256dh, new Uint8Array(ephemeralPublicRaw));
  const contentKey = await hkdfExpand(prk, "Content-Encoding: aes128gcm\x00", 16);
  const nonce      = await hkdfExpand(prk, "Content-Encoding: nonce\x00", 12);
  const aesKey = await crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const data   = encoder.encode(JSON.stringify(payload));
  const padded = new Uint8Array(data.length + 1);
  padded[0] = 0x02;
  padded.set(data, 1);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded);
  const rs    = 4096;
  const keyId = new Uint8Array(ephemeralPublicRaw);
  const hdr   = new Uint8Array(16 + 4 + 1 + keyId.length);
  hdr.set(salt, 0);
  new DataView(hdr.buffer).setUint32(16, rs, false);
  hdr[20] = keyId.length;
  hdr.set(keyId, 21);
  const result = new Uint8Array(hdr.length + ciphertext.byteLength);
  result.set(hdr, 0);
  result.set(new Uint8Array(ciphertext), hdr.length);
  return result;
}

async function hkdfExtract(salt, ikm, receiverPublic, senderPublic) {
  const saltKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = await crypto.subtle.sign("HMAC", saltKey, ikm);
  const prkKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const infoBytes = new Uint8Array([...new TextEncoder().encode("WebPush: info\x00"), ...new Uint8Array(receiverPublic), ...senderPublic, 0x01]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, infoBytes));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const t   = new Uint8Array([...new TextEncoder().encode(info), 0x01]);
  const result = await crypto.subtle.sign("HMAC", key, t);
  return new Uint8Array(result).slice(0, length);
}

function b64url(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let str = "";
  bytes.forEach(b => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlDecode(str) {
  const padded = str + "=".repeat((4 - str.length % 4) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
