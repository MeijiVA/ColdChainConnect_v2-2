import type { RequestHandler } from "express";
import { SalesForecastChatRequestSchema } from "../../shared/api";
import {
  GeminiRequestError,
  generateSalesForecastAnswer,
} from "../services/sales-forecast-chat";

export const postSalesForecastChat: RequestHandler = async (req, res) => {
  const parsed = SalesForecastChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid sales forecast chat request" });
  }

  try {
    const answer = await generateSalesForecastAnswer(parsed.data);
    res.json({ answer });
  } catch (error) {
    if (error instanceof GeminiRequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    return res
      .status(502)
      .json({ error: "Gemini could not answer right now. Please try again." });
  }
};
