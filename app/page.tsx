"use client";

import {
  Bell,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Circle,
  ClipboardList,
  Flag,
  Layers3,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "assignment-deadline-manager.tasks";
const NOTIFIED_STORAGE_KEY = "assignment-deadline-manager.notified";
const NOTIFICATION_ENABLED_STORAGE_KEY = "assignment-deadline-manager.notification-enabled";
const NOTIFICATION_CHECK_INTERVAL_MS = 60_000;
const SERVICE_WORKER_URL = "/sw.js";

const TASK_TYPES = [
  { value: "report", label: "レポート" },
  { value: "test", label: "テスト" },
  { value: "submission", label: "提出物" },
  { value: "other", label: "その他" },
] as const;

const PRIORITIES = [
  { value: "high", label: "高", rank: 1 },
  { value: "medium", label: "中", rank: 2 },
  { value: "low", label: "低", rank: 3 },
] as const;

type TaskType = (typeof TASK_TYPES)[number]["value"];
type Priority = (typeof PRIORITIES)[number]["value"];
type SortMode = "dueDate" | "priority" | "createdAt";
type StatusFilter = "all" | "open" | "completed";
type NotificationState = NotificationPermission | "unsupported";
type ServiceWorkerState = "idle" | "ready" | "unsupported";
type VisibleNotificationOptions = NotificationOptions & {
  renotify?: boolean;
  timestamp?: number;
};

type Assignment = {
  id: string;
  title: string;
  subject: string;
  type: TaskType;
  dueDate: string;
  notificationDate?: string;
  priority: Priority;
  completed: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type AssignmentForm = Pick<
  Assignment,
  "title" | "subject" | "type" | "dueDate" | "notificationDate" | "priority" | "note"
>;

const emptyForm: AssignmentForm = {
  title: "",
  subject: "",
  type: "report",
  dueDate: "",
  notificationDate: "",
  priority: "medium",
  note: "",
};

const priorityRank: Record<Priority, number> = {
  high: 1,
  medium: 2,
  low: 3,
};

const priorityLabel = Object.fromEntries(
  PRIORITIES.map((priority) => [priority.value, priority.label]),
) as Record<Priority, string>;

const typeLabel = Object.fromEntries(
  TASK_TYPES.map((type) => [type.value, type.label]),
) as Record<TaskType, string>;

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function todayKey() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function diffDaysFromToday(value: string) {
  if (!value) return Number.POSITIVE_INFINITY;

  const today = parseDateKey(todayKey()).getTime();
  const target = parseDateKey(value).getTime();

  return Math.round((target - today) / 86_400_000);
}

function getNotificationDate(task: Assignment) {
  return task.notificationDate || task.dueDate;
}

function getDueStatus(task: Assignment) {
  if (task.completed) {
    return {
      label: "完了",
      tone: "green",
      className: "is-completed",
    };
  }

  const diff = diffDaysFromToday(task.dueDate);

  if (diff < 0) {
    return {
      label: "期限切れ",
      tone: "red",
      className: "is-overdue",
    };
  }

  if (diff === 0) {
    return {
      label: "今日",
      tone: "amber",
      className: "is-today",
    };
  }

  if (diff === 1) {
    return {
      label: "明日",
      tone: "blue",
      className: "",
    };
  }

  if (diff <= 3) {
    return {
      label: `あと${diff}日`,
      tone: "violet",
      className: "",
    };
  }

  return {
    label: `${diff}日後`,
    tone: "blue",
    className: "",
  };
}

function badgeClass(tone: string) {
  return `badge badge-${tone}`;
}

function formatDate(value: string) {
  if (!value) return "";

  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(parseDateKey(value));
}

function sortTasks(tasks: Assignment[], sortMode: SortMode) {
  return [...tasks].sort((a, b) => {
    if (sortMode === "priority") {
      const priorityDiff = priorityRank[a.priority] - priorityRank[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
    }

    if (sortMode === "createdAt") {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }

    const dueDiff = parseDateKey(a.dueDate).getTime() - parseDateKey(b.dueDate).getTime();
    if (dueDiff !== 0) return dueDiff;

    return priorityRank[a.priority] - priorityRank[b.priority];
  });
}

function sortNotificationTasks(tasks: Assignment[]) {
  return [...tasks].sort((a, b) => {
    const notificationDiff =
      parseDateKey(getNotificationDate(a)).getTime() -
      parseDateKey(getNotificationDate(b)).getTime();
    if (notificationDiff !== 0) return notificationDiff;

    const dueDiff = parseDateKey(a.dueDate).getTime() - parseDateKey(b.dueDate).getTime();
    if (dueDiff !== 0) return dueDiff;

    return priorityRank[a.priority] - priorityRank[b.priority];
  });
}

function getNotificationSentKey(task: Assignment) {
  return `${todayKey()}:${task.id}:${getNotificationDate(task)}`;
}

function readNotifiedKeys() {
  try {
    const storedKeys = localStorage.getItem(NOTIFIED_STORAGE_KEY);
    if (!storedKeys) return new Set<string>();

    const parsedKeys = JSON.parse(storedKeys);
    return new Set(Array.isArray(parsedKeys) ? (parsedKeys as string[]) : []);
  } catch {
    localStorage.removeItem(NOTIFIED_STORAGE_KEY);
    return new Set<string>();
  }
}

function writeNotifiedKeys(keys: Set<string>) {
  const todayPrefix = `${todayKey()}:`;
  const todayKeys = Array.from(keys).filter((key) => key.startsWith(todayPrefix));
  localStorage.setItem(NOTIFIED_STORAGE_KEY, JSON.stringify(todayKeys));
}

function getNotificationLabel(permission: NotificationState) {
  if (permission === "granted") return "通知OFF";
  if (permission === "denied") return "通知OFF";
  if (permission === "unsupported") return "通知非対応";
  return "通知OFF";
}

function getServiceWorkerLabel(
  permission: NotificationState,
  serviceWorkerState: ServiceWorkerState,
  notificationEnabled: boolean,
) {
  if (permission !== "granted") return getNotificationLabel(permission);
  if (!notificationEnabled) return "通知OFF";
  if (serviceWorkerState === "ready") return "通知ON";
  if (serviceWorkerState === "unsupported") return "バックグラウンド非対応";
  return "通知準備中";
}

function isWebPushSupported() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window;
}

function shouldUseLocalReminders(notificationEnabled: boolean, useLocalFallback: boolean) {
  return notificationEnabled && (useLocalFallback || !isWebPushSupported());
}

function shouldUseServerPush(notificationEnabled: boolean, useLocalFallback: boolean) {
  return notificationEnabled && !useLocalFallback && isWebPushSupported();
}

function showLocalTaskNotification(task: Assignment) {
  const notificationDate = getNotificationDate(task);
  const options: VisibleNotificationOptions = {
    body: `${task.title} / 締切 ${formatDate(task.dueDate)}`,
    data: { taskId: task.id },
    renotify: true,
    requireInteraction: true,
    silent: false,
    tag: `assignment-${task.id}-${notificationDate}`,
    timestamp: Date.now(),
  };

  new Notification("課題の通知日です", options);
}

async function registerBackgroundNotificationChecks(registration: ServiceWorkerRegistration) {
  const periodicSync = "periodicSync" in registration
    ? (registration as ServiceWorkerRegistration & {
      periodicSync: { register: (tag: string, options?: { minInterval?: number }) => Promise<void> };
    }).periodicSync
    : null;

  if (periodicSync) {
    await periodicSync.register("assignment-reminders", {
      minInterval: NOTIFICATION_CHECK_INTERVAL_MS,
    });
  }

  const sync = "sync" in registration
    ? (registration as ServiceWorkerRegistration & {
      sync: { register: (tag: string) => Promise<void> };
    }).sync
    : null;

  if (sync) {
    await sync.register("assignment-reminders");
  }
}

async function postServiceWorkerMessage(message: unknown) {
  if (!("serviceWorker" in navigator)) return;

  const registration = await navigator.serviceWorker.ready;
  registration.active?.postMessage(message);
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);

  return Uint8Array.from([...rawData].map((character) => character.charCodeAt(0)));
}

function arrayBuffersEqual(left: ArrayBuffer | null, right: Uint8Array) {
  if (!left || left.byteLength !== right.byteLength) return false;

  const leftBytes = new Uint8Array(left);
  return leftBytes.every((byte, index) => byte === right[index]);
}

async function getVapidPublicKey() {
  const response = await fetch("/api/push/vapid-public-key", {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("VAPID public key could not be loaded.");
  }

  const payload = (await response.json()) as { publicKey?: string };
  if (!payload.publicKey) {
    throw new Error("VAPID public key is missing.");
  }

  return payload.publicKey;
}

async function subscribeToWebPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push API is not supported.");
  }

  const registration = await navigator.serviceWorker.ready;
  const publicKey = await getVapidPublicKey();
  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  const existingSubscription = await registration.pushManager.getSubscription();

  if (existingSubscription) {
    if (arrayBuffersEqual(existingSubscription.options.applicationServerKey, applicationServerKey)) {
      return existingSubscription;
    }

    await existingSubscription.unsubscribe();
  }

  return registration.pushManager.subscribe({
    applicationServerKey,
    userVisibleOnly: true,
  });
}

async function resetWebPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push API is not supported.");
  }

  const registration = await navigator.serviceWorker.ready;
  const existingSubscription = await registration.pushManager.getSubscription();
  await existingSubscription?.unsubscribe();

  const publicKey = await getVapidPublicKey();
  return registration.pushManager.subscribe({
    applicationServerKey: urlBase64ToUint8Array(publicKey),
    userVisibleOnly: true,
  });
}

async function saveWebPushSubscription(subscription: PushSubscription) {
  const response = await fetch("/api/push/subscribe", {
    body: JSON.stringify({ subscription }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error("Push subscription could not be saved.");
  }
}

async function ensureWebPushReady() {
  let subscription = await subscribeToWebPush();

  try {
    await saveWebPushSubscription(subscription);
  } catch {
    subscription = await resetWebPushSubscription();
    await saveWebPushSubscription(subscription);
  }

  return subscription;
}

async function savePushAppState(tasks: Assignment[], notificationEnabled: boolean) {
  const response = await fetch("/api/push/state", {
    body: JSON.stringify({ notificationEnabled, tasks }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error("Push app state could not be saved.");
  }
}

export default function Home() {
  const [tasks, setTasks] = useState<Assignment[]>([]);
  const [form, setForm] = useState<AssignmentForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("dueDate");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"all" | TaskType>("all");
  const [isHydrated, setIsHydrated] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationState>("default");
  const [serviceWorkerState, setServiceWorkerState] = useState<ServiceWorkerState>("idle");
  const [notificationEnabled, setNotificationEnabled] = useState(false);
  const [useLocalNotificationFallback, setUseLocalNotificationFallback] = useState(false);

  useEffect(() => {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }

    setNotificationPermission(Notification.permission);
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      setServiceWorkerState("unsupported");
      return;
    }

    navigator.serviceWorker
      .register(SERVICE_WORKER_URL)
      .then((registration) => registration.update().then(() => registration))
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        void registerBackgroundNotificationChecks(registration);
        setServiceWorkerState("ready");
      })
      .catch(() => {
        setServiceWorkerState("unsupported");
      });
  }, []);

  useEffect(() => {
    try {
      const storedTasks = localStorage.getItem(STORAGE_KEY);
      if (storedTasks) {
        const parsedTasks = JSON.parse(storedTasks);
        setTasks(Array.isArray(parsedTasks) ? (parsedTasks as Assignment[]) : []);
      }

      setNotificationEnabled(
        window.isSecureContext &&
        localStorage.getItem(NOTIFICATION_ENABLED_STORAGE_KEY) === "true",
      );
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      setTasks([]);
      setNotificationEnabled(false);
    } finally {
      setIsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (isHydrated) {
      const serverPushEnabled = shouldUseServerPush(
        notificationEnabled && notificationPermission === "granted",
        useLocalNotificationFallback,
      );

      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      localStorage.setItem(NOTIFICATION_ENABLED_STORAGE_KEY, String(notificationEnabled));
      void savePushAppState(tasks, serverPushEnabled).catch(() => undefined);
    }
  }, [
    isHydrated,
    notificationEnabled,
    notificationPermission,
    tasks,
    useLocalNotificationFallback,
  ]);

  useEffect(() => {
    if (!isHydrated || serviceWorkerState !== "ready") return;

    void postServiceWorkerMessage({
      type: "SYNC_ASSIGNMENTS",
      notificationEnabled,
      useLocalReminders: shouldUseLocalReminders(
        notificationEnabled,
        useLocalNotificationFallback,
      ),
      tasks,
    });
  }, [isHydrated, notificationEnabled, serviceWorkerState, tasks, useLocalNotificationFallback]);

  useEffect(() => {
    if (
      !isHydrated ||
      !notificationEnabled ||
      notificationPermission !== "granted" ||
      serviceWorkerState !== "ready"
    ) {
      return;
    }

    if (!isWebPushSupported()) {
      setUseLocalNotificationFallback(true);
      return;
    }

    let isCancelled = false;
    setUseLocalNotificationFallback(false);

    void ensureWebPushReady()
      .then(() => {
        if (isCancelled) return;
        return savePushAppState(tasks, true);
      })
      .catch(() => {
        if (isCancelled) return;
        setUseLocalNotificationFallback(true);
        void savePushAppState(tasks, false).catch(() => undefined);
      });

    return () => {
      isCancelled = true;
    };
  }, [isHydrated, notificationEnabled, notificationPermission, serviceWorkerState, tasks]);

  useEffect(() => {
    if (
      !isHydrated ||
      !notificationEnabled ||
      notificationPermission !== "granted" ||
      serviceWorkerState !== "unsupported"
    ) {
      return;
    }

    async function notifyDueTasks() {
      const notifiedKeys = readNotifiedKeys();
      let hasNewNotification = false;

      sortNotificationTasks(tasks)
        .filter((task) => !task.completed && diffDaysFromToday(getNotificationDate(task)) <= 0)
        .forEach((task) => {
          const sentKey = getNotificationSentKey(task);
          if (notifiedKeys.has(sentKey)) return;

          showLocalTaskNotification(task);

          notifiedKeys.add(sentKey);
          hasNewNotification = true;
        });

      if (hasNewNotification) {
        writeNotifiedKeys(notifiedKeys);
      }
    }

    notifyDueTasks();

    const intervalId = window.setInterval(notifyDueTasks, NOTIFICATION_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", notifyDueTasks);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", notifyDueTasks);
    };
  }, [isHydrated, notificationEnabled, notificationPermission, serviceWorkerState, tasks]);

  const subjects = useMemo(() => {
    return Array.from(new Set(tasks.map((task) => task.subject))).sort((a, b) =>
      a.localeCompare(b, "ja"),
    );
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();

    const filtered = tasks.filter((task) => {
      const matchesKeyword =
        !keyword ||
        [task.title, task.subject, task.note, typeLabel[task.type]]
          .join(" ")
          .toLowerCase()
          .includes(keyword);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "open" && !task.completed) ||
        (statusFilter === "completed" && task.completed);
      const matchesSubject = subjectFilter === "all" || task.subject === subjectFilter;
      const matchesType = typeFilter === "all" || task.type === typeFilter;

      return matchesKeyword && matchesStatus && matchesSubject && matchesType;
    });

    return sortTasks(filtered, sortMode);
  }, [searchTerm, sortMode, statusFilter, subjectFilter, tasks, typeFilter]);

  const stats = useMemo(() => {
    const openTasks = tasks.filter((task) => !task.completed);

    return {
      total: tasks.length,
      open: openTasks.length,
      completed: tasks.filter((task) => task.completed).length,
      today: openTasks.filter((task) => diffDaysFromToday(task.dueDate) === 0).length,
      tomorrow: openTasks.filter((task) => diffDaysFromToday(task.dueDate) === 1).length,
      overdue: openTasks.filter((task) => diffDaysFromToday(task.dueDate) < 0).length,
    };
  }, [tasks]);

  const closeTasks = useMemo(() => {
    return sortNotificationTasks(
      tasks.filter((task) => {
        const diff = diffDaysFromToday(getNotificationDate(task));
        return !task.completed && diff <= 0;
      }),
    );
  }, [tasks]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const now = new Date().toISOString();
    const payload: AssignmentForm = {
      ...form,
      title: form.title.trim(),
      subject: form.subject.trim() || "未分類",
      notificationDate: form.notificationDate || form.dueDate,
      note: form.note.trim(),
    };

    if (!payload.title || !payload.dueDate) return;

    if (editingId) {
      setTasks((currentTasks) =>
        currentTasks.map((task) =>
          task.id === editingId
            ? {
              ...task,
              ...payload,
              updatedAt: now,
            }
            : task,
        ),
      );
    } else {
      setTasks((currentTasks) => [
        {
          id: createId(),
          ...payload,
          completed: false,
          createdAt: now,
          updatedAt: now,
        },
        ...currentTasks,
      ]);
    }

    setForm(emptyForm);
    setEditingId(null);
  }

  function handleEdit(task: Assignment) {
    setEditingId(task.id);
    setForm({
      title: task.title,
      subject: task.subject,
      type: task.type,
      dueDate: task.dueDate,
      notificationDate: getNotificationDate(task),
      priority: task.priority,
      note: task.note,
    });
  }

  function handleDelete(taskId: string) {
    const task = tasks.find((currentTask) => currentTask.id === taskId);
    if (!task) return;

    const confirmed = window.confirm(`「${task.title}」を削除しますか？`);
    if (!confirmed) return;

    setTasks((currentTasks) => currentTasks.filter((currentTask) => currentTask.id !== taskId));

    if (editingId === taskId) {
      setEditingId(null);
      setForm(emptyForm);
    }
  }

  function toggleCompleted(taskId: string) {
    const now = new Date().toISOString();

    setTasks((currentTasks) =>
      currentTasks.map((task) =>
        task.id === taskId
          ? {
            ...task,
            completed: !task.completed,
            completedAt: task.completed ? undefined : now,
            updatedAt: now,
          }
          : task,
      ),
    );
  }

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
  }

  async function toggleNotifications() {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      setNotificationEnabled(false);
      setUseLocalNotificationFallback(false);
      return;
    }

    if (Notification.permission === "granted") {
      const nextEnabled = !notificationEnabled;
      let nextUseLocalFallback = false;
      setNotificationPermission("granted");

      if (nextEnabled) {
        if (isWebPushSupported()) {
          try {
            await ensureWebPushReady();
            await savePushAppState(tasks, true);
          } catch {
            nextUseLocalFallback = true;
            await savePushAppState(tasks, false).catch(() => undefined);
          }
        } else {
          nextUseLocalFallback = true;
          await savePushAppState(tasks, false).catch(() => undefined);
        }
      } else {
        await savePushAppState(tasks, false).catch(() => undefined);
      }

      setUseLocalNotificationFallback(nextUseLocalFallback);
      setNotificationEnabled(nextEnabled);
      void postServiceWorkerMessage({
        type: "SET_NOTIFICATION_ENABLED",
        notificationEnabled: nextEnabled,
        useLocalReminders: shouldUseLocalReminders(nextEnabled, nextUseLocalFallback),
      });
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);

    const nextEnabled = permission === "granted";

    if (permission === "granted") {
      let nextUseLocalFallback = false;

      if (isWebPushSupported()) {
        try {
          await ensureWebPushReady();
          await savePushAppState(tasks, true);
        } catch {
          nextUseLocalFallback = true;
          await savePushAppState(tasks, false).catch(() => undefined);
        }
      } else {
        nextUseLocalFallback = true;
        await savePushAppState(tasks, false).catch(() => undefined);
      }

      setUseLocalNotificationFallback(nextUseLocalFallback);
      setNotificationEnabled(nextEnabled);
      void postServiceWorkerMessage({
        type: "SYNC_ASSIGNMENTS",
        notificationEnabled: nextEnabled,
        useLocalReminders: shouldUseLocalReminders(nextEnabled, nextUseLocalFallback),
        tasks,
      });
    } else {
      setUseLocalNotificationFallback(false);
      setNotificationEnabled(nextEnabled);
    }
  }

  return (
    <main className="app-shell">
      <header className="mb-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-teal-700">
            <ClipboardList size={18} aria-hidden="true" />
            <span>課題・締め切り管理</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-secondary"
            disabled={notificationPermission === "unsupported"}
            type="button"
            onClick={toggleNotifications}
          >
            <Bell size={16} aria-hidden="true" />
            {getServiceWorkerLabel(notificationPermission, serviceWorkerState, notificationEnabled)}
          </button>
          <span className="badge badge-blue">未完了 {stats.open}</span>
          <span className="badge badge-amber">今日 {stats.today}</span>
          <span className="badge badge-red">期限切れ {stats.overdue}</span>
        </div>
      </header>

      <section className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        <form className="panel h-fit p-4 md:p-5" onSubmit={handleSubmit}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-bold text-slate-900">
              <Plus size={18} aria-hidden="true" />
              <h2>{editingId ? "課題を編集" : "課題を登録"}</h2>
            </div>
            {editingId && (
              <button
                aria-label="編集を取り消す"
                className="btn btn-secondary btn-icon"
                title="編集を取り消す"
                type="button"
                onClick={resetForm}
              >
                <RotateCcw size={17} aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="grid gap-3">
            <div className="field">
              <label htmlFor="title">課題名</label>
              <input
                required
                className="control"
                id="title"
                maxLength={80}
                placeholder="英語レポート"
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <div className="field">
                <label htmlFor="dueDate">締切日</label>
                <input
                  required
                  className="control"
                  id="dueDate"
                  type="date"
                  value={form.dueDate}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, dueDate: event.target.value }))
                  }
                />
              </div>

              <div className="field">
                <label htmlFor="notificationDate">通知日</label>
                <input
                  className="control"
                  id="notificationDate"
                  type="date"
                  value={form.notificationDate}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, notificationDate: event.target.value }))
                  }
                />
              </div>

              <div className="field">
                <label htmlFor="priority">優先度</label>
                <select
                  className="control"
                  id="priority"
                  value={form.priority}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      priority: event.target.value as Priority,
                    }))
                  }
                >
                  {PRIORITIES.map((priority) => (
                    <option key={priority.value} value={priority.value}>
                      {priority.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <div className="field">
                <label htmlFor="subject">科目</label>
                <input
                  className="control"
                  id="subject"
                  list="subject-options"
                  maxLength={40}
                  placeholder="情報基礎"
                  value={form.subject}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, subject: event.target.value }))
                  }
                />
                <datalist id="subject-options">
                  {subjects.map((subject) => (
                    <option key={subject} value={subject} />
                  ))}
                </datalist>
              </div>

              <div className="field">
                <label htmlFor="type">種類</label>
                <select
                  className="control"
                  id="type"
                  value={form.type}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, type: event.target.value as TaskType }))
                  }
                >
                  {TASK_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label htmlFor="note">メモ</label>
              <textarea
                className="control h-[150px] resize-none overflow-scroll overflow-x-hidden"
                id="note"
                maxLength={240}
                placeholder="提出場所や範囲など"
                value={form.note}
                onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              />
            </div>

            <button className="btn btn-primary w-full" type="submit">
              <Plus size={17} aria-hidden="true" />
              {editingId ? "更新する" : "登録する"}
            </button>
          </div>
        </form>

        <div className="grid min-w-0 gap-5">
          <section className="panel p-4 md:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-bold text-slate-900">
                <Bell size={18} aria-hidden="true" />
                <h2>締切アラート</h2>
              </div>
              <span className="text-sm font-bold text-slate-500">
                完了 {stats.completed} / 全体 {stats.total}
              </span>
            </div>

            {closeTasks.length > 0 ? (
              <div className="grid gap-2 md:grid-cols-2">
                {closeTasks.map((task) => {
                  const dueStatus = getDueStatus(task);
                  const notificationDate = getNotificationDate(task);

                  return (
                    <div
                      className="flex min-h-[58px] min-w-0 items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
                      key={task.id}
                    >
                      <div className="min-w-0">
                        <p className="task-title font-bold text-slate-900">{task.title}</p>
                        <p className="task-title text-sm text-slate-600">
                          {task.subject} / 通知日 {formatDate(notificationDate)} / 締切 {formatDate(task.dueDate)}
                        </p>
                      </div>
                      <span className={badgeClass(dueStatus.tone)}>{dueStatus.label}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm font-bold text-slate-500">通知日を迎えた未完了課題はありません</p>
            )}
          </section>

          <section className="panel p-4 md:p-5">
            <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 font-bold text-slate-900">
                  <SlidersHorizontal size={18} aria-hidden="true" />
                  <h2>課題一覧</h2>
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
                  <label className="field">
                    <span className="sr-only">検索</span>
                    <span className="relative">
                      <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                        size={17}
                      />
                      <input
                        className="control search-control"
                        placeholder="課題名・科目・メモを検索"
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                      />
                    </span>
                  </label>
                  <label className="field">
                    <span className="sr-only">状態</span>
                    <select
                      className="control"
                      value={statusFilter}
                      onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                    >
                      <option value="open">未完了</option>
                      <option value="all">すべて</option>
                      <option value="completed">完了済み</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3 xl:w-[520px]">
                <label className="field">
                  <span className="sr-only">並び替え</span>
                  <select
                    className="control"
                    value={sortMode}
                    onChange={(event) => setSortMode(event.target.value as SortMode)}
                  >
                    <option value="dueDate">締切が近い順</option>
                    <option value="priority">優先度順</option>
                    <option value="createdAt">登録が新しい順</option>
                  </select>
                </label>
                <label className="field">
                  <span className="sr-only">科目</span>
                  <select
                    className="control"
                    value={subjectFilter}
                    onChange={(event) => setSubjectFilter(event.target.value)}
                  >
                    <option value="all">全科目</option>
                    {subjects.map((subject) => (
                      <option key={subject} value={subject}>
                        {subject}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="sr-only">種類</span>
                  <select
                    className="control"
                    value={typeFilter}
                    onChange={(event) => setTypeFilter(event.target.value as "all" | TaskType)}
                  >
                    <option value="all">全種類</option>
                    {TASK_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="grid gap-3">
              {filteredTasks.length > 0 ? (
                filteredTasks.map((task) => {
                  const dueStatus = getDueStatus(task);

                  return (
                    <article
                      className={`task-card ${dueStatus.className} p-3 md:p-4`}
                      key={task.id}
                    >
                      <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-start">
                        <button
                          aria-label={task.completed ? "未完了に戻す" : "完了にする"}
                          className="btn btn-secondary btn-icon"
                          title={task.completed ? "未完了に戻す" : "完了にする"}
                          type="button"
                          onClick={() => toggleCompleted(task.id)}
                        >
                          {task.completed ? (
                            <CheckCircle2 className="text-teal-700" size={19} aria-hidden="true" />
                          ) : (
                            <Circle size={19} aria-hidden="true" />
                          )}
                        </button>

                        <div className="min-w-0">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <h3
                              className={`task-title text-lg font-bold ${task.completed ? "text-slate-500 line-through" : "text-slate-950"
                                }`}
                            >
                              {task.title}
                            </h3>
                            <span className={badgeClass(dueStatus.tone)}>{dueStatus.label}</span>
                          </div>

                          <div className="mb-3 flex flex-wrap items-center gap-2">
                            <span className="badge badge-blue">
                              <CalendarDays size={13} aria-hidden="true" />
                              {formatDate(task.dueDate)}
                            </span>
                            <span className="badge badge-amber">
                              <Bell size={13} aria-hidden="true" />
                              通知日 {formatDate(getNotificationDate(task))}
                            </span>
                            <span className="badge badge-green">
                              <BookOpen size={13} aria-hidden="true" />
                              {task.subject}
                            </span>
                            <span className="badge badge-violet">
                              <Layers3 size={13} aria-hidden="true" />
                              {typeLabel[task.type]}
                            </span>
                            <span
                              className={
                                task.priority === "high"
                                  ? "badge badge-red"
                                  : task.priority === "medium"
                                    ? "badge badge-amber"
                                    : "badge badge-blue"
                              }
                            >
                              <Flag size={13} aria-hidden="true" />
                              優先度 {priorityLabel[task.priority]}
                            </span>
                          </div>

                          {task.note && (
                            <p className="task-title text-sm leading-6 text-slate-600">{task.note}</p>
                          )}
                        </div>

                        <div className="flex justify-end gap-2 md:justify-start">
                          <button
                            aria-label="課題を編集"
                            className="btn btn-secondary btn-icon"
                            title="課題を編集"
                            type="button"
                            onClick={() => handleEdit(task)}
                          >
                            <Pencil size={17} aria-hidden="true" />
                          </button>
                          <button
                            aria-label="課題を削除"
                            className="btn btn-danger btn-icon"
                            title="課題を削除"
                            type="button"
                            onClick={() => handleDelete(task.id)}
                          >
                            <Trash2 size={17} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                  <p className="font-bold text-slate-600">表示できる課題はありません</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
