let me = null;
let state = null;
let toastTimer;
let screenStream = null;

const BREAK = 50 * 60 * 1000;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];


/* =========================
   API
========================= */

async function api(path, opt = {}) {
  const r = await fetch("/api" + path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...opt
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw Error(d.error || "Ошибка");
  }

  return d;
}


/* =========================
   FORMAT
========================= */

function fmt(ms, short = false) {
  ms = Math.max(0, Math.floor(ms / 1000));

  const h = Math.floor(ms / 3600);
  const m = Math.floor((ms % 3600) / 60);
  const s = ms % 60;

  if (short) {
    return `${String(h * 60 + m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return [h, m, s]
    .map(x => String(x).padStart(2, "0"))
    .join(":");
}


/* =========================
   TOAST
========================= */

function toast(msg) {
  const el = $("#toast");

  if (!el) {
    alert(msg);
    return;
  }

  el.textContent = msg;
  el.classList.remove("hidden");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    el.classList.add("hidden");
  }, 3500);
}


/* =========================
   SCREEN SHARE
========================= */

async function requestFullScreenShare() {

  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getDisplayMedia
  ) {
    toast(
      "Этот браузер не поддерживает демонстрацию экрана."
    );

    return false;
  }

  try {

    const stream =
      await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "monitor"
        },
        audio: false,
        preferCurrentTab: false,
        selfBrowserSurface: "exclude",
        surfaceSwitching: "exclude",
        systemAudio: "exclude"
      });

    const track =
      stream.getVideoTracks()[0];

    if (!track) {

      stream
        .getTracks()
        .forEach(t => t.stop());

      toast("Не удалось получить экран.");

      return false;
    }

    const settings =
      track.getSettings();

    /*
      monitor = полный экран
      window  = отдельное окно
      browser = вкладка
    */

    if (settings.displaySurface !== "monitor") {

      stream
        .getTracks()
        .forEach(t => t.stop());

      alert(
        "Нельзя начать смену.\n\n" +
        "Для начала смены необходимо выбрать «Весь экран» / «Монитор».\n\n" +
        "Вы выбрали отдельное окно или вкладку.\n\n" +
        "Нажмите «Начать смену» ещё раз и выберите весь экран."
      );

      return false;
    }

    screenStream = stream;

    /*
      Если работник самостоятельно
      остановил демонстрацию.
    */

    track.addEventListener("ended", () => {

      screenStream = null;

      if (
        me?.role === "worker" &&
        state?.startedAt &&
        !state?.endedAt
      ) {
        toast(
          "Демонстрация экрана остановлена."
        );
      }
    });

    return true;

  } catch (err) {

    console.error(
      "Ошибка демонстрации экрана:",
      err.name,
      err.message
    );

    toast(
      "Ошибка демонстрации экрана: " +
      err.name +
      (err.message ? " — " + err.message : "")
    );

    return false;
  }
}

function stopScreenShare() {
  const stream = screenStream;
  screenStream = null;

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
}



/* =========================
   START SHIFT
========================= */

$("#startShift").onclick = async () => {

  $("#startShift").disabled = true;

  try {

    /*
      Сначала просим экран.
      Только после успешного выбора
      полного экрана начинаем смену.
    */

    const approved =
      await requestFullScreenShare();

    if (!approved) {

      $("#startShift").disabled = false;

      return;
    }

    state =
      await api("/worker/start", {
        method: "POST"
      });

    render();

    toast("Смена начата");

  } catch (e) {

    if (screenStream) {

      screenStream
        .getTracks()
        .forEach(t => t.stop());

      screenStream = null;
    }

    $("#startShift").disabled = false;

    toast(e.message);
  }
};


/* =========================
   LOGIN
========================= */

$("#loginForm").onsubmit = async e => {
  e.preventDefault();

  const login = $("#login").value.trim();
  const password = $("#password").value;

  try {
    const d = await api("/login", {
      method: "POST",
      body: JSON.stringify({
        login,
        password
      })
    });

    me = d.user;
    state = d.state;

    $("#loginPage").classList.add("hidden");
    $("#app").classList.remove("hidden");

    render();

  } catch (e) {
    $("#loginError").textContent = e.message;
  }
};


/* =========================
   LOGOUT
========================= */

document.querySelectorAll(".logout").forEach(btn => {
  btn.onclick = async () => {
  try {
    await api("/logout", {
      method: "POST"
    });
  } catch (e) {
    console.error(e);
  }

  stopScreenShare();

    me = null;
  state = null;

  $("#app").classList.add("hidden");
  $("#loginPage").classList.remove("hidden");
  };
});

/* =========================
   ACTION
========================= */

async function action(path) {
  const isResumeAction =
    path === "/worker/back" ||
    path === "/worker/rest-pause";

  const isBreakStartAction =
    path === "/worker/meal" ||
    path === "/worker/rest-start";

  let startedShareForResume = false;

  try {
    if (isResumeAction) {
      const approved = await requestFullScreenShare();
      if (!approved) return;
      startedShareForResume = true;
    }

    state = await api(path, { method: "POST" });

    if (isBreakStartAction) {
      stopScreenShare();
    }

    render();
    toast("Готово");
  } catch (e) {
    if (startedShareForResume) stopScreenShare();
    toast(e.message);
  }
}


/* =========================
   WORKER RENDER
========================= */

function renderWorker() {
  const s = state;
  const t = Date.now();

  $("#workerName").textContent = me.name;

  $("#workerPage").classList.remove("hidden");
  $("#adminPage").classList.add("hidden");

  $("#startShift").classList.toggle(
    "hidden",
    !!s.startedAt
  );

  $("#endShift").classList.toggle(
    "hidden",
    !s.startedAt || !!s.endedAt
  );

  $("#shiftStatus").textContent =
    s.endedAt
      ? "Смена завершена"
      : s.startedAt
        ? "Смена идёт"
        : "Смена не начата";

  if (s.startedAt && !s.endedAt) {
    $("#shiftTime").textContent =
      fmt(t - s.startedAt);
  } else {
    $("#shiftTime").textContent = "00:00:00";
  }

  const ml =
    s.meal
      ? Math.max(0, BREAK - (t - s.meal.startedAt))
      : BREAK;

  $("#mealTime").textContent = fmt(ml, true);

  $("#mealBtn").classList.toggle("hidden", !!s.meal?.finished);

  const mealExpired =
    !!s.meal &&
    (t - s.meal.startedAt >= BREAK);

  $("#backBtn").classList.toggle(
    "hidden",
    !(s.meal?.finished || mealExpired) ||
    s.meal.ack
  );

  $("#mealNotice").classList.toggle(
    "hidden",
    !(s.meal?.finished || mealExpired) ||
    s.meal.ack
  );

  $("#mealNotice").textContent =
    "Обед завершён — подтвердите возвращение.";

  $("#restTime").textContent =
    fmt(s.restRemaining || 0, true);

  $("#restStart").classList.toggle(
    "hidden",
    !!s.restRunning ||
    !s.startedAt ||
    !!s.endedAt ||
    (s.restRemaining || 0) <= 0
  );

  $("#restPause").classList.toggle(
    "hidden",
    !s.restRunning
  );

  $("#restStatus").textContent =
    s.restRunning
      ? "Перерыв идёт"
      : "Перерыв остановлен";

  $("#mealBtn").disabled =
    !s.startedAt ||
    !!s.endedAt ||
    !!s.meal;

  $("#restStart").disabled =
    !s.startedAt ||
    !!s.endedAt ||
    (s.restRemaining || 0) <= 0;

  $("#endShift").disabled =
    !s.startedAt ||
    !!s.endedAt;
}


/* =========================
   ADMIN RENDER
========================= */

function renderAdmin() {
  $("#workerPage").classList.add("hidden");
  $("#adminPage").classList.remove("hidden");

  $("#adminName").textContent = me.name;

  const workers = state.workers || [];

  $("#statActive").textContent =
    workers.filter(w => w.status === "active").length;

  $("#statMeal").textContent =
    workers.filter(w => w.status === "meal").length;

  $("#statRest").textContent =
    workers.filter(w => w.status === "rest").length;

  $("#statDone").textContent =
    workers.filter(w => w.status === "done").length;

  $("#allEvents").innerHTML =
    (state.events || [])
      .map(e => `
        <div class="event">
          <b>${e.workerName || ""}</b>
          <span>${e.text || ""}</span>
          <small>${e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}</small>
        </div>
      `)
      .join("");
}


/* =========================
   RENDER
========================= */

function render() {
  if (!me || !state) return;

  if (me.role === "admin") {
    renderAdmin();
  } else {
    renderWorker();
  }
}


/* =========================
   WORKER BUTTONS
========================= */

$("#mealBtn").onclick = () => action("/worker/meal");

$("#backBtn").onclick = () => action("/worker/back");

$("#restStart").onclick = () => action("/worker/rest-start");

$("#restPause").onclick = () => action("/worker/rest-pause");

$("#endShift").onclick = async () => {
  if (!confirm("Завершить смену?")) return;

  try {
    state = await api("/worker/end", {
      method: "POST"
    });

    stopScreenShare();

    render();

    toast("Смена завершена");
  } catch (e) {
    toast(e.message);
  }
};


/* =========================
   ADMIN BUTTONS
========================= */

$("#sendNotify").onclick = async () => {
  const worker = $("#notifyWorker").value;
  const message = $("#notifyText").value.trim();

  if (!message) {
    toast("Введите сообщение");
    return;
  }

  try {
    state = await api("/admin/notify", {
      method: "POST",
      body: JSON.stringify({
        worker,
        message
      })
    });

    $("#notifyText").value = "";

    render();

    toast("Уведомление отправлено");
  } catch (e) {
    toast(e.message);
  }
};


/* =========================
   ADMIN SHIFT SETTINGS
========================= */

$("#saveShiftHours").onclick = async () => {
  const hours = Number($("#shiftHours").value);

  if (!hours || hours <= 0) {
    toast("Укажите правильное время смены");
    return;
  }

  try {
    state = await api("/admin/settings", {
      method: "POST",
      body: JSON.stringify({
        shiftHours: hours
      })
    });

    render();

    toast("Настройки сохранены");
  } catch (e) {
    toast(e.message);
  }
};


/* =========================
   ADMIN RESET WORKER
========================= */

$$(".resetWorker").forEach(btn => {
  btn.onclick = async () => {
    const workerId = Number(btn.dataset.worker);

    if (!confirm("Сбросить смену этого работника?")) {
      return;
    }

    try {
      state = await api("/admin/reset-worker", {
        method: "POST",
        body: JSON.stringify({
          workerId
        })
      });

      render();

      toast("Смена работника сброшена");
    } catch (e) {
      toast(e.message);
    }
  };
});


/* =========================
   INITIAL LOAD
========================= */

async function init() {
  try {
    const d = await api("/worker/state");

    if (d.user) {
      me = d.user;
      state = d.state;

        $("#app").classList.add("hidden");
  $("#loginPage").classList.remove("hidden");
  };
});
      render();
    }
  } catch (e) {
    console.log("Пользователь не авторизован");
  }
}

init();


/* =========================
   AUTO REFRESH
========================= */

setInterval(async () => {
  if (!me) return;

  try {
    const d = await api("/worker/state");

    state = d.state;

    render();
  } catch (e) {
    console.error(e);
  }
}, 5000);
