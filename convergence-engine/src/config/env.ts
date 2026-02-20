import { z } from "zod";

const envSchema = z.object({
  // API Keys
  POLYMARKET_API_KEY: z.string().optional(),
  KALSHI_API_KEY: z.string().optional(),
  
  // Endpoints
  POLYMARKET_API_URL: z.string().default("https://gamma-api.polymarket.com"),
  KALSHI_API_URL: z.string().default("https://trading-api.kalshi.com/v1"),
  CLOB_API_URL: z.string().default("https://clob.polymarket.com"),
  
  // Engine settings
  POLL_INTERVAL_MS: z.number().default(60_000), // 1 minute
  BACKTEST_MODE: z.boolean().default(false),
  
  // Log level
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

export const env = {
  load(): Env {
    const parsed = envSchema.safeParse({
      POLYMARKET_API_KEY: process.env.POLYMARKET_API_KEY,
      KALSHI_API_KEY: process.env.KALSHI_API_KEY,
      POLYMARKET_API_URL: process.env.POLYMARKET_API_URL,
      KALSHI_API_URL: process.env.KALSHI_API_URL,
      CLOB_API_URL: process.env.CLOB_API_URL,
      POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS 
        ? parseInt(process.env.POLL_INTERVAL_MS, 10) 
        : undefined,
      BACKTEST_MODE: process.env.BACKTEST_MODE === "true",
      LOG_LEVEL: process.env.LOG_LEVEL,
    });
    
    if (!parsed.success) {
      console.error("Invalid environment variables:", parsed.error.errors);
      throw new Error("Environment validation failed");
    }
    
    return parsed.data;
  },
};
