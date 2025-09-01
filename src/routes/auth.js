// routes/auth.js
import { Router } from "express";
import { clerkClient, requireAuth } from "@clerk/express";

const router = Router();

function inWhitelist(email) {
  const wl = (process.env.ADMIN_WHITELIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!email && wl.includes(email.toLowerCase());
}

/**
 * Garante que o utilizador autenticado tem publicMetadata.role definido.
 * - "admin" se o email estiver na ADMIN_WHITELIST
 * - "user" caso contrário (DEFAULT)
 */
router.post("/bootstrap", requireAuth(), async (req, res) => {
  try {
    const { userId } = req.auth;
    const user = await clerkClient.users.getUser(userId);

    // email principal
    const primary =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
      user.emailAddresses[0]?.emailAddress;

    // já tem role válida? devolve-a
    const currentRole = (user.publicMetadata || {}).role;
    if (currentRole === "admin" || currentRole === "user") {
      return res.json({ role: currentRole });
    }

    // decide e grava role
    const role = inWhitelist(primary) ? "admin" : "user";
    await clerkClient.users.updateUserMetadata(userId, {
      publicMetadata: { ...(user.publicMetadata || {}), role },
    });

    return res.json({ role });
  } catch (err) {
    console.error("[auth/bootstrap] error:", err);
    return res.status(500).json({ error: "failed_to_bootstrap_role" });
  }
});

export default router;
