import { saveAppState } from "../push-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const state = await saveAppState({
      notificationEnabled: body?.notificationEnabled,
      tasks: body?.tasks,
    });

    return Response.json({
      notificationEnabled: state.notificationEnabled,
      ok: true,
      tasks: state.tasks.length,
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unknown state save error.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
