const DB_NAME = "assignment-deadline-manager";
const DB_VERSION = 2;
const TASK_STORE = "tasks";
const NOTIFIED_STORE = "notified";
const SETTINGS_STORE = "settings";
const TASKS_KEY = "current";
const LOCAL_REMINDERS_ENABLED_KEY = "local-reminders-enabled";
const CHECK_INTERVAL_MS = 60 * 1000;

let reminderTimerId = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(TASK_STORE)) {
        database.createObjectStore(TASK_STORE);
      }

      if (!database.objectStoreNames.contains(NOTIFIED_STORE)) {
        database.createObjectStore(NOTIFIED_STORE);
      }

      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, action) {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = action(store);

    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };

    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

function getValue(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putValue(store, value, key) {
  return new Promise((resolve, reject) => {
    const request = store.put(value, key);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function readTasks() {
  const tasks = await withStore(TASK_STORE, "readonly", (store) => getValue(store, TASKS_KEY));
  return Array.isArray(tasks) ? tasks : [];
}

async function writeTasks(tasks) {
  await withStore(TASK_STORE, "readwrite", (store) => putValue(store, tasks, TASKS_KEY));
}

async function readLocalRemindersEnabled() {
  const enabled = await withStore(SETTINGS_STORE, "readonly", (store) =>
    getValue(store, LOCAL_REMINDERS_ENABLED_KEY),
  );

  return enabled === true;
}

async function writeLocalRemindersEnabled(enabled) {
  await withStore(SETTINGS_STORE, "readwrite", (store) =>
    putValue(store, enabled === true, LOCAL_REMINDERS_ENABLED_KEY),
  );
}

async function readNotifiedKeys() {
  const todayPrefix = `${todayKey()}:`;
  const keys = await withStore(NOTIFIED_STORE, "readonly", (store) =>
    getValue(store, todayPrefix),
  );

  return new Set(Array.isArray(keys) ? keys : []);
}

async function writeNotifiedKeys(keys) {
  const todayPrefix = `${todayKey()}:`;
  await withStore(NOTIFIED_STORE, "readwrite", (store) =>
    putValue(store, Array.from(keys), todayPrefix),
  );
}

function todayKey() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function diffDaysFromToday(value) {
  if (!value) return Number.POSITIVE_INFINITY;

  const today = parseDateKey(todayKey()).getTime();
  const target = parseDateKey(value).getTime();

  return Math.round((target - today) / 86400000);
}

function getNotificationDate(task) {
  return task.notificationDate || task.dueDate;
}

function getNotificationSentKey(task) {
  return `${todayKey()}:${task.id}:${getNotificationDate(task)}`;
}

function getNotificationSentKeyFromPayload(payload) {
  if (!payload?.taskId || !payload?.notificationDate) return null;
  return `${todayKey()}:${payload.taskId}:${payload.notificationDate}`;
}

async function markPayloadNotified(payload) {
  const sentKey = getNotificationSentKeyFromPayload(payload);
  if (!sentKey) return;

  const keys = await readNotifiedKeys();
  keys.add(sentKey);
  await writeNotifiedKeys(keys);
}

function formatDate(value) {
  if (!value) return "";

  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(parseDateKey(value));
}

async function notifyDueTasks() {
  if (Notification.permission !== "granted") return;
  if (!(await readLocalRemindersEnabled())) return;

  const tasks = await readTasks();
  const notifiedKeys = await readNotifiedKeys();
  let hasNewNotification = false;

  const dueTasks = tasks
    .filter((task) => !task.completed && diffDaysFromToday(getNotificationDate(task)) <= 0)
    .sort((a, b) => parseDateKey(getNotificationDate(a)) - parseDateKey(getNotificationDate(b)));

  for (const task of dueTasks) {
    const sentKey = getNotificationSentKey(task);
    if (notifiedKeys.has(sentKey)) continue;

    const notificationDate = getNotificationDate(task);

    await self.registration.showNotification("課題の通知日です", {
      body: `${task.title} / 締切 ${formatDate(task.dueDate)}`,
      data: { taskId: task.id },
      renotify: true,
      requireInteraction: true,
      silent: false,
      tag: `assignment-${task.id}-${notificationDate}`,
      timestamp: Date.now(),
    });

    notifiedKeys.add(sentKey);
    hasNewNotification = true;
  }

  if (hasNewNotification) {
    await writeNotifiedKeys(notifiedKeys);
  }
}

function scheduleReminderCheck() {
  if (reminderTimerId !== null) {
    clearTimeout(reminderTimerId);
  }

  reminderTimerId = setTimeout(async () => {
    await notifyDueTasks();
    scheduleReminderCheck();
  }, CHECK_INTERVAL_MS);
}

async function syncReminderSchedule() {
  if (await readLocalRemindersEnabled()) {
    scheduleReminderCheck();
    return;
  }

  if (reminderTimerId !== null) {
    clearTimeout(reminderTimerId);
    reminderTimerId = null;
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      notifyDueTasks().finally(syncReminderSchedule),
    ]),
  );
});

self.addEventListener("message", (event) => {
  const message = event.data;

  if (message?.type === "SYNC_ASSIGNMENTS") {
    event.waitUntil(
      Promise.all([
        writeTasks(Array.isArray(message.tasks) ? message.tasks : []),
        writeLocalRemindersEnabled(message.useLocalReminders === true),
      ]).then(() => {
        return syncReminderSchedule();
      }),
    );
  }

  if (message?.type === "SET_NOTIFICATION_ENABLED") {
    event.waitUntil(
      writeLocalRemindersEnabled(message.useLocalReminders === true).then(() => {
        return syncReminderSchedule();
      }),
    );
  }
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "assignment-reminders") {
    event.waitUntil(notifyDueTasks());
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "assignment-reminders") {
    event.waitUntil(notifyDueTasks());
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      if (event.data) {
        const payload = event.data.json();
        await self.registration.showNotification(payload.title || "課題管理", {
          body: payload.body || "通知があります。",
          data: { taskId: payload.taskId, url: payload.url || "/" },
          renotify: true,
          requireInteraction: true,
          silent: false,
          tag: payload.tag || `assignment-push-${Date.now()}`,
          timestamp: Date.now(),
        });
        await markPayloadNotified(payload);

        return;
      }

      await notifyDueTasks();
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(event.notification.data?.url || "/");
      }

      return undefined;
    }),
  );
});
