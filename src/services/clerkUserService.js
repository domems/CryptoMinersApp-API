// services/clerkUserService.js
import fetch from "node-fetch";

export async function resolveUserIdByEmail(email) {
  const url = `https://api.clerk.dev/v1/users?email_address=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Resposta inesperada da Clerk API");
  }

  if (!Array.isArray(data) || data.length === 0) {
    const e = new Error("Utilizador não encontrado");
    e.status = 404;
    throw e;
  }
  return data[0].id; // Clerk user id
}
