// ══════════════════════════════════════════════════════════════════════════════
// El Hórreo — Push Sender (Cloudflare Worker)
// Recibe llamadas desde la app o cron y envía Web Push a todos los suscritos
//
// Variables de entorno requeridas (Cloudflare Dashboard → Worker → Settings):
//   VAPID_PUBLIC_KEY   = BOuRFCmR3bE6ooZYbsuNUjeHcLwt09a_0wc1ECsHXtylzkLZbvUWkJRFm5ypuRNmCAKTCIrWt2DuiFeii2bTgKw
//   VAPID_PRIVATE_KEY  = p-Rk4puiLasfJb7AqCIFvRBSgunzs23HIebpjeFKVsc
//   VAPID_SUBJECT      = mailto:salvarado.snag@gmail.com
//   SUPABASE_URL       = https://xxxx.supabase.co
//   SUPABASE_KEY       = (service_role key)
//   WORKER_SECRET      = (clave que pones tú, para que solo la app pueda llamar al worker)
// ══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // ── POST /send — enviar push a todos los suscritos ──────────────────────
    if (request.method === "POST" && url.pathname === "/send") {
      // Verificar secret
      const auth = request.headers.get("x-worker-secret");
      if (auth !== env.WORKER_SECRET) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      const body = await request.json().catch(() => ({}));
      const { title, message, tag, url: notifUrl } = body;

      if (!title || !message) return json({ ok: false, error: "title y message requeridos" }, 400);

      // Obtener suscripciones desde Supabase
      const subs = await getSubscriptions(env);
      if (!subs.length) return json({ ok: true, sent: 0, msg: "Sin suscriptores" });

      // Enviar push a cada suscripción
      const results = await Promise.allSettled(
        subs.map(sub => sendPush(env, sub, { title, body: message, tag: tag || "horreo", data: { url: notifUrl || "/" } }))
      );

      const sent     = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
      const failed   = results.length - sent;
      const expired  = results
        .filter(r => r.status === "fulfilled" && r.value?.expired)
        .map(r => r.value.endpoint);

      // Limpiar suscripciones expiradas
      if (expired.length) await removeExpired(env, expired);

      return json({ ok: true, sent, failed, expired: expired.length });
    }

    // ── POST /subscribe — registrar nueva suscripción ───────────────────────
    if (request.method === "POST" && url.pathname === "/subscribe") {
      const body = await request.json().catch(() => null);
      if (!body?.endpoint || !body?.keys) return json({ ok: false, error: "Suscripción inválida" }, 400);

      const saved = await saveSubscription(env, body);
      return json({ ok: saved });
    }

    // ── DELETE /unsubscribe — eliminar suscripción ──────────────────────────
    if (request.method === "DELETE" && url.pathname === "/unsubscribe") {
      const body = await request.json().catch(() => null);
      if (!body?.endpoint) return json({ ok: false, error: "endpoint requerido" }, 400);
      await removeExpired(env, [body.endpoint]);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Ruta no encontrada" }, 404);
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const endpoint  = subscription.endpoint;
  const p256dh    = subscription.keys?.p256dh;
  const auth      = subscription.keys?.auth;

  if (!endpoint || !p256dh || !auth) return { ok: false };

  try {
    // Generar JWT VAPID
    const jwt = await buildVapidJWT(env, endpoint);

    // Cifrar el payload con Web Push Encryption (RFC 8291)
    const encrypted = await encryptPayload(payload, p256dh, auth);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization:     `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
        "Content-Type":    "application/octet-stream",
        "Content-Encoding":"aes128gcm",
        TTL:               "86400",
      },
      body: encrypted,
    });

    if (res.status === 410 || res.status === 404) {
      return { ok: false, expired: true, endpoint };
    }
    return { ok: res.ok || res.status === 201 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function buildVapidJWT(env, endpoint) {
  const origin = new URL(endpoint).origin;
  const now    = Math.floor(Date.now() / 1000);

  const header  = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64url(JSON.stringify({ aud: origin, exp: now + 43200, sub: env.VAPID_SUBJECT }));
  const signing  = `${header}.${payload}`;

  // Importar clave privada VAPID
  const rawKey = base64urlDecode(env.VAPID_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    "raw", rawKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signing)
  );

  return `${signing}.${b64url(sig)}`;
}

async function encryptPayload(payload, p256dhB64, authB64) {
  const payloadText = JSON.stringify(payload);
  const encoder     = new TextEncoder();

  // Claves del receptor
  const p256dh = base64urlDecode(p256dhB64);
  const authBytes = base64urlDecode(authB64);

  // Generar par de claves efímeras
  const ephemeralKey = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true, ["deriveKey", "deriveBits"]
  );

  // Exportar clave pública efímera (sin comprimir)
  const ephemeralPublicRaw = await crypto.subtle.exportKey("raw", ephemeralKey.publicKey);

  // Importar clave pública del receptor
  const receiverPublicKey = await crypto.subtle.importKey(
    "raw", p256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );

  // Derivar shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiverPublicKey },
    ephemeralKey.privateKey, 256
  );

  // Salt aleatorio (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF para derivar clave de contenido y nonce (RFC 8291)
  const prk = await hkdfExtract(authBytes, sharedBits, p256dh, new Uint8Array(ephemeralPublicRaw));

  const contentKey = await hkdfExpand(prk, "Content-Encoding: aes128gcm\x00", 16);
  const nonce      = await hkdfExpand(prk, "Content-Encoding: nonce\x00", 12);

  // Cifrar con AES-GCM
  const aesKey = await crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["encrypt"]);

  // Padding: 1 byte de delimitador (0x02) + contenido
  const data    = encoder.encode(payloadText);
  const padded  = new Uint8Array(data.length + 1);
  padded[0] = 0x02;
  padded.set(data, 1);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey, padded
  );

  // Construir mensaje RFC 8291: salt(16) + rs(4=4096) + idlen(1) + key_id + ciphertext
  const rs     = 4096;
  const keyId  = new Uint8Array(ephemeralPublicRaw);
  const header = new Uint8Array(16 + 4 + 1 + keyId.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = keyId.length;
  header.set(keyId, 21);

  const result = new Uint8Array(header.length + ciphertext.byteLength);
  result.set(header, 0);
  result.set(new Uint8Array(ciphertext), header.length);
  return result;
}

async function hkdfExtract(salt, ikm, receiverPublic, senderPublic) {
  // Construir info para HKDF según RFC 8291
  const info = buildInfo("P-256", receiverPublic, senderPublic);
  const saltKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = await crypto.subtle.sign("HMAC", saltKey, ikm);

  // Expandir con info
  const prkKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const infoBytes = new Uint8Array([...new TextEncoder().encode("WebPush: info\x00"), ...new Uint8Array(receiverPublic), ...senderPublic, 0x01]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, infoBytes));
}

function buildInfo(curve, receiverKey, senderKey) {
  const enc = new TextEncoder();
  const curveBytes = enc.encode(curve);
  const info = new Uint8Array(18 + curveBytes.length + 2 + receiverKey.length + 2 + senderKey.length);
  let offset = 0;
  const header = enc.encode("WebPush: info\x00");
  info.set(header, offset); offset += header.length;
  new DataView(info.buffer).setUint16(offset, receiverKey.length, false); offset += 2;
  info.set(new Uint8Array(receiverKey), offset); offset += receiverKey.length;
  new DataView(info.buffer).setUint16(offset, senderKey.length, false); offset += 2;
  info.set(senderKey, offset);
  return info;
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const infoBytes = new TextEncoder().encode(info);
  const t = new Uint8Array([...infoBytes, 0x01]);
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
