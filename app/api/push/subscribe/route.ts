import { saveSubscription } from "../push-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json();
  const subscription = body?.subscription;

  if (!subscription?.endpoint || !subscription?.keys?.auth || !subscription?.keys?.p256dh) {
    return Response.json({ error: "Invalid push subscription." }, { status: 400 });
  }

  const count = await saveSubscription(subscription);
  return Response.json({ count, ok: true });
}
