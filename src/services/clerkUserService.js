import fetch from "node-fetch";

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  console.warn("⚠️ CLERK_SECRET_KEY não definido — chamadas à Clerk API irão falhar.");
}
const CLERK_API_BASE = (process.env.CLERK_API_BASE_URL || "https://api.clerk.com").replace(/\/+$/, "");
const CACHE_TTL_MS = Number(process.env.CLERK_CACHE_TTL_MS || 60_000);

const _cache = new Map();
const now = () => Date.now();
const getCached = (k) => {
  const h = _cache.get(k);
  if (!h) return null;
  if (h.exp < now()) { _cache.delete(k); return null; }
  return h.data;
};
const setCached = (k, d, ttl = CACHE_TTL_MS) => _cache.set(k, { data: d, exp: now() + ttl });

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
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch {
      const e = new Error("Resposta inesperada da Clerk API"); e.status = 502; e.responseBody = raw; throw e;
    }
    if (!res.ok) {
      const message = (data && (data.error?.message || data.errors?.[0]?.message)) || `Clerk API HTTP ${res.status}`;
      const e = new Error(message); e.status = res.status; e.responseBody = data; throw e;
    }
    return data;
  } catch (err) {
    if (err?.name === "AbortError") { const e = new Error("Timeout ao comunicar com a Clerk API"); e.status = 504; throw e; }
    throw err;
  } finally { clearTimeout(to); }
}

export async function getClerkUserByEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) { const e = new Error("E-mail inválido"); e.status = 400; throw e; }
  const key = `user:${norm}`;
  const hit = getCached(key);
  if (hit) return hit;
  const data = await clerkFetch(`/v1/users?email_address=${encodeURIComponent(norm)}`);
  if (!Array.isArray(data) || data.length === 0) { const e = new Error("Utilizador não encontrado"); e.status = 404; throw e; }
  setCached(key, data[0]);
  return data[0];
}

export async function getClerkUserById(userId) {
  const id = String(userId || "").trim();
  if (!id) { const e = new Error("userId inválido"); e.status = 400; throw e; }
  const key = `userId:${id}`;
  const hit = getCached(key);
  if (hit) return hit;
  const data = await clerkFetch(`/v1/users/${encodeURIComponent(id)}`);
  setCached(key, data);
  return data;
}

export async function resolveUserIdByEmail(email) {
  const user = await getClerkUserByEmail(email);
  if (!user?.id) { const e = new Error("Utilizador não encontrado (id ausente)"); e.status = 404; throw e; }
  return user.id;
}

export async function isEmailAdminByClerk(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return false;
  const key = `role:${norm}`;
  const hit = getCached(key);
  if (typeof hit === "boolean") return hit;

  const user = await getClerkUserByEmail(norm);
  const publicMeta = user?.public_metadata || user?.publicMetadata || {};
  const privateMeta = user?.private_metadata || user?.privateMetadata || {};
  const role =
    (publicMeta.role ?? publicMeta.roles?.[0]) ??
    (privateMeta.role ?? privateMeta.roles?.[0]) ?? null;

  const isAdmin = String(role || "").toLowerCase() === "admin";
  setCached(key, isAdmin);
  return isAdmin;
}
