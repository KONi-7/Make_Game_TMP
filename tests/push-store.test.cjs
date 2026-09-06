const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

process.env.ASSIGNMENT_PUSH_DISABLE_SCHEDULER = "true";

require.extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = require("node:fs").readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      isolatedModules: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;

  module._compile(output, filename);
};

const webpush = require("web-push");
const pushStore = require("../app/api/push/push-store.ts");
const NOW = new Date(2026, 5, 15, 9, 0, 0);

async function useTempStore(t) {
  const previousStoreDir = process.env.ASSIGNMENT_PUSH_STORE_DIR;
  const storeDir = await mkdtemp(path.join(tmpdir(), "assignment-push-"));
  process.env.ASSIGNMENT_PUSH_STORE_DIR = storeDir;

  t.after(async () => {
    if (previousStoreDir === undefined) {
      delete process.env.ASSIGNMENT_PUSH_STORE_DIR;
    } else {
      process.env.ASSIGNMENT_PUSH_STORE_DIR = previousStoreDir;
    }

    await rm(storeDir, { force: true, recursive: true });
  });
}

function makeTask(overrides = {}) {
  return {
    completed: false,
    dueDate: "2026-06-20",
    id: "task-today",
    notificationDate: "2026-06-15",
    title: "Due today",
    ...overrides,
  };
}

function sentResult() {
  return { errors: [], failed: 0, sent: 1, total: 1 };
}

test("sends push payloads for tasks whose notification date has arrived", async (t) => {
  await useTempStore(t);
  await pushStore.saveAppState({
    notificationEnabled: true,
    tasks: [
      makeTask(),
      makeTask({ id: "task-future", notificationDate: "2026-06-16", title: "Future" }),
      makeTask({ completed: true, id: "task-completed", title: "Completed" }),
    ],
  });

  const payloads = [];
  const result = await pushStore.sendDuePushNotifications({
    now: NOW,
    sendPush: async (payload) => {
      payloads.push(payload);
      return sentResult();
    },
  });

  assert.equal(result.due, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.sent, 1);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].tag, "assignment-task-today-2026-06-15");
  assert.equal(payloads[0].taskId, "task-today");
  assert.equal(payloads[0].notificationDate, "2026-06-15");
  assert.match(payloads[0].body, /Due today/);
});

test("uses due date as the notification date when no notification date is set", async (t) => {
  await useTempStore(t);
  await pushStore.saveAppState({
    notificationEnabled: true,
    tasks: [makeTask({ dueDate: "2026-06-15", id: "task-fallback", notificationDate: "" })],
  });

  const payloads = [];
  const result = await pushStore.sendDuePushNotifications({
    now: NOW,
    sendPush: async (payload) => {
      payloads.push(payload);
      return sentResult();
    },
  });

  assert.equal(result.due, 1);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].tag, "assignment-task-fallback-2026-06-15");
});

test("does not send the same notification twice on the same day", async (t) => {
  await useTempStore(t);
  await pushStore.saveAppState({
    notificationEnabled: true,
    tasks: [makeTask()],
  });

  let sendCount = 0;
  const sender = async () => {
    sendCount += 1;
    return sentResult();
  };

  const first = await pushStore.sendDuePushNotifications({ now: NOW, sendPush: sender });
  const second = await pushStore.sendDuePushNotifications({ now: NOW, sendPush: sender });

  assert.equal(first.sent, 1);
  assert.equal(second.due, 0);
  assert.equal(second.sent, 0);
  assert.equal(sendCount, 1);
});

test("retries later when a due push send fails", async (t) => {
  await useTempStore(t);
  await pushStore.saveAppState({
    notificationEnabled: true,
    tasks: [makeTask()],
  });

  let sendCount = 0;
  const failed = await pushStore.sendDuePushNotifications({
    now: NOW,
    sendPush: async () => {
      sendCount += 1;
      return { errors: ["network"], failed: 1, sent: 0, total: 1 };
    },
  });
  const retry = await pushStore.sendDuePushNotifications({
    now: NOW,
    sendPush: async () => {
      sendCount += 1;
      return sentResult();
    },
  });

  assert.equal(failed.due, 1);
  assert.equal(failed.sent, 0);
  assert.equal(retry.due, 1);
  assert.equal(retry.sent, 1);
  assert.equal(sendCount, 2);
});

test("skips due checks when push notifications are disabled", async (t) => {
  await useTempStore(t);
  await pushStore.saveAppState({
    notificationEnabled: false,
    tasks: [makeTask()],
  });

  let sendCalled = false;
  const result = await pushStore.sendDuePushNotifications({
    now: NOW,
    sendPush: async () => {
      sendCalled = true;
      return sentResult();
    },
  });

  assert.equal(result.skipped, "disabled");
  assert.equal(result.sent, 0);
  assert.equal(sendCalled, false);
});

test("sendPushToAll delegates saved subscriptions to web-push", async (t) => {
  await useTempStore(t);

  const previousPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const previousPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const previousSubject = process.env.VAPID_SUBJECT;
  const originalSetVapidDetails = webpush.setVapidDetails;
  const originalSendNotification = webpush.sendNotification;

  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
  process.env.VAPID_SUBJECT = "mailto:test@example.com";

  const vapidCalls = [];
  const sentPayloads = [];
  webpush.setVapidDetails = (...args) => {
    vapidCalls.push(args);
  };
  webpush.sendNotification = async (subscription, payload) => {
    sentPayloads.push({ payload, subscription });
  };

  t.after(() => {
    webpush.setVapidDetails = originalSetVapidDetails;
    webpush.sendNotification = originalSendNotification;

    if (previousPublicKey === undefined) {
      delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    } else {
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = previousPublicKey;
    }

    if (previousPrivateKey === undefined) {
      delete process.env.VAPID_PRIVATE_KEY;
    } else {
      process.env.VAPID_PRIVATE_KEY = previousPrivateKey;
    }

    if (previousSubject === undefined) {
      delete process.env.VAPID_SUBJECT;
    } else {
      process.env.VAPID_SUBJECT = previousSubject;
    }
  });

  await pushStore.saveSubscription({
    endpoint: "https://push.example.test/subscription",
    expirationTime: null,
    keys: {
      auth: "auth-key",
      p256dh: "p256dh-key",
    },
  });

  const payload = { body: "Body", tag: "tag", title: "Title", url: "/" };
  const result = await pushStore.sendPushToAll(payload);

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(vapidCalls.length, 1);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].payload, JSON.stringify(payload));
  assert.equal(sentPayloads[0].subscription.endpoint, "https://push.example.test/subscription");
});
