import ratelimit from "../config/upstash.js";

const rateLimiter = async (req, res, next) => {
  try {
    const { success } = await ratelimit.limit("my-rate-limit");

    if (!success) {
      return res.status(429).json({
        message: "Too many requests, please try again later :)",
      });
    }

    next(); // continua para o próximo middleware

  } catch (error) {
    console.log("Rate limit error", error);
    next(error); // passa o erro para o Express
  }
};

export default rateLimiter;


