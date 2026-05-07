import { PrismaClient } from "@prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";

// Use Turso (libSQL) when TURSO_DATABASE_URL is set, otherwise fall back to
// local SQLite via DATABASE_URL. This lets the bot, GitHub Actions, and Vercel
// share state via Turso while local dev can still hit prisma/dev.db.

const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
const tursoToken = process.env.TURSO_AUTH_TOKEN?.trim();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function buildClient(): PrismaClient {
  if (tursoUrl) {
    const adapter = new PrismaLibSQL({
      url: tursoUrl,
      authToken: tursoToken,
    });
    return new PrismaClient({ adapter, log: ["error"] });
  }
  return new PrismaClient({ log: ["error"] });
}

export const prisma = globalForPrisma.prisma ?? buildClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
