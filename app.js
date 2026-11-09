
"use strict";

/* ======================================
   HZT APP
   Local Storage + Appwrite Realtime Sync
====================================== */

const LOGIN_USER = "KSP";
const LOGIN_PASS = "Phyo2026";

const DATA_KEY = "hzt_management_data_v2";
const SESSION_KEY = "hzt_login_session_v2";

const CLOUD_SNAPSHOT_KEY = "hzt_cloud_snapshot_v1";
const CLOUD_QUEUE_KEY = "hzt_cloud_queue_v1";

const APPWRITE_ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = "6af039570012a31c3131";
const APPWRITE_DATABASE_ID = "6af03bad0012adba73ce";
const APPWRITE_COLLECTION_ID = "hzt_records";

let appwriteClient = null;
let appwriteDatabases = null;

let cloudStarted = false;
let cloudReady = false;
let cloudSyncing = false;

let cloudSyncTimer = null;
let cloudPollTimer = null;
let cloudRealtimeTimer = null;
let cloudRealtimeRetryTimer = null;
let cloudRealtimeUnsubscribe = null;

let cloudListenersStarted = false;

let cloudSnapshot = loadCloudSnapshot();

const $ = id => document.getElementById(id);

/* ======================================
   CALENDAR STATE
====================================== */

let calendarDate = new Date();
let selectedDate = todayISO();

/* ======================================
   LOCAL DATA
====================================== */

function emptyData() {
  return {
    vouchers: [],
    events: [],
    notes: []
  };
}

function loadData() {
  try {
    const saved = JSON.parse(localStorage.getItem(DATA_KEY));

    return {
      vouchers: Array.isArray(saved?.vouchers) ? saved.vouchers : [],
      events: Array.isArray(saved?.events) ? saved.events : [],
      notes: Array.isArray(saved?.notes) ? saved.notes : []
    };
  } catch {
    return emptyData();
  }
}

let appData = loadData();

let pendingDeleteAction = null;
let purchaseItems = [];
let selectedReportDate = null;

function persistLocalData() {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(appData));
    return true;
  } catch {
    alert("အချက်အလက်သိမ်းဆည်း၍မရပါ။ ဖုန်း Storage နေရာစစ်ဆေးပါ။");
    return false;
  }
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

/* ======================================
   CLOUD SNAPSHOT / QUEUE
====================================== */

function loadCloudSnapshot() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(CLOUD_SNAPSHOT_KEY)
    );

    return {
      vouchers: Array.isArray(saved?.vouchers) ? saved.vouchers : [],
      events: Array.isArray(saved?.events) ? saved.events : [],
      notes: Array.isArray(saved?.notes) ? saved.notes : []
    };
  } catch {
    return emptyData();
  }
}

function saveCloudSnapshot() {
  try {
    localStorage.setItem(
      CLOUD_SNAPSHOT_KEY,
      JSON.stringify(cloudSnapshot)
    );
  } catch (error) {
    console.error("Cloud snapshot save error:", error);
  }
}

function loadCloudQueue() {
  try {
    const queue = JSON.parse(
      localStorage.getItem(CLOUD_QUEUE_KEY)
    );

    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

function saveCloudQueue(queue) {
  try {
    localStorage.setItem(
      CLOUD_QUEUE_KEY,
      JSON.stringify(queue)
    );
  } catch (error) {
    console.error("Cloud queue save error:", error);
  }
}

function cloudOperationKey(type, id) {
  return type + "::" + id;
}

function getRecordById(type, id, data = appData) {
  const list = data[type];

  if (!Array.isArray(list)) return null;

  return list.find(item => String(item.id) === String(id)) || null;
}

/* ======================================
   DETECT LOCAL CHANGES
====================================== */

function queueLocalChanges() {
  if (!cloudReady) return;

  const queue = loadCloudQueue();
  const queueMap = new Map();

  queue.forEach(item => {
    queueMap.set(
      cloudOperationKey(item.recordType, item.entityId),
      item
    );
  });

  const types = ["vouchers", "events", "notes"];

  types.forEach(type => {
    const oldList = cloudSnapshot[type] || [];
    const newList = appData[type] || [];

    const oldMap = new Map(
      oldList.map(item => [String(item.id), item])
    );

    const newMap = new Map(
      newList.map(item => [String(item.id), item])
    );

    const ids = new Set([
      ...oldMap.keys(),
      ...newMap.keys()
    ]);

    ids.forEach(id => {
      const oldRecord = oldMap.get(id);
      const newRecord = newMap.get(id);

      const key = cloudOperationKey(type, id);

      if (!newRecord && oldRecord) {
        const previous = queueMap.get(key);

        queueMap.set(key, {
          recordType: type,
          entityId: id,
          action: "delete",
          updatedAt:
            previous?.action === "delete"
              ? previous.updatedAt
              : new Date().toISOString(),
          record: null
        });

        return;
      }

      if (newRecord) {
        const oldJSON = oldRecord
          ? JSON.stringify(oldRecord)
          : "";

        const newJSON = JSON.stringify(newRecord);

        if (oldJSON !== newJSON) {
          const previous = queueMap.get(key);

          const samePendingRecord =
            previous?.action === "upsert" &&
            JSON.stringify(previous.record) === newJSON;

          queueMap.set(key, {
            recordType: type,
            entityId: id,
            action: "upsert",
            updatedAt: samePendingRecord
              ? previous.updatedAt
              : new Date().toISOString(),
            record: cloneData(newRecord)
          });
        } else {
          queueMap.delete(key);
        }
      }
    });
  });

  saveCloudQueue(Array.from(queueMap.values()));
}

/* ======================================
   LOCAL SAVE
====================================== */

function saveData() {
  if (!persistLocalData()) return false;

  queueLocalChanges();

  if (cloudReady) {
    scheduleCloudSync();
  }

  return true;
}

/* ======================================
   APPWRITE INITIALIZATION
====================================== */

function initializeAppwrite() {
  if (!window.Appwrite) {
    throw new Error(
      "Appwrite SDK မတွေ့ပါ။ index.html မှာ SDK script ကို စစ်ပါ။"
    );
  }

  appwriteClient = new Appwrite.Client();

  appwriteClient
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID);

  appwriteDatabases = new Appwrite.Databases(appwriteClient);
}

/* ======================================
   CLOUD STATUS DISPLAY
====================================== */

function ensureCloudStatusUI() {
  if ($("hztCloudStatus")) return;

  const status = document.createElement("div");

  status.id = "hztCloudStatus";

  status.style.cssText = `
    position:fixed;
    top:72px;
    right:12px;
    z-index:9999;
    padding:7px 12px;
    border-radius:30px;
    background:#202638;
    color:#ffffff;
    font-size:11px;
    font-weight:600;
    box-shadow:0 3px 12px rgba(0,0,0,.18);
    pointer-events:none;
  `;

  status.textContent = "☁ Cloud စတင်နေသည်...";

  document.body.appendChild(status);
}

function setCloudStatus(message, color = "#202638") {
  ensureCloudStatusUI();

  const status = $("hztCloudStatus");

  status.textContent = message;
  status.style.background = color;
}

/* ======================================
   FETCH ALL CLOUD DOCUMENTS
====================================== */

async function fetchAllCloudDocuments() {
  const allDocuments = [];
  const pageSize = 100;
  let offset = 0;

  while (true) {
    const response = await appwriteDatabases.listDocuments(
      APPWRITE_DATABASE_ID,
      APPWRITE_COLLECTION_ID,
      [
        Appwrite.Query.limit(pageSize),
        Appwrite.Query.offset(offset)
      ]
    );

    const documents = response.documents || [];

    allDocuments.push(...documents);

    if (
      documents.length < pageSize ||
      allDocuments.length >= response.total
    ) {
      break;
    }

    offset += pageSize;
  }

  return allDocuments;
}

/* ======================================
   REPLAY CLOUD OPERATIONS
====================================== */

function operationTime(operation) {
  return new Date(
    operation.updatedAt || 0
  ).getTime() || 0;
}

function getLatestCloudOperations(documents) {
  const latest = new Map();

  documents.forEach(document => {
    let payload;

    try {
      payload = JSON.parse(document.payload);
    } catch {
      return;
    }

    const type = document.recordType;

    if (!["vouchers", "events", "notes"].includes(type)) {
      return;
    }

    if (
      !payload ||
      !payload.entityId ||
      !["upsert", "delete"].includes(payload.action)
    ) {
      return;
    }

    const key = cloudOperationKey(
      type,
      payload.entityId
    );

    const operation = {
      recordType: type,
      entityId: String(payload.entityId),
      action: payload.action,
      updatedAt: payload.updatedAt || document.$createdAt,
      record: payload.record || null,
      documentTime: document.$createdAt || ""
    };

    const previous = latest.get(key);

    if (!previous) {
      latest.set(key, operation);
      return;
    }

    const newTime = operationTime(operation);
    const oldTime = operationTime(previous);

    if (
      newTime > oldTime ||
      (
        newTime === oldTime &&
        operation.documentTime > previous.documentTime
      )
    ) {
      latest.set(key, operation);
    }
  });

  return latest;
}

function applyCloudOperation(data, operation) {
  const type = operation.recordType;

  if (!Array.isArray(data[type])) return;

  data[type] = data[type].filter(
    item => String(item.id) !== String(operation.entityId)
  );

  if (
    operation.action === "upsert" &&
    operation.record
  ) {
    data[type].unshift(
      cloneData(operation.record)
    );
  }
}

function buildCloudData(latestOperations) {
  const result = emptyData();

  latestOperations.forEach(operation => {
    applyCloudOperation(result, operation);
  });

  return result;
}

/* ======================================
   INITIAL LOCAL DATA MIGRATION
====================================== */

function createInitialMigrationQueue(
  remoteData,
  latestOperations,
  cloudDocumentCount
) {
  const queue = loadCloudQueue();

  if (queue.length) return queue;

  const result = [];
  const types = ["vouchers", "events", "notes"];

  types.forEach(type => {
    const remoteMap = new Map(
      (remoteData[type] || []).map(
        item => [String(item.id), item]
      )
    );

    (appData[type] || []).forEach(record => {
      const id = String(record.id);

      const key = cloudOperationKey(type, id);
      const latest = latestOperations.get(key);

      if (latest?.action === "delete") {
        return;
      }

      if (remoteMap.has(id)) {
        return;
      }

      result.push({
        recordType: type,
        entityId: id,
        action: "upsert",
        updatedAt: new Date().toISOString(),
        record: cloneData(record)
      });
    });
  });

  saveCloudQueue(result);

  return result;
}

/* ======================================
   UPLOAD CLOUD OPERATIONS
====================================== */

async function uploadCloudQueue(queue) {
  let remaining = [...queue];

  for (const operation of queue) {
    const payload = {
      entityId: operation.entityId,
      action: operation.action,
      updatedAt: operation.updatedAt,
      record: operation.record
    };

    const payloadText = JSON.stringify(payload);

    if (payloadText.length > 10000) {
      setCloudStatus(
        "⚠ မှတ်တမ်းတစ်ခု အလွန်ကြီးနေသည်",
        "#a85b00"
      );

      console.error(
        "Payload exceeds 10000 characters:",
        operation.entityId
      );

      continue;
    }

    try {
      await appwriteDatabases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_COLLECTION_ID,
        Appwrite.ID.unique(),
        {
          recordType: operation.recordType,
          payload: payloadText
        }
      );

      applyCloudOperation(
        cloudSnapshot,
        operation
      );

      saveCloudSnapshot();

      remaining = remaining.filter(item => {
        const sameRecord =
          cloudOperationKey(item.recordType, item.entityId) ===
          cloudOperationKey(operation.recordType, operation.entityId);

        const sameVersion =
          item.updatedAt === operation.updatedAt &&
          item.action === operation.action;

        return !(sameRecord && sameVersion);
      });

      saveCloudQueue(remaining);

    } catch (error) {
      console.error("Appwrite upload error:", error);
    }
  }

  return remaining;
}

/* ======================================
   CLOUD SYNC
====================================== */

async function syncCloudNow() {
  if (
    !cloudReady ||
    cloudSyncing ||
    !navigator.onLine
  ) {
    return;
  }

  cloudSyncing = true;

  try {
    setCloudStatus("☁ Sync လုပ်နေသည်...", "#245b9b");

    const documents = await fetchAllCloudDocuments();

    const latestOperations =
      getLatestCloudOperations(documents);

    const remoteData =
      buildCloudData(latestOperations);

    createInitialMigrationQueue(
      remoteData,
      latestOperations,
      documents.length
    );

    const mergedData = cloneData(remoteData);

    const pendingQueue = loadCloudQueue();
    const stillPending = [];

    pendingQueue.forEach(operation => {
      const key = cloudOperationKey(
        operation.recordType,
        operation.entityId
      );

      const latest = latestOperations.get(key);

      if (
        latest &&
        operationTime(latest) >= operationTime(operation)
      ) {
        return;
      }

      stillPending.push(operation);

      applyCloudOperation(mergedData, operation);
    });

    saveCloudQueue(stillPending);

    appData = mergedData;

    if (!persistLocalData()) {
      throw new Error("Local data save failed");
    }

    cloudSnapshot = cloneData(remoteData);
    saveCloudSnapshot();

    await uploadCloudQueue(stillPending);

    setCloudStatus("☁ Cloud ချိတ်ဆက်ပြီး", "#18794e");

    refreshAll();

  } catch (error) {
    console.error("Cloud sync error:", error);

    setCloudStatus(
      "⚠ Cloud Sync မအောင်မြင်ပါ",
      "#a83232"
    );

  } finally {
    cloudSyncing = false;
  }
}

/* ======================================
   SCHEDULE CLOUD SYNC
====================================== */

function scheduleCloudSync() {
  if (!cloudReady) return;

  clearTimeout(cloudSyncTimer);

  cloudSyncTimer = setTimeout(() => {
    syncCloudNow();
  }, 700);
}

/* ======================================
   APPWRITE REALTIME
====================================== */

function stopCloudRealtime() {
  if (cloudRealtimeUnsubscribe) {
    try {
      cloudRealtimeUnsubscribe();
    } catch (error) {
      console.error("Realtime unsubscribe error:", error);
    }

    cloudRealtimeUnsubscribe = null;
  }

  clearTimeout(cloudRealtimeTimer);
  clearTimeout(cloudRealtimeRetryTimer);
}

function startCloudRealtime() {
  if (
    !cloudReady ||
    !appwriteClient ||
    !navigator.onLine ||
    cloudRealtimeUnsubscribe
  ) {
    return;
  }

  try {
    const channel =
      `databases.${APPWRITE_DATABASE_ID}.collections.${APPWRITE_COLLECTION_ID}.documents`;

    cloudRealtimeUnsubscribe = appwriteClient.subscribe(
      channel,
      response => {
        if (!response || !Array.isArray(response.events)) {
          return;
        }

        const isDocumentEvent = response.events.some(eventName =>
          String(eventName).includes(".documents.")
        );

        if (!isDocumentEvent) return;

        clearTimeout(cloudRealtimeTimer);

        cloudRealtimeTimer = setTimeout(() => {
          syncCloudNow();
        }, 600);
      }
    );

    console.log("HZT Appwrite Realtime connected.");

  } catch (error) {
    console.error("Realtime connection error:", error);

    cloudRealtimeUnsubscribe = null;

    clearTimeout(cloudRealtimeRetryTimer);

    cloudRealtimeRetryTimer = setTimeout(() => {
      startCloudRealtime();
    }, 5000);
  }
}

/* ======================================
   CLOUD NETWORK LISTENERS
====================================== */

function handleCloudOnline() {
  if (!cloudReady) return;

  stopCloudRealtime();

  setCloudStatus("☁ ပြန်လည်ချိတ်ဆက်နေသည်...", "#245b9b");

  syncCloudNow().then(() => {
    startCloudRealtime();
  });
}

function handleCloudFocus() {
  if (!cloudReady) return;

  syncCloudNow();
}

function handleCloudVisibility() {
  if (!document.hidden && cloudReady) {
    syncCloudNow();
  }
}

function installCloudListeners() {
  if (cloudListenersStarted) return;

  cloudListenersStarted = true;

  window.addEventListener("online", handleCloudOnline);
  window.addEventListener("focus", handleCloudFocus);

  document.addEventListener(
    "visibilitychange",
    handleCloudVisibility
  );
}

/* ======================================
   START CLOUD SYNC
====================================== */

async function startCloudSync() {
  if (cloudStarted) return;

  cloudStarted = true;

  ensureCloudStatusUI();

  try {
    initializeAppwrite();

    setCloudStatus("☁ Cloud ချိတ်ဆက်နေသည်...", "#245b9b");

    cloudReady = true;

    await syncCloudNow();

    queueLocalChanges();

    if (loadCloudQueue().length) {
      scheduleCloudSync();
    }

    startCloudRealtime();

    if (!cloudPollTimer) {
      cloudPollTimer = setInterval(() => {
        if (navigator.onLine && cloudReady) {
          syncCloudNow();
        }
      }, 25000);
    }

    installCloudListeners();

  } catch (error) {
    console.error("Appwrite initialization error:", error);

    cloudReady = false;
    cloudStarted = false;

    setCloudStatus(
      "⚠ Cloud ချိတ်ဆက်မရပါ",
      "#a83232"
    );
  }
}

/* ======================================
   COMMON FUNCTIONS
====================================== */

function money(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function todayISO() {
  const d = new Date();

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowDateTimeLocal() {
  const d = new Date();

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");

  return `${y}-${m}-${day}T${hour}:${minute}`;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

/* ======================================
   KSP VOUCHER LOGO
====================================== */

function voucherLogoHTML(detail = false) {
  return `
    <div class="voucher-brand ${detail ? "voucher-detail-brand" : ""}">
      <div class="voucher-brand-logo">KSP</div>
      <div class="voucher-brand-info">
        <strong>KSP နှင့် ညီကိုများအဖွဲ့</strong>
        <small>ဘောက်စက်အငှားဝန်ဆောင်မှု</small>
      </div>
    </div>
  `;
}

function normalizeVoucherDate(value) {
  if (!value) return "";

  const text = String(value);

  return /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? text + "T00:00"
    : text.slice(0, 16);
}

function getDateOnly(value) {
  return normalizeVoucherDate(value).slice(0, 10);
}

function formatDateTime(value) {
  const normalized = normalizeVoucherDate(value);

  if (!normalized) return "မရှိပါ";

  const [datePart, timePart = "00:00"] = normalized.split("T");
  const [year, month, day] = datePart.split("-");

  const names = [
    "ဇန်နဝါရီ", "ဖေဖော်ဝါရီ", "မတ်", "ဧပြီ",
    "မေ", "ဇွန်", "ဇူလိုင်", "ဩဂုတ်",
    "စက်တင်ဘာ", "အောက်တိုဘာ", "နိုဝင်ဘာ", "ဒီဇင်ဘာ"
  ];

  return `${day} ${names[Number(month) - 1] || month} ${year} — ${timePart}`;
}

function formatDateOnly(value) {
  if (!value) return "မရှိပါ";

  const [year, month, day] = String(value).split("-");

  const names = [
    "ဇန်နဝါရီ", "ဖေဖော်ဝါရီ", "မတ်", "ဧပြီ",
    "မေ", "ဇွန်", "ဇူလိုင်", "ဩဂုတ်",
    "စက်တင်ဘာ", "အောက်တိုဘာ", "နိုဝင်ဘာ", "ဒီဇင်ဘာ"
  ];

  if (!year || !month || !day) return "မရှိပါ";

  return `${day} ${names[Number(month) - 1] || month} ${year}`;
}

/* ======================================
   CUSTOM DELETE CONFIRMATION
====================================== */

function askDeleteConfirmation(title, message) {
  return new Promise(resolve => {
    pendingDeleteAction = resolve;

    $("confirmTitle").textContent = title;
    $("confirmText").textContent = message;
    $("confirmModal").classList.remove("hidden");
  });
}

function closeConfirmModal(result) {
  $("confirmModal").classList.add("hidden");

  if (pendingDeleteAction) {
    const resolve = pendingDeleteAction;
    pendingDeleteAction = null;
    resolve(result);
  }
}

$("confirmCancel").addEventListener("click", () => {
  closeConfirmModal(false);
});

$("confirmDelete").addEventListener("click", () => {
  closeConfirmModal(true);
});

$("confirmModal").addEventListener("click", event => {
  if (event.target === $("confirmModal")) {
    closeConfirmModal(false);
  }
});

document.addEventListener("keydown", event => {
  if (
    event.key === "Escape" &&
    !$("confirmModal").classList.contains("hidden")
  ) {
    closeConfirmModal(false);
  }
});

/* ======================================
   LOGIN / LOGOUT
====================================== */

function showApp() {
  $("loginScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");

  refreshAll();

  startCloudSync();
}

function showLogin() {
  $("appScreen").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
}

$("togglePassword").addEventListener("click", () => {
  const input = $("loginPassword");

  const show = input.type === "password";

  input.type = show ? "text" : "password";

  $("togglePassword").textContent = show ? "🙈" : "👁";
});

$("loginForm").addEventListener("submit", event => {
  event.preventDefault();

  const username = $("loginUsername").value.trim();
  const password = $("loginPassword").value;

  if (username === LOGIN_USER && password === LOGIN_PASS) {
    sessionStorage.setItem(SESSION_KEY, "authenticated");

    $("loginMessage").textContent = "";
    $("loginPassword").value = "";
    $("loginPassword").type = "password";
    $("togglePassword").textContent = "👁";

    showApp();

  } else {
    $("loginMessage").textContent =
      "Username သို့မဟုတ် Password မှားနေပါသည်။ ပြန်စစ်ပါ။";

    $("loginPassword").value = "";
    $("loginPassword").focus();
  }
});

$("logoutBtn").addEventListener("click", async () => {
  const ok = await askDeleteConfirmation(
    "Logout ထွက်မှာ သေချာပါသလား။",
    "အကောင့်မှ ထွက်လိုပါသလား။ သိမ်းထားသောစာရင်းများကို မဖျက်ပါ။"
  );

  if (!ok) return;

  sessionStorage.removeItem(SESSION_KEY);

  $("loginUsername").value = "";
  $("loginPassword").value = "";

  showLogin();
});

/* ======================================
   PAGE NAVIGATION
====================================== */

function openPage(pageName) {
  document.querySelectorAll(".page").forEach(page =>
    page.classList.remove("active")
  );

  const target = $("page-" + pageName);

  if (!target) return;

  target.classList.add("active");

  document.querySelectorAll(".nav-btn").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.page === pageName
    );
  });

  $("themePanel").classList.add("hidden");

  if (pageName === "history") renderVoucherHistory();
  if (pageName === "events") renderEvents();
  if (pageName === "notes") renderNotes();
  if (pageName === "calendar") renderCalendar();

  if (pageName === "daily-report") {
    renderDailyReport();
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.addEventListener("click", event => {
  const button = event.target.closest("[data-page]");

  if (button) openPage(button.dataset.page);
});

/* ======================================
   THEME
====================================== */

const savedTheme = localStorage.getItem("hzt_theme_v2");

if (["light", "dark", "color"].includes(savedTheme)) {
  document.documentElement.dataset.theme = savedTheme;
}

$("themeBtn").addEventListener("click", () => {
  $("themePanel").classList.toggle("hidden");
});

document.querySelectorAll("[data-theme-choice]").forEach(button => {
  button.addEventListener("click", () => {
    const theme = button.dataset.themeChoice;

    if (!["light", "dark", "color"].includes(theme)) return;

    document.documentElement.dataset.theme = theme;

    localStorage.setItem("hzt_theme_v2", theme);

    $("themePanel").classList.add("hidden");
  });
});

document.addEventListener("click", event => {
  if (
    !$("themePanel").contains(event.target) &&
    !$("themeBtn").contains(event.target)
  ) {
    $("themePanel").classList.add("hidden");
  }
});

/* ======================================
   VOUCHER
====================================== */

function nextVoucherNumber(dateTimeValue) {
  const datePart = normalizeVoucherDate(dateTimeValue).slice(0, 10);
  const dateCode = datePart.replaceAll("-", "");
  const next = appData.vouchers.length + 1;

  return "KSP-" + dateCode + "-" + String(next).padStart(4, "0");
}

function prepareVoucherForm() {
  const dateTime = nowDateTimeLocal();

  $("voucherDate").value = dateTime;
  $("voucherNumber").value = nextVoucherNumber(dateTime);

  updateVoucherBalance();
}

$("voucherDate").addEventListener("change", () => {
  $("voucherNumber").value =
    nextVoucherNumber($("voucherDate").value);
});

function updateVoucherBalance() {
  const amount = Number($("voucherAmount").value || 0);
  const deposit = Number($("voucherDeposit").value || 0);
  const remaining = amount - deposit;

  $("voucherRemaining").textContent =
    money(remaining) + " ကျပ်";

  $("voucherRemaining").style.color =
    remaining < 0 ? "var(--danger)" : "var(--primary)";
}

$("voucherAmount").addEventListener("input", updateVoucherBalance);
$("voucherDeposit").addEventListener("input", updateVoucherBalance);

$("voucherForm").addEventListener("reset", () => {
  setTimeout(prepareVoucherForm, 0);
});

$("voucherForm").addEventListener("submit", event => {
  event.preventDefault();

  const amount = Number($("voucherAmount").value);
  const deposit = Number($("voucherDeposit").value || 0);
  const dateTime = $("voucherDate").value;

  // ပွဲစမည့်ရက်စွဲကို သီးခြားရယူခြင်း
  const eventDate = $("voucherEventDate").value;

  if (!dateTime || amount < 0 || deposit < 0 || deposit > amount) {
    $("voucherMessage").textContent =
      "ရက်စွဲ၊ ငွေပမာဏနှင့် စရန်ငွေကို ပြန်စစ်ပါ။";

    return;
  }

  const voucher = {
    id: makeId(),
    number: nextVoucherNumber(dateTime),

    // ဘောင်ချာထုတ်သည့် ရက်စွဲနှင့် အချိန်
    date: dateTime,

    // ပွဲစမည့်ရက်စွဲ (သီးခြား)
    eventDate: eventDate,

    renterName: $("renterName").value.trim(),
    renterPhone: $("renterPhone").value.trim(),
    eventName: $("eventName").value.trim(),
    eventAddress: $("eventAddress").value.trim(),
    eventPerson: $("eventPerson").value.trim(),
    eventPhone: $("eventPhone").value.trim(),
    description: $("voucherDescription").value.trim(),
    amount,
    deposit,
    remaining: amount - deposit,
    note: $("voucherNote").value.trim(),
    createdAt: new Date().toISOString()
  };

  appData.vouchers.unshift(voucher);

  if (!saveData()) {
    appData.vouchers.shift();
    return;
  }

  $("voucherMessage").textContent =
    "ဘောင်ချာကို ရက်စွဲ၊ အချိန်နှင့်တကွ သိမ်းဆည်းပြီးပါပြီ။";

  $("voucherForm").reset();
  prepareVoucherForm();

  renderVoucherHistory();
  renderDailyReport();
  updateDashboard();
});

/* ======================================
   VOUCHER HISTORY / SEARCH
====================================== */

function renderVoucherHistory() {
  const query = $("voucherSearch").value.trim().toLowerCase();

  const startValue = $("historyStartDate").value;
  const endValue = $("historyEndDate").value;

  const start = startValue ? normalizeVoucherDate(startValue) : "";
  const end = endValue ? normalizeVoucherDate(endValue) : "";

  const filtered = appData.vouchers.filter(v => {
    const searchText = [
      v.number,
      v.renterName,
      v.renterPhone,
      v.eventName,
      v.eventPerson,
      v.eventPhone,
      v.eventAddress
    ].join(" ").toLowerCase();

    const date = normalizeVoucherDate(v.date);

    return (
      (!query || searchText.includes(query)) &&
      (!start || date >= start) &&
      (!end || date <= end)
    );
  });

  $("voucherRecordCount").textContent = filtered.length;

  if (!filtered.length) {
    $("voucherHistoryList").innerHTML =
      '<div class="empty-state">ဘောင်ချာမှတ်တမ်း မတွေ့ရှိပါ။</div>';

    return;
  }

  $("voucherHistoryList").innerHTML = filtered.map(v => `
    <article class="record-card">

      ${voucherLogoHTML()}

      <h3>${escapeHTML(v.number)}</h3>
      <p>ရက်စွဲ / အချိန် - ${escapeHTML(formatDateTime(v.date))}</p>
      <p>ပွဲစမည့်ရက်စွဲ - ${escapeHTML(formatDateOnly(v.eventDate))}</p>
      <p>ငှားသူ - ${escapeHTML(v.renterName)}</p>
      <p>ဖုန်း - ${escapeHTML(v.renterPhone || "မထည့်ထားပါ")}</p>
      <p>ပွဲအမည် - ${escapeHTML(v.eventName || "မထည့်ထားပါ")}</p>
      <p>ပွဲလိုက်သူ - ${escapeHTML(v.eventPerson || "မထည့်ထားပါ")}</p>
      <p>ပွဲလိုက်သူဖုန်း - ${escapeHTML(v.eventPhone || "မထည့်ထားပါ")}</p>
      <p>စုစုပေါင်း - ${money(v.amount)} ကျပ်</p>
      <p>စရန်ငွေ - ${money(v.deposit)} ကျပ်</p>
      <p>ကျန်ငွေ - ${money(v.remaining)} ကျပ်</p>

      <div class="record-actions">
        <button type="button" data-view-voucher="${escapeHTML(v.id)}">အသေးစိတ်ကြည့်ရန်</button>
        <button type="button" class="delete-btn" data-delete-voucher="${escapeHTML(v.id)}">Delete</button>
      </div>
    </article>
  `).join("");
}

$("voucherSearch").addEventListener("input", renderVoucherHistory);
$("historyStartDate").addEventListener("input", renderVoucherHistory);
$("historyEndDate").addEventListener("input", renderVoucherHistory);

$("clearVoucherSearch").addEventListener("click", () => {
  $("voucherSearch").value = "";
  $("historyStartDate").value = "";
  $("historyEndDate").value = "";

  renderVoucherHistory();
});

/* ======================================
   VOUCHER DETAIL / DELETE
====================================== */

function showVoucherDetail(id) {
  const v = appData.vouchers.find(item => item.id === id);

  if (!v) return;

  const rows = [
    ["ဘောင်ချာနံပါတ်", v.number],
    ["ရက်စွဲနှင့် အချိန်", formatDateTime(v.date)],
    ["ပွဲစမည့်ရက်စွဲ", formatDateOnly(v.eventDate)],
    ["ငှားသူအမည်", v.renterName],
    ["ငှားသူဖုန်း", v.renterPhone],
    ["ပွဲအမည်", v.eventName],
    ["ပွဲနေရာ", v.eventAddress],
    ["ပွဲလိုက်သူ", v.eventPerson],
    ["ပွဲလိုက်သူဖုန်း", v.eventPhone],
    ["ပစ္စည်း / ဝန်ဆောင်မှု", v.description],
    ["စုစုပေါင်းငွေ", money(v.amount) + " ကျပ်"],
    ["စရန်ငွေ", money(v.deposit) + " ကျပ်"],
    ["ကျန်ငွေ", money(v.remaining) + " ကျပ်"],
    ["မှတ်ချက်", v.note]
  ];

  $("voucherDetailContent").innerHTML =
    voucherLogoHTML(true) +
    rows.map(row => `
      <div class="detail-row">
        <span>${escapeHTML(row[0])}</span>
        <strong>${escapeHTML(row[1] || "မထည့်ထားပါ")}</strong>
      </div>
    `).join("");

  $("voucherModal").classList.remove("hidden");
}

async function deleteVoucher(id) {
  const voucher = appData.vouchers.find(v => v.id === id);

  if (!voucher) return;

  const ok = await askDeleteConfirmation(
    "ဘောင်ချာကို ဖျက်မှာ သေချာပါသလား။",
    `${voucher.number} ဘောင်ချာကို ဖျက်လိုပါသလား။ ဖျက်ပြီးပါက ပြန်ယူ၍မရပါ။`
  );

  if (!ok) return;

  const oldList = appData.vouchers;

  appData.vouchers = oldList.filter(v => v.id !== id);

  if (!saveData()) {
    appData.vouchers = oldList;
    return;
  }

  renderVoucherHistory();
  renderDailyReport();
  updateDashboard();
}

document.addEventListener("click", event => {
  const viewButton = event.target.closest("[data-view-voucher]");
  const deleteButton = event.target.closest("[data-delete-voucher]");

  if (viewButton) {
    showVoucherDetail(viewButton.dataset.viewVoucher);
  }

  if (deleteButton) {
    deleteVoucher(deleteButton.dataset.deleteVoucher);
  }

  if (event.target.dataset.closeModal === "true") {
    $("voucherModal").classList.add("hidden");
  }
});

$("closeVoucherModal").addEventListener("click", () => {
  $("voucherModal").classList.add("hidden");
});

/* ======================================
   EVENT EXPENSE CALCULATION
====================================== */

function getEventExpenseValue(eventRecord) {
  if (
    eventRecord.expense !== undefined &&
    eventRecord.expense !== null
  ) {
    return Number(eventRecord.expense || 0);
  }

  const items = Array.isArray(eventRecord.purchaseItems)
    ? eventRecord.purchaseItems
    : [];

  const purchaseTotal = items.reduce(
    (sum, item) => sum + Number(item.cost || 0),
    0
  );

  return (
    Number(eventRecord.otherExpense || 0) +
    Number(eventRecord.carFare || 0) +
    Number(eventRecord.threeWheelFare || 0) +
    Number(eventRecord.assistantPay || 0) +
    Number(eventRecord.fuelCost || 0) +
    purchaseTotal
  );
}

/* ======================================
   DAILY EVENT FINANCIAL REPORT
====================================== */

function buildDailyReportData() {
  const days = {};

  function getDay(date) {
    if (!date) return null;

    if (!days[date]) {
      days[date] = {
        date,
        events: [],
        income: 0,
        expense: 0,
        balance: 0
      };
    }

    return days[date];
  }

  appData.events.forEach(eventRecord => {
    const date = getDateOnly(eventRecord.date);
    const day = getDay(date);

    if (!day) return;

    const income = Number(eventRecord.income || 0);
    const expense = getEventExpenseValue(eventRecord);

    day.events.push(eventRecord);
    day.income += income;
    day.expense += expense;
  });

  return Object.values(days)
    .map(day => {
      day.balance = day.income - day.expense;
      return day;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function renderDailyReport() {
  const reports = buildDailyReportData();

  if (!reports.length) {
    $("dailyReportList").innerHTML =
      '<div class="empty-state">အခန်းနားစာရင်း မရှိသေးပါ။ အခန်းအနားစာရင်းထဲတွင် စာရင်းစတင်ထည့်ပါ။</div>';

    $("dailyReportDetail").classList.add("hidden");
    selectedReportDate = null;

    return;
  }

  if (!reports.some(day => day.date === selectedReportDate)) {
    selectedReportDate = reports[0].date;
  }

  $("dailyReportList").innerHTML = reports.map(day => `
    <button type="button"
      class="daily-report-card ${day.date === selectedReportDate ? "selected-day" : ""}"
      data-day-report="${escapeHTML(day.date)}">

      <div class="report-date">
        <span>📅 ${escapeHTML(formatDateOnly(day.date))}</span>
        <small>အသေးစိတ်ကြည့်ရန် ›</small>
      </div>

      <div class="daily-report-values">
        <div>
          <span>ဝင်ငွေ</span>
          <strong>${money(day.income)}</strong>
        </div>

        <div>
          <span>အသုံးစရိတ်</span>
          <strong>${money(day.expense)}</strong>
        </div>

        <div>
          <span>လက်ကျန်</span>
          <strong>${money(day.balance)}</strong>
        </div>
      </div>

    </button>
  `).join("");

  renderDailyReportDetail();
}

function renderDailyReportDetail() {
  const reports = buildDailyReportData();

  const day = reports.find(
    item => item.date === selectedReportDate
  );

  if (!day) {
    $("dailyReportDetail").classList.add("hidden");
    return;
  }

  $("dailyReportDetail").classList.remove("hidden");

  $("dailyDetailDate").textContent =
    formatDateOnly(day.date);

  $("dailyIncome").textContent =
    money(day.income) + " ကျပ်";

  $("dailyExpense").textContent =
    money(day.expense) + " ကျပ်";

  $("dailyBalance").textContent =
    money(day.balance) + " ကျပ်";

  if (!day.events.length) {
    $("dailyEventDetails").innerHTML =
      '<div class="empty-state">ဒီနေ့အတွက် အခန်းအနားစာရင်းမရှိပါ။</div>';

  } else {
    $("dailyEventDetails").innerHTML = day.events.map(e => {
      const expense = getEventExpenseValue(e);

      return `
        <article class="daily-item">
          <strong>${escapeHTML(e.name || "အမည်မရှိပါ")}</strong>
          <p>ရက်စွဲ - ${escapeHTML(e.date)}</p>
          <p>ဝင်ငွေ - ${money(e.income)} ကျပ်</p>
          <p>အသုံးစရိတ် - ${money(expense)} ကျပ်</p>
          <p class="daily-item-money">
            လက်ကျန် - ${money(Number(e.income || 0) - expense)} ကျပ်
          </p>
        </article>
      `;
    }).join("");
  }
}

$("dailyReportList").addEventListener("click", event => {
  const button = event.target.closest("[data-day-report]");

  if (!button) return;

  selectedReportDate = button.dataset.dayReport;

  renderDailyReport();
});

/* ======================================
   EVENT PURCHASE ITEMS
====================================== */

function getPurchaseTotal() {
  return purchaseItems.reduce(
    (sum, item) => sum + Number(item.cost || 0),
    0
  );
}

function renderPurchaseItems() {
  const total = getPurchaseTotal();

  $("purchaseItemsTotal").textContent =
    money(total) + " ကျပ်";

  if (!purchaseItems.length) {
    $("purchaseItemsList").innerHTML =
      '<p class="empty-state">ဝယ်ယူထားသော ပစ္စည်း မထည့်ရသေးပါ။</p>';

    updateEventBalance();
    return;
  }

  $("purchaseItemsList").innerHTML = purchaseItems.map(item => `
    <div class="purchase-item-row">
      <div>
        <strong>${escapeHTML(item.name)}</strong>
        <small>အရေအတွက် - ${escapeHTML(item.quantity)}</small>
        <small>ကုန်ကျငွေ - ${money(item.cost)} ကျပ်</small>
      </div>
      <button type="button" class="delete-btn"
        data-remove-purchase="${escapeHTML(item.id)}">ဖယ်မည်</button>
    </div>
  `).join("");

  updateEventBalance();
}

$("addPurchaseItem").addEventListener("click", () => {
  const name = $("purchaseItemName").value.trim();
  const quantity = Number($("purchaseItemQuantity").value || 0);
  const costText = $("purchaseItemCost").value;
  const cost = Number(costText);

  if (!name) {
    alert("ဝယ်ယူသော ပစ္စည်းအမည် ထည့်ပါ။");
    $("purchaseItemName").focus();
    return;
  }

  if (quantity <= 0 || costText === "" || cost < 0) {
    alert("အရေအတွက်နဲ့ ကုန်ကျငွေကို မှန်ကန်စွာ ထည့်ပါ။");
    return;
  }

  purchaseItems.push({
    id: makeId(),
    name,
    quantity,
    cost
  });

  $("purchaseItemName").value = "";
  $("purchaseItemQuantity").value = "1";
  $("purchaseItemCost").value = "";

  renderPurchaseItems();
});

$("purchaseItemsList").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-purchase]");

  if (!button) return;

  purchaseItems = purchaseItems.filter(
    item => item.id !== button.dataset.removePurchase
  );

  renderPurchaseItems();
});

function getEventExpense() {
  const normalExpenses = [
    "otherExpense",
    "carFare",
    "threeWheelFare",
    "assistantPay",
    "fuelCost"
  ].reduce((sum, id) => sum + Number($(id).value || 0), 0);

  return normalExpenses + getPurchaseTotal();
}

function updateEventBalance() {
  const income = Number($("eventIncome").value || 0);
  const expense = getEventExpense();

  $("eventBalancePreview").textContent =
    money(income - expense) + " ကျပ်";
}

[
  "eventIncome",
  "otherExpense",
  "carFare",
  "threeWheelFare",
  "assistantPay",
  "fuelCost"
].forEach(id => {
  $(id).addEventListener("input", updateEventBalance);
});

/* ======================================
   SAVE EVENT
====================================== */

$("eventForm").addEventListener("submit", event => {
  event.preventDefault();

  const income = Number($("eventIncome").value || 0);
  const expense = getEventExpense();

  const record = {
    id: makeId(),
    name: $("accountEventName").value.trim(),
    date: $("accountEventDate").value,
    income,
    otherExpense: Number($("otherExpense").value || 0),
    carFare: Number($("carFare").value || 0),
    threeWheelFare: Number($("threeWheelFare").value || 0),
    assistantCount: Number($("assistantCount").value || 0),
    assistantPay: Number($("assistantPay").value || 0),
    fuelQuantity: Number($("fuelQuantity").value || 0),
    fuelCost: Number($("fuelCost").value || 0),

    purchaseItems: purchaseItems.map(item => ({ ...item })),
    purchaseTotal: getPurchaseTotal(),

    expense,
    balance: income - expense
  };

  appData.events.unshift(record);

  if (!saveData()) {
    appData.events.shift();
    return;
  }

  $("eventMessage").textContent =
    "အခန်းအနားစာရင်း သိမ်းပြီးပါပြီ။";

  $("eventForm").reset();

  purchaseItems = [];

  $("accountEventDate").value = todayISO();

  renderPurchaseItems();
  updateEventBalance();
  renderEvents();
  renderDailyReport();
  updateDashboard();
});

/* ======================================
   RENDER / DELETE EVENTS
====================================== */

function renderEvents() {
  if (!appData.events.length) {
    $("eventRecordList").innerHTML =
      '<div class="empty-state">အခန်းအနားစာရင်း မရှိသေးပါ။</div>';

    return;
  }

  $("eventRecordList").innerHTML = appData.events.map(e => {
    const items = Array.isArray(e.purchaseItems)
      ? e.purchaseItems
      : [];

    const purchaseTotal = Number(
      e.purchaseTotal ??
      items.reduce((sum, item) =>
        sum + Number(item.cost || 0), 0)
    );

    const itemHTML = items.length
      ? items.map(item => `
          <p>• ${escapeHTML(item.name)} —
          အရေအတွက် ${escapeHTML(item.quantity)} —
          ${money(item.cost)} ကျပ်</p>
        `).join("")
      : "<p>ဝယ်ယူပစ္စည်း မရှိပါ။</p>";

    const expense = getEventExpenseValue(e);
    const balance = Number(e.income || 0) - expense;

    return `
      <article class="record-card">
        <h3>${escapeHTML(e.name)}</h3>
        <p>ရက်စွဲ - ${escapeHTML(e.date)}</p>
        <p>ဝင်ငွေ - ${money(e.income)} ကျပ်</p>
        <p>အခြားအသုံးစရိတ် - ${money(e.otherExpense)} ကျပ်</p>
        <p>ကားခ - ${money(e.carFare)} ကျပ်</p>
        <p>သုံးဘီးခ - ${money(e.threeWheelFare)} ကျပ်</p>
        <p>အကူအရေအတွက် - ${money(e.assistantCount)}</p>
        <p>အကူလုပ်အားခ - ${money(e.assistantPay)} ကျပ်</p>
        <p>ဆီပမာဏ - ${money(e.fuelQuantity)}</p>
        <p>ဆီဖိုး - ${money(e.fuelCost)} ကျပ်</p>

        <div class="purchase-record">
          <strong>ဝယ်ယူသုံးစွဲသော ပစ္စည်းများ</strong>
          ${itemHTML}
          <p><strong>ပစ္စည်းဝယ်ယူမှု စုစုပေါင်း - ${money(purchaseTotal)} ကျပ်</strong></p>
        </div>

        <p>စုစုပေါင်းအသုံးစရိတ် - ${money(expense)} ကျပ်</p>
        <p><strong>လက်ကျန် - ${money(balance)} ကျပ်</strong></p>

        <div class="record-actions">
          <button class="delete-btn" data-delete-event="${escapeHTML(e.id)}" type="button">Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

async function deleteEvent(id) {
  const record = appData.events.find(e => e.id === id);

  if (!record) return;

  const ok = await askDeleteConfirmation(
    "အခန်းအနားစာရင်း ဖျက်မှာ သေချာပါသလား။",
    `${record.name} စာရင်းနှင့် ၎င်း၏ ဝယ်ယူပစ္စည်းစာရင်းများကိုပါ ဖျက်မည်။`
  );

  if (!ok) return;

  const oldList = appData.events;

  appData.events = oldList.filter(e => e.id !== id);

  if (!saveData()) {
    appData.events = oldList;
    return;
  }

  renderEvents();
  renderDailyReport();
  updateDashboard();
}

$("eventRecordList").addEventListener("click", event => {
  const button = event.target.closest("[data-delete-event]");

  if (button) {
    deleteEvent(button.dataset.deleteEvent);
  }
});

/* ======================================
   NOTES
====================================== */

$("noteForm").addEventListener("submit", event => {
  event.preventDefault();

  const note = {
    id: makeId(),
    title: $("noteTitle").value.trim(),
    content: $("noteContent").value.trim(),
    date: todayISO(),
    createdAt: new Date().toISOString()
  };

  appData.notes.unshift(note);

  if (!saveData()) {
    appData.notes.shift();
    return;
  }

  $("noteMessage").textContent = "မှတ်စုသိမ်းပြီးပါပြီ.";

  $("noteForm").reset();

  renderNotes();
});

function renderNotes() {
  if (!appData.notes.length) {
    $("noteList").innerHTML =
      '<div class="empty-state">မှတ်စုမရှိသေးပါ။</div>';

    return;
  }

  $("noteList").innerHTML = appData.notes.map(note => `
    <article class="record-card">
      <h3>${escapeHTML(note.title)}</h3>
      <p>${escapeHTML(note.content).replace(/\n/g, "<br>")}</p>
      <p>${escapeHTML(note.date)}</p>
      <div class="record-actions">
        <button class="delete-btn" data-delete-note="${escapeHTML(note.id)}" type="button">Delete</button>
      </div>
    </article>
  `).join("");
}

async function deleteNote(id) {
  const note = appData.notes.find(n => n.id === id);

  if (!note) return;

  const ok = await askDeleteConfirmation(
    "မှတ်စုကို ဖျက်မှာ သေချာပါသလား။",
    `"${note.title}" မှတ်စုကို ဖျက်လိုပါသလား။`
  );

  if (!ok) return;

  const oldList = appData.notes;

  appData.notes = oldList.filter(n => n.id !== id);

  if (!saveData()) {
    appData.notes = oldList;
    return;
  }

  renderNotes();
}

$("noteList").addEventListener("click", event => {
  const button = event.target.closest("[data-delete-note]");

  if (button) {
    deleteNote(button.dataset.deleteNote);
  }
});

/* ======================================
   CALENDAR
====================================== */

const monthNames = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL",
  "MAY", "JUNE", "JULY", "AUGUST",
  "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"
];

const burmeseDigits = "၀၁၂၃၄၅၆၇၈၉";

const weekdayNames = [
  "တနင်္ဂနွေ", "တနင်္လာ", "အင်္ဂါ", "ဗုဒ္ဓဟူး",
  "ကြာသပတေး", "သောကြာ", "စနေ"
];

function toMyanmarDigits(value) {
  return String(value).replace(/[0-9]/g, digit =>
    burmeseDigits[Number(digit)]
  );
}

function dateISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderCalendar() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();

  $("calendarMonthTitle").textContent =
    monthNames[month] + " " + year;

  $("calendarMyanmarMonth").textContent =
    "မြန်မာသက္ကရာဇ် ပြောင်းလဲမှု မချိတ်ဆက်ရသေးပါ";

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const previousMonthDays = new Date(year, month, 0).getDate();

  let html = "";

  for (let i = 0; i < 42; i++) {
    let date;
    let otherMonth = false;

    if (i < firstDay) {
      date = new Date(
        year,
        month - 1,
        previousMonthDays - firstDay + i + 1
      );

      otherMonth = true;

    } else if (i >= firstDay + daysInMonth) {
      date = new Date(
        year,
        month + 1,
        i - firstDay - daysInMonth + 1
      );

      otherMonth = true;

    } else {
      date = new Date(year, month, i - firstDay + 1);
    }

    const iso = dateISO(date);

    const classes = [
      "calendar-day",
      otherMonth ? "other-month" : "",
      iso === todayISO() ? "today" : "",
      iso === selectedDate ? "selected" : "",
      (date.getDay() === 0 || date.getDay() === 6)
        ? "weekend"
        : ""
    ].filter(Boolean).join(" ");

    html += `
      <button type="button" class="${classes}" data-calendar-date="${iso}">
        <span class="day-number">${date.getDate()}</span>
        <span class="day-mm">${toMyanmarDigits(date.getDate())}</span>
      </button>
    `;
  }

  $("calendarDays").innerHTML = html;

  const today = new Date();

  $("todayGregorianText").textContent =
    today.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });

  $("todayMyanmarText").textContent =
    weekdayNames[today.getDay()] +
    " — မြန်မာပြက္ခဒိန်ပြောင်းလဲမှု မချိတ်ဆက်ရသေးပါ";

  $("myanmarDate").textContent =
    "မြန်မာရက်စွဲစနစ် မချိတ်ဆက်ရသေးပါ";

  $("myanmarMonth").textContent =
    "မြန်မာလ ပြောင်းလဲမှု မချိတ်ဆက်ရသေးပါ";

  const chosen = new Date(selectedDate + "T00:00:00");

  $("selectedCalendarDate").textContent =
    chosen.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    });
}

$("prevMonth").addEventListener("click", () => {
  calendarDate.setMonth(calendarDate.getMonth() - 1);
  renderCalendar();
});

$("nextMonth").addEventListener("click", () => {
  calendarDate.setMonth(calendarDate.getMonth() + 1);
  renderCalendar();
});

$("calendarDays").addEventListener("click", event => {
  const button = event.target.closest("[data-calendar-date]");

  if (!button) return;

  selectedDate = button.dataset.calendarDate;

  const selected = new Date(selectedDate + "T00:00:00");

  calendarDate = new Date(
    selected.getFullYear(),
    selected.getMonth(),
    1
  );

  renderCalendar();
});

/* ======================================
   CALCULATOR
====================================== */

let calculatorExpression = "";

function updateCalculator() {
  $("calculatorDisplay").value =
    calculatorExpression || "0";
}

function calculateExpression(expression) {
  if (!/^[0-9+\-*/%.() ]+$/.test(expression)) {
    throw new Error("Invalid expression");
  }

  if (!expression.trim()) return 0;

  const result = Function(
    '"use strict"; return (' + expression + ')'
  )();

  if (!Number.isFinite(result)) {
    throw new Error("Invalid result");
  }

  return Number(result.toFixed(8));
}

document.querySelectorAll("[data-calc]").forEach(button => {
  button.addEventListener("click", () => {
    const value = button.dataset.calc;

    if (value === "clear") {
      calculatorExpression = "";
      updateCalculator();
      return;
    }

    if (value === "delete") {
      calculatorExpression = calculatorExpression.slice(0, -1);
      updateCalculator();
      return;
    }

    if (value === "=") {
      try {
        calculatorExpression = String(
          calculateExpression(calculatorExpression)
        );

      } catch {
        calculatorExpression = "";
        $("calculatorDisplay").value = "Error";
        return;
      }

      updateCalculator();
      return;
    }

    if ("+-*/%".includes(value)) {
      const last = calculatorExpression.slice(-1);

      if (!calculatorExpression && value !== "-") return;

      if ("+-*/%".includes(last)) {
        calculatorExpression =
          calculatorExpression.slice(0, -1) + value;
      } else {
        calculatorExpression += value;
      }

    } else if (value === ".") {
      const currentNumber =
        calculatorExpression.split(/[+\-*/%]/).pop();

      if (!currentNumber.includes(".")) {
        calculatorExpression += ".";
      }

    } else {
      calculatorExpression += value;
    }

    updateCalculator();
  });
});

/* ======================================
   DASHBOARD
====================================== */

function updateDashboard() {
  const voucherCount = appData.vouchers.length;

  const totalIncome = appData.events.reduce(
    (sum, e) => sum + Number(e.income || 0),
    0
  );

  const totalExpense = appData.events.reduce(
    (sum, e) => sum + getEventExpenseValue(e),
    0
  );

  const totalBalance = totalIncome - totalExpense;

  $("totalVouchers").textContent = money(voucherCount);
  $("totalIncome").textContent = money(totalIncome);
  $("totalExpense").textContent = money(totalExpense);
  $("totalBalance").textContent = money(totalBalance);

  renderDailyReport();
}

/* ======================================
   REFRESH APP
====================================== */

function refreshAll() {
  prepareVoucherForm();

  $("accountEventDate").value = todayISO();

  purchaseItems = [];

  renderPurchaseItems();
  updateVoucherBalance();
  updateEventBalance();

  renderVoucherHistory();
  renderEvents();
  renderNotes();
  renderCalendar();
  updateDashboard();
  renderDailyReport();
}

/* ======================================
   APP STARTUP
   IMPORTANT:
   Keep this section at the VERY END.
   All const / let declarations and
   event listeners must initialize first.
====================================== */

if (sessionStorage.getItem(SESSION_KEY) === "authenticated") {
  showApp();
} else {
  showLogin();
}
