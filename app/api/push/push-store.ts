import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import webpush from "web-push";
import type { PushSubscription } from "web-push";

const DEFAULT_STORE_DIR = ".local-push";
const CHECK_INTERVAL_MS = 60_000;

type PushSendResult = {
  errors: string[];
  failed: number;
  sent: number;
  total: number;
};

type DuePushPayload = {
  body: string;
  notificationDate: string;
  tag: string;
  taskId: string;
  title: string;
  url: string;
};

type StoredSubscription = PushSubscription & {
  savedAt: string;
};

type StoredTask = {
  completed?: boolean;
  dueDate?: string;
  id?: string;
  notificationDate?: string;
  subject?: string;
  title?: string;
};

type AppState = {
  notificationEnabled: boolean;
  tasks: StoredTask[];
  updatedAt: string;
};

type DuePushOptions = {
  now?: Date;
  sendPush?: (payload: DuePushPayload) => Promise<PushSendResult>;
};

function getStoreDir() {
  const configuredStoreDir = process.env.ASSIGNMENT_PUSH_STORE_DIR;
  return configuredStoreDir ? path.resolve(configuredStoreDir) : path.join(process.cwd(), DEFAULT_STORE_DIR);
}

function getSubscriptionsFile() {
  return path.join(getStoreDir(), "subscriptions.json");
}

function getAppStateFile() {
  return path.join(getStoreDir(), "app-state.json");
}

function getNotifiedFile() {
  return path.join(getStoreDir(), "notified.json");
}

function isSchedulerDisabled() {
  return process.env.ASSIGNMENT_PUSH_DISABLE_SCHEDULER === "true";
}

function configureWebPush() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:test@example.com";

  if (!publicKey || !privateKey) {
    throw new Error("VAPID keys are not configured.");
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
}

async function readSubscriptions() {
  try {
    const raw = await readFile(getSubscriptionsFile(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredSubscription[]) : [];
  } catch {
    return [];
  }
}

async function writeSubscriptions(subscriptions: StoredSubscription[]) {
  await mkdir(getStoreDir(), { recursive: true });
  await writeFile(getSubscriptionsFile(), JSON.stringify(subscriptions, null, 2), "utf8");
}

async function readAppState(): Promise<AppState> {
  try {
    const raw = await readFile(getAppStateFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppState>;

    return {
      notificationEnabled: parsed.notificationEnabled === true,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return {
      notificationEnabled: false,
      tasks: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

async function writeAppState(state: AppState) {
  await mkdir(getStoreDir(), { recursive: true });
  await writeFile(getAppStateFile(), JSON.stringify(state, null, 2), "utf8");
}

async function readNotifiedKeys() {
  try {
    const raw = await readFile(getNotifiedFile(), "utf8");
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

async function writeNotifiedKeys(keys: Set<string>, now = new Date()) {
  const todayPrefix = `${dateKey(now)}:`;
  const todayKeys = Array.from(keys).filter((key) => key.startsWith(todayPrefix));

  await mkdir(getStoreDir(), { recursive: true });
  await writeFile(getNotifiedFile(), JSON.stringify(todayKeys, null, 2), "utf8");
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function diffDaysFromDate(value?: string, now = new Date()) {
  if (!value) return Number.POSITIVE_INFINITY;

  const today = parseDateKey(dateKey(now)).getTime();
  const target = parseDateKey(value).getTime();
  if (Number.isNaN(target)) return Number.POSITIVE_INFINITY;

  return Math.round((target - today) / 86_400_000);
}

function getNotificationDate(task: StoredTask) {
  return task.notificationDate || task.dueDate || "";
}

function getNotificationSentKey(task: StoredTask, now = new Date()) {
  return `${dateKey(now)}:${task.id || "unknown"}:${getNotificationDate(task)}`;
}

function formatDate(value?: string) {
  if (!value) return "";

  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(parseDateKey(value));
}

export async function saveSubscription(subscription: PushSubscription) {
  const nextSubscription: StoredSubscription = {
    ...subscription,
    savedAt: new Date().toISOString(),
  };
  const nextSubscriptions = [nextSubscription];

  await writeSubscriptions(nextSubscriptions);
  ensurePushScheduler();
  return nextSubscriptions.length;
}

export async function saveAppState(input: { notificationEnabled?: unknown; tasks?: unknown }) {
  const state: AppState = {
    notificationEnabled: input.notificationEnabled === true,
    tasks: Array.isArray(input.tasks) ? (input.tasks as StoredTask[]) : [],
    updatedAt: new Date().toISOString(),
  };

  await writeAppState(state);
  ensurePushScheduler();
  return state;
}

function getSendErrorMessage(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }

  return "Unknown push send error.";
}

export async function sendPushToAll(payload: unknown): Promise<PushSendResult> {
  const subscriptions = await readSubscriptions();

  if (subscriptions.length === 0) {
    return { errors: [], failed: 0, sent: 0, total: 0 };
  }

  configureWebPush();

  const results = await Promise.allSettled(
    subscriptions.map((subscription) =>
      webpush.sendNotification(subscription, JSON.stringify(payload)),
    ),
  );

  const validSubscriptions = subscriptions.filter((_, index) => {
    const result = results[index];
    if (result.status === "fulfilled") return true;

    const statusCode = (result.reason as { statusCode?: number }).statusCode;
    return statusCode !== 404 && statusCode !== 410;
  });

  if (validSubscriptions.length !== subscriptions.length) {
    await writeSubscriptions(validSubscriptions);
  }

  return {
    errors: results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => getSendErrorMessage(result.reason)),
    failed: results.filter((result) => result.status === "rejected").length,
    sent: results.filter((result) => result.status === "fulfilled").length,
    total: subscriptions.length,
  };
}

export async function sendDuePushNotifications(options: DuePushOptions = {}) {
  const now = options.now || new Date();
  const sendPush = options.sendPush || sendPushToAll;
  const state = await readAppState();

  if (!state.notificationEnabled) {
    return { due: 0, failed: 0, sent: 0, skipped: "disabled", total: 0 };
  }

  const notifiedKeys = await readNotifiedKeys();
  const dueTasks = state.tasks
    .filter((task) => task.id && !task.completed && diffDaysFromDate(getNotificationDate(task), now) <= 0)
    .sort(
      (a, b) =>
        parseDateKey(getNotificationDate(a)).getTime() -
        parseDateKey(getNotificationDate(b)).getTime(),
    )
    .filter((task) => !notifiedKeys.has(getNotificationSentKey(task, now)));

  let failed = 0;
  let sent = 0;
  let total = 0;

  for (const task of dueTasks) {
    const notificationDate = getNotificationDate(task);

    const result = await sendPush({
      body: `${task.title || "課題"} / 締切 ${formatDate(task.dueDate)}`,
      notificationDate,
      tag: `assignment-${task.id}-${notificationDate}`,
      taskId: task.id || "unknown",
      title: "課題の通知日です",
      url: "/",
    });

    failed += result.failed;
    sent += result.sent;
    total += result.total;

    if (result.sent > 0) {
      notifiedKeys.add(getNotificationSentKey(task, now));
    }
  }

  if (sent > 0) {
    await writeNotifiedKeys(notifiedKeys, now);
  }

  return { due: dueTasks.length, failed, sent, total };
}

function scheduleDuePushCheckSoon() {
  if (isSchedulerDisabled()) return;

  const pushSchedulerGlobal = globalThis as typeof globalThis & {
    __assignmentPushImmediateCheck?: ReturnType<typeof setTimeout>;
  };

  if (pushSchedulerGlobal.__assignmentPushImmediateCheck) return;

  pushSchedulerGlobal.__assignmentPushImmediateCheck = setTimeout(() => {
    pushSchedulerGlobal.__assignmentPushImmediateCheck = undefined;
    void sendDuePushNotifications().catch(() => undefined);
  }, 0);
  pushSchedulerGlobal.__assignmentPushImmediateCheck.unref?.();
}

export function ensurePushScheduler() {
  if (isSchedulerDisabled()) return;

  const pushSchedulerGlobal = globalThis as typeof globalThis & {
    __assignmentPushScheduler?: ReturnType<typeof setInterval>;
  };

  if (!pushSchedulerGlobal.__assignmentPushScheduler) {
    pushSchedulerGlobal.__assignmentPushScheduler = setInterval(() => {
      void sendDuePushNotifications().catch(() => undefined);
    }, CHECK_INTERVAL_MS);
    pushSchedulerGlobal.__assignmentPushScheduler.unref?.();
  }

  scheduleDuePushCheckSoon();
}
