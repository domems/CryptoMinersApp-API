import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

export const getUserIdByEmail = async (req, res) => {
  const { email } = req.params;

  try {
    const response = await fetch(`https://api.clerk.accounts.dev/v1/users?email_address=${email}`, {
      headers: {
        Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ error: "Utilizador não encontrado" });
    }

    const user = data[0];
    res.json({ user_id: user.id });
  } catch (error) {
    console.error("Erro ao obter user ID:", error);
    res.status(500).json({ error: "Erro ao buscar utilizador" });
  }
};
