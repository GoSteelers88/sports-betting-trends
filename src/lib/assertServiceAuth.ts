export function assertServiceAuth(req: Request): Response | null {
  const secret = process.env.ASSISTANT_SECRET;
  if (!secret) return new Response("Server misconfigured", { status: 500 });
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null; // pass
}
