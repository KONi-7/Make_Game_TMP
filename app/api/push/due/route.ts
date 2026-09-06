import { sendDuePushNotifications } from "../push-store";

export const runtime = "nodejs";

async function sendDueNotifications() {
  const result = await sendDuePushNotifications();
  return Response.json({ ok: result.sent > 0 || result.due === 0, ...result });
}

export async function GET() {
  return sendDueNotifications();
}

export async function POST() {
  return sendDueNotifications();
}
