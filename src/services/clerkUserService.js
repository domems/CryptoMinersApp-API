// services/clerkUserService.js
import fetch from "node-fetch";

// ===== Config =====
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  console.warn("⚠️ CLERK_SECRET_KEY não definido — chamadas à Clerk API irão falhar.");
}

// Permite trocar o host se precisares (clerk.com vs clerk.dev)
const CLERK_API_BASE =
  process.env.CLERK_API_BASE_URL?.replace(/\/+$/, "") || "https://api.clerk.dev";

// TTL de cache em memória (ms)
const CACHE_TTL_MS = Number(process.env.CLERK_CACHE_TTL_MS || 60_000);

// ===== Cache simples em memória =====
const _cache = new Map(); // key -> { data, exp }

const now = () => Date.now();
function getCached(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.exp < now()) {
    _cache.delete(key);
    return null;
  }
  return hit.data;
}
function setCached(key, data, ttlMs = CACHE_TTL_MS) {
  _cache.set(key, { data, exp: now() + ttlMs });
}

// ===== Helpers HTTP =====
async function clerkFetch(path, { timeoutMs = 10_000 } = {}) {
  const url = `${CLERK_API_BASE}${path}`;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${CLERK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      const e = new Error("Resposta inesperada da Clerk API");
      e.status = 502;
      e.responseBody = raw;
      throw e;
    }

    if (!res.ok) {
      const message =
        (data && (data.error?.message || data.errors?.[0]?.message)) ||
        `Clerk API HTTP ${res.status}`;
      const e = new Error(message);
      e.status = res.status;
      e.responseBody = data;
      throw e;
    }

    return data;
  } catch (err) {
    if (err?.name === "AbortError") {
      const e = new Error("Timeout ao comunicar com a Clerk API");
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(to);
  }
}

// ===== Core lookups =====
/**
 * Obtém o primeiro utilizador pelo e-mail via Clerk REST API.
 * Usa cache em memória para reduzir chamadas repetidas.
 */
export async function getClerkUserByEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) {
    const e = new Error("E-mail inválido");
    e.status = 400;
    throw e;
  }

  const cacheKey = `user:${norm}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  const data = await clerkFetch(`/v1/users?email_address=${encodeURIComponent(norm)}`);

  if (!Array.isArray(data) || data.length === 0) {
    const e = new Error("Utilizador não encontrado");
    e.status = 404;
    throw e;
  }

  const user = data[0];
  setCached(cacheKey, user);
  return user;
}

/**
 * Devolve o userId (Clerk) para um determinado e-mail.
 */
export async function resolveUserIdByEmail(email) {
  const user = await getClerkUserByEmail(email);
  if (!user?.id) {
    const e = new Error("Utilizador não encontrado (id ausente)");
    e.status = 404;
    throw e;
  }
  return user.id;
}

/**
 * Verifica se o e-mail tem role "admin" no Clerk.
 * Lê de public_metadata.role (preferencial) e faz fallback para private_metadata.role.
 * Usa cache em memória.
 */
export async function isEmailAdminByClerk(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return false;

  const cacheKey = `role:${norm}`;
  const hit = getCached(cacheKey);
  if (typeof hit === "boolean") return hit;

  const user = await getClerkUserByEmail(norm);

  // Em REST, os campos são snake_case: public_metadata / private_metadata
  const publicMeta = user?.public_metadata || user?.publicMetadata || {};
  const privateMeta = user?.private_metadata || user?.privateMetadata || {};

  const role =
    (publicMeta.role ?? publicMeta.roles?.[0]) ??
    (privateMeta.role ?? privateMeta.roles?.[0]) ??
    null;

  const isAdmin = String(role || "").toLowerCase() === "admin";
  setCached(cacheKey, isAdmin);
  return isAdmin;
}
