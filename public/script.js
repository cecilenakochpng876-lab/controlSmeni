let me=null,state=null,toastTimer,screenStream=null;
const BREAK=50*60*1000;

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];

async function api(path,opt={}){
  let r=await fetch("/api"+path,{
    headers:{"Content-Type":"application/json"},
    ...opt
  });

  let d=await r.json().catch(()=>({}));

  if(!r.ok)throw Error(d.error||"Ошибка");

  return d;
}

function fmt(ms,short=false){
  ms=Math.max(0,Math.floor(ms/1000));

  let h=Math.floor(ms/3600),
      m=Math.floor(ms%3600/60),
      s=ms%60;

  return short
    ? `${String(h*60+m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
    : [h,m,s].map(x=>String(x).padStart(2,"0")).join(":");
}

function toast(x){
  let e=document.querySelector(".toast")||
    Object.assign(
      document.body.appendChild(document.createElement("div")),
      {className:"toast"}
    );

  e.textContent=x;
  e.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer=setTimeout(
    ()=>e.classList.remove("show"),
    2800
  );
}

function show(v){
  ["loginScreen","workerView","adminView"].forEach(x=>{
    if($("#"+x))
      $("#"+x).classList.add("hidden");
  });

  if($("#"+v))
    $("#"+v).classList.remove("hidden");
}


/* LOGIN */

$("#loginForm").onsubmit=async e=>{
  e.preventDefault();

  $("#loginError").classList.add("hidden");

  try{

    let d=await api("/login",{
      method:"POST",
      body:JSON.stringify({
        login:$("#login").value.trim(),
        password:$("#password").value
      })
    });

    me=d.user;
    state=d.state;

    show(
      me.role==="admin"
        ?"adminView"
        :"workerView"
    );

    render();

  }catch(err){

    $("#loginError").textContent=
      "Неверный логин или пароль";

    $("#loginError").classList.remove("hidden");
  }
};


/* LOGOUT */

$$(".logout").forEach(b=>b.onclick=async()=>{

  try{

    if(screenStream){

      screenStream
        .getTracks()
        .forEach(t=>t.stop());

      screenStream=null;
    }

    await api("/logout",{
      method:"POST"
    });

  }catch{}

  location.reload();
});


/*
  ЗАПРОС ПОЛНОГО ЭКРАНА

  Работник должен выбрать именно монитор / полный экран.
*/

async function requestFullScreenShare(){

  if(
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getDisplayMedia
  ){

    toast(
      "Этот браузер не поддерживает демонстрацию экрана."
    );

    return false;
  }

  try{

    const stream=
      await navigator.mediaDevices.getDisplayMedia({
        video:{
          displaySurface:"monitor"
        },
        audio:false,
        preferCurrentTab:false,
        selfBrowserSurface:"exclude",
        surfaceSwitching:"exclude",
        systemAudio:"exclude"
      });

    const track=
      stream.getVideoTracks()[0];

    if(!track){

      stream
        .getTracks()
        .forEach(t=>t.stop());

      toast("Не удалось получить экран.");

      return false;
    }

    const settings=
      track.getSettings();

    /*
      monitor = полный экран
      window  = отдельное окно
      browser = вкладка
    */

    if(settings.displaySurface!=="monitor"){

      stream
        .getTracks()
        .forEach(t=>t.stop());

      alert(
        "Нельзя начать смену.\n\n"+
        "Для начала смены необходимо выбрать «Весь экран» / «Монитор».\n\n"+
        "Вы выбрали отдельное окно или вкладку. "+
        "Пожалуйста, нажмите «Начать смену» ещё раз и выберите весь экран."
      );

      return false;
    }

    screenStream=stream;

    track.addEventListener("ended",()=>{

      screenStream=null;

      if(
        me?.role==="worker" &&
        state?.startedAt &&
        !state?.endedAt
      ){

        toast(
          "Демонстрация экрана остановлена."
        );
      }
    });

    return true;

  }catch(err){

    if(err.name==="NotAllowedError"){

      toast(
        "Демонстрация экрана отменена. Смена не начата."
      );

    }else{

      toast(
        "Не удалось начать демонстрацию экрана."
      );
    }

    return false;
  }
}


/*
  НАЧАЛО СМЕНЫ
*/

$("#startShift").onclick=async()=>{

  $("#startShift").disabled=true;

  try{

    const approved=
      await requestFullScreenShare();

    if(!approved){

      $("#startShift").disabled=false;

      return;
    }

    state=
      await api("/worker/start",{
        method:"POST"
      });

    render();

    toast("Смена начата");

  }catch(e){

    if(screenStream){

      screenStream
        .getTracks()
        .forEach(t=>t.stop());

      screenStream=null;
    }

    $("#startShift").disabled=false;

    toast(e.message);
  }
};


/* ОБЫЧНЫЕ ДЕЙСТВИЯ */

$("#endShift").onclick=
  ()=>action("/worker/end");

$("#mealBtn").onclick=
  ()=>action("/worker/meal");

$("#backBtn").onclick=
  ()=>action("/worker/back");

$("#restStart").onclick=
  ()=>action("/worker/rest-start");

$("#restPause").onclick=
  ()=>action("/worker/rest-pause");


async function action(p){

  try{

    state=
      await api(p,{
        method:"POST"
      });

    render();

    toast("Готово");

  }catch(e){

    toast(e.message);
  }
}


/* ADMIN NOTIFICATIONS */

$("#sendNotify").onclick=async()=>{

  let text=
    $("#notifyText").value.trim();

  if(!text)
    return toast("Введите сообщение");

  try{

    await api("/admin/notify",{
      method:"POST",
      body:JSON.stringify({
        target:$("#notifyWorker").value,
        text
      })
    });

    $("#notifyText").value="";

    toast("Уведомление отправлено");

    render();

  }catch(e){

    toast(e.message);
  }
};


/* ADMIN SETTINGS */

$("#saveSettings").onclick=async()=>{

  let hours=
    Number($("#shiftHours").value);

  try{

    state=
      await api("/admin/settings",{
        method:"POST",
        body:JSON.stringify({
          shiftHours:hours
        })
      });

    toast("Настройки сохранены");

    render();

  }catch(e){

    toast(e.message);
  }
};


/*
  СБРОС СМЕНЫ РАБОТНИКА
*/

async function resetWorker(workerId,workerName){

  const ok=confirm(
    `Сбросить текущую смену работника ${workerName}?\n\n`+
    `Будут сброшены:\n`+
    `• текущая смена\n`+
    `• время обеда\n`+
    `время дневного отдыха\n\n`+
    `История событий сохранится.`
  );

  if(!ok)
    return;

  try{

    await api("/admin/reset-worker",{
      method:"POST",
      body:JSON.stringify({
        workerId
      })
    });

    toast(
      `Смена ${workerName} сброшена`
    );

    await refresh();

  }catch(e){

    toast(e.message);
  }
}


/* REFRESH */

async function refresh(){

  if(!me)
    return;

  try{

    state=
      await api(
        me.role==="admin"
          ?"/admin/state"
          :"/worker/state"
      );

    render();

  }catch{}
}


/* RENDER */

function render(){

  if(!me)
    return;

  if(me.role==="admin")
    renderAdmin();
  else
    renderWorker();
}


/* WORKER */

function renderWorker(){

  let s=state,
      t=Date.now(),
      shift=s.startedAt
        ?((s.endedAt||t)-s.startedAt)
        :0;

  $("#workerName").textContent=
    me.name;

  $("#workerDate").textContent=
    new Date().toLocaleDateString("ru-RU");

  $("#shiftTime").textContent=
    fmt(shift);

  $("#shiftProgress").style.width=
    Math.min(
      100,
      shift/(state.shiftHours*3600000)*100
    )+"%";

  let st=$("#workerStatus");

  st.className=
    "status "+
    (
      s.endedAt
        ?"done"
        :s.restRunning
          ?"pause"
          :s.startedAt
            ?"on"
            :""
    );

  st.textContent=
    s.endedAt
      ?"Завершена"
      :s.restRunning
        ?"На отдыхе"
        :s.startedAt
          ?"Смена идет"
          :"Не начал";

  $("#startShift").disabled=
    !!s.startedAt;

  $("#endShift").disabled=
    !s.startedAt||!!s.endedAt;

  $("#mealBtn").disabled=
    !s.startedAt||
    !!s.endedAt||
    !!s.meal;

  let ml=s.meal
    ?Math.max(
        0,
        BREAK-(t-s.meal.startedAt)
      )
    :BREAK;

  $("#mealTime").textContent=
    fmt(ml,true);

  $("#mealBtn").classList.toggle(
    "hidden",
    !!s.meal?.finished
  );

  $("#backBtn").classList.toggle(
    "hidden",
    !s.meal?.finished||s.meal.ack
  );

  $("#mealNotice").classList.toggle(
    "hidden",
    !s.meal?.finished||s.meal.ack
  );

  $("#mealNotice").textContent=
    "Обед завершён — подтвердите возвращение.";

  let r=Math.max(
    0,
    s.restRemaining-
      (
        s.restRunning&&s.restLast
          ? t-s.restLast
          :0
      )
  );

  $("#restTime").textContent=
    fmt(r,true);

  $("#restStart").disabled=
    !s.startedAt||
    !!s.endedAt||
    s.restRunning||
    r<=0;

  $("#restPause").disabled=
    !s.restRunning;

  $("#myEvents").innerHTML=
    (s.events||[])
      .slice(0,30)
      .map(e=>
        `<div class="event">
          <time>
            ${new Date(e.at).toLocaleTimeString("ru-RU")}
          </time>
          ${e.text}
        </div>`
      )
      .join("")
      ||
      "<div class='muted'>Событий пока нет.</div>";

  if(s.notice){

    $("#workerNotice").textContent=
      "🔔 "+s.notice.text;

    $("#workerNotice").classList.remove(
      "hidden"
    );
  }
}


/* ADMIN */

function renderAdmin(){

  let ws=state.workers,
      active=0,
      meal=0,
      rest=0,
      done=0;

  $("#shiftHours").value=
    state.shiftHours;

  $("#adminWorkers").innerHTML=
    ws.map(s=>{

      let t=Date.now();

      let shift=s.startedAt
        ?((s.endedAt||t)-s.startedAt)
        :0;

      if(s.startedAt&&!s.endedAt)
        active++;

      if(s.meal&&!s.meal.finished)
        meal++;

      if(s.restRunning)
        rest++;

      if(s.endedAt)
        done++;

      let r=Math.max(
        0,
        s.restRemaining-
          (
            s.restRunning&&s.restLast
              ?t-s.restLast
              :0
          )
      );

      return `
        <div class="admin-worker">

          <div class="aw-head">

            <b>${s.name}</b>

            <span class="status ${
              s.endedAt
                ?"done"
                :s.restRunning
                  ?"pause"
                  :s.startedAt
                    ?"on"
                    :""
            }">
              ${
                s.endedAt
                  ?"Завершена"
                  :s.restRunning
                    ?"На отдыхе"
                    :s.startedAt
                      ?"Смена идет"
                      :"Не начал"
              }
            </span>

          </div>

          <div class="aw-time">
            ${fmt(shift)}
          </div>

          <div class="mini">

            <div>
              <small>🍽️ Обед</small>

              <b>
                ${
                  s.meal
                    ?(
                      s.meal.finished
                        ?(
                          s.meal.ack
                            ?"Я тут ✓"
                            :"Закончен"
                        )
                        :"Идёт"
                    )
                    :"Не брал"
                }
              </b>
            </div>

            <div>
              <small>☕ Отдых</small>

              <b>
                ${fmt(r,true)}
              </b>
            </div>

          </div>

          <!-- СБРОС СМЕНЫ -->
          <button
            class="reset-worker-btn"
            data-worker-id="${s.id}"
            data-worker-name="${s.name}"
            type="button"
          >
            🔄 Сбросить смену
          </button>

        </div>
      `;

    }).join("");


  /*
    Подключаем кнопки сброса после
    создания карточек работников.
  */

  $$(".reset-worker-btn").forEach(btn=>{

    btn.onclick=()=>{

      const id=
        Number(btn.dataset.workerId);

      const name=
        btn.dataset.workerName;

      resetWorker(id,name);
    };

  });


  $("#statActive").textContent=
    active;

  $("#statMeal").textContent=
    meal;

  $("#statRest").textContent=
    rest;

  $("#statDone").textContent=
    done;


  let ev=[];

  ws.forEach(s=>
    s.events.forEach(e=>
      ev.push({
        ...e,
        name:s.name
      })
    )
  );

  ev.sort(
    (a,b)=>b.at-a.at
  );

  $("#allEvents").innerHTML=
    ev.slice(0,80)
      .map(e=>
        `<div class="event">
          <time>
            ${new Date(e.at).toLocaleTimeString("ru-RU")}
          </time>

          <b>${e.name}</b>
          ${e.text}
        </div>`
      )
      .join("");
}


/* CLOCK + REFRESH */

setInterval(()=>{

  if($("#clock"))
    $("#clock").textContent=
      new Date().toLocaleTimeString("ru-RU");

  if(me)
    refresh();

},1000);  toastTimer=setTimeout(()=>e.classList.remove("show"),2800);
}

function show(v){
  ["loginScreen","workerView","adminView"].forEach(x=>{
    if($("#"+x))$("#"+x).classList.add("hidden");
  });

  if($("#"+v))$("#"+v).classList.remove("hidden");
}

/* LOGIN */
$("#loginForm").onsubmit=async e=>{
  e.preventDefault();

  $("#loginError").classList.add("hidden");

  try{
    let d=await api("/login",{
      method:"POST",
      body:JSON.stringify({
        login:$("#login").value.trim(),
        password:$("#password").value
      })
    });

    me=d.user;
    state=d.state;

    show(me.role==="admin"?"adminView":"workerView");
    render();

  }catch(err){
    $("#loginError").textContent="Неверный логин или пароль";
    $("#loginError").classList.remove("hidden");
  }
};

/* LOGOUT */
$$(".logout").forEach(b=>b.onclick=async()=>{
  try{
    if(screenStream){
      screenStream.getTracks().forEach(t=>t.stop());
      screenStream=null;
    }

    await api("/logout",{method:"POST"});
  }catch{}

  location.reload();
});


/*
  ЗАПРОС ПОЛНОГО ЭКРАНА

  Работник должен выбрать именно монитор / полный экран.
  Если выбран window или browser/tab — смена НЕ начинается.
*/
async function requestFullScreenShare(){

  if(!navigator.mediaDevices ||
     !navigator.mediaDevices.getDisplayMedia){

    toast("Этот браузер не поддерживает демонстрацию экрана.");
    return false;
  }

  try{

    const stream=await navigator.mediaDevices.getDisplayMedia({
      video:{
        displaySurface:"monitor"
      },
      audio:false,
      preferCurrentTab:false,
      selfBrowserSurface:"exclude",
      surfaceSwitching:"exclude",
      systemAudio:"exclude"
    });

    const track=stream.getVideoTracks()[0];

    if(!track){
      stream.getTracks().forEach(t=>t.stop());
      toast("Не удалось получить экран.");
      return false;
    }

    const settings=track.getSettings();

    /*
      displaySurface обычно:
      monitor = полный экран
      window  = отдельное окно
      browser = вкладка браузера
    */

    if(settings.displaySurface!=="monitor"){

      stream.getTracks().forEach(t=>t.stop());

      alert(
        "Нельзя начать смену.\n\n"+
        "Для начала смены необходимо выбрать «Весь экран» / «Монитор».\n\n"+
        "Вы выбрали отдельное окно или вкладку. "+
        "Пожалуйста, нажмите «Начать смену» ещё раз и выберите весь экран."
      );

      return false;
    }

    screenStream=stream;

    /*
      Если работник сам остановит демонстрацию экрана,
      фиксируем это отдельно.
    */
    track.addEventListener("ended",()=>{
      screenStream=null;

      if(me?.role==="worker" && state?.startedAt && !state?.endedAt){
        toast("Демонстрация экрана остановлена.");
      }
    });

    return true;

  }catch(err){

    /*
      Пользователь нажал Cancel / Отмена
    */
    if(err.name==="NotAllowedError"){
      toast("Демонстрация экрана отменена. Смена не начата.");
    }else{
      toast("Не удалось начать демонстрацию экрана.");
    }

    return false;
  }
}


/*
  НАЧАЛО СМЕНЫ

  Сначала экран.
  Только после успешного выбора полного экрана
  отправляется запрос на сервер.
*/
$("#startShift").onclick=async()=>{

  $("#startShift").disabled=true;

  try{

    const approved=await requestFullScreenShare();

    if(!approved){
      $("#startShift").disabled=false;
      return;
    }

    state=await api("/worker/start",{method:"POST"});

    render();

    toast("Смена начата");

  }catch(e){

    if(screenStream){
      screenStream.getTracks().forEach(t=>t.stop());
      screenStream=null;
    }

    $("#startShift").disabled=false;
    toast(e.message);
  }
};


/* ОБЫЧНЫЕ ДЕЙСТВИЯ */
$("#endShift").onclick=()=>action("/worker/end");
$("#mealBtn").onclick=()=>action("/worker/meal");
$("#backBtn").onclick=()=>action("/worker/back");
$("#restStart").onclick=()=>action("/worker/rest-start");
$("#restPause").onclick=()=>action("/worker/rest-pause");


async function action(p){

  try{

    state=await api(p,{method:"POST"});
    render();
    toast("Готово");

  }catch(e){
    toast(e.message);
  }
}


/* ADMIN NOTIFICATIONS */
$("#sendNotify").onclick=async()=>{

  let text=$("#notifyText").value.trim();

  if(!text)
    return toast("Введите сообщение");

  try{

    await api("/admin/notify",{
      method:"POST",
      body:JSON.stringify({
        target:$("#notifyWorker").value,
        text
      })
    });

    $("#notifyText").value="";
    toast("Уведомление отправлено");
    render();

  }catch(e){
    toast(e.message);
  }
};


/* ADMIN SETTINGS */
$("#saveSettings").onclick=async()=>{

  let hours=Number($("#shiftHours").value);

  try{

    state=await api("/admin/settings",{
      method:"POST",
      body:JSON.stringify({
        shiftHours:hours
      })
    });

    toast("Настройки сохранены");
    render();

  }catch(e){
    toast(e.message);
  }
};


/* REFRESH */
async function refresh(){

  if(!me)return;

  try{

    state=await api(
      me.role==="admin"
        ? "/admin/state"
        : "/worker/state"
    );

    render();

  }catch{}
}


/* RENDER */
function render(){

  if(!me)return;

  if(me.role==="admin")
    renderAdmin();
  else
    renderWorker();
}


/* WORKER */
function renderWorker(){

  let s=state,
      t=Date.now(),
      shift=s.startedAt
        ? ((s.endedAt||t)-s.startedAt)
        : 0;

  $("#workerName").textContent=me.name;

  $("#workerDate").textContent=
    new Date().toLocaleDateString("ru-RU");

  $("#shiftTime").textContent=fmt(shift);

  $("#shiftProgress").style.width=
    Math.min(
      100,
      shift/(state.shiftHours*3600000)*100
    )+"%";

  let st=$("#workerStatus");

  st.className=
    "status "+
    (
      s.endedAt
        ?"done"
        :s.restRunning
          ?"pause"
          :s.startedAt
            ?"on"
            :""
    );

  st.textContent=
    s.endedAt
      ?"Завершена"
      :s.restRunning
        ?"На отдыхе"
        :s.startedAt
          ?"Смена идет"
          :"Не начал";

  $("#startShift").disabled=!!s.startedAt;

  $("#endShift").disabled=
    !s.startedAt||!!s.endedAt;

  $("#mealBtn").disabled=
    !s.startedAt||
    !!s.endedAt||
    !!s.meal;

  let ml=s.meal
    ?Math.max(0,BREAK-(t-s.meal.startedAt))
    :BREAK;

  $("#mealTime").textContent=
    fmt(ml,true);

  $("#mealBtn").classList.toggle(
    "hidden",
    !!s.meal?.finished
  );

  $("#backBtn").classList.toggle(
    "hidden",
    !s.meal?.finished||s.meal.ack
  );

  $("#mealNotice").classList.toggle(
    "hidden",
    !s.meal?.finished||s.meal.ack
  );

  $("#mealNotice").textContent=
    "Обед завершён — подтвердите возвращение.";

  let r=Math.max(
    0,
    s.restRemaining-
      (s.restRunning&&s.restLast
        ? t-s.restLast
        :0)
  );

  $("#restTime").textContent=
    fmt(r,true);

  $("#restStart").disabled=
    !s.startedAt||
    !!s.endedAt||
    s.restRunning||
    r<=0;

  $("#restPause").disabled=
    !s.restRunning;

  $("#myEvents").innerHTML=
    (s.events||[])
      .slice(0,30)
      .map(e=>
        `<div class="event">
          <time>${new Date(e.at).toLocaleTimeString("ru-RU")}</time>
          ${e.text}
        </div>`
      )
      .join("")
      ||
      "<div class='muted'>Событий пока нет.</div>";

  if(s.notice){

    $("#workerNotice").textContent=
      "🔔 "+s.notice.text;

    $("#workerNotice").classList.remove("hidden");
  }
}


/* ADMIN */
function renderAdmin(){

  let ws=state.workers,
      active=0,
      meal=0,
      rest=0,
      done=0;

  $("#shiftHours").value=state.shiftHours;

  $("#adminWorkers").innerHTML=
    ws.map(s=>{

      let t=Date.now();

      let shift=s.startedAt
        ?((s.endedAt||t)-s.startedAt)
        :0;

      if(s.startedAt&&!s.endedAt)active++;

      if(s.meal&&!s.meal.finished)meal++;

      if(s.restRunning)rest++;

      if(s.endedAt)done++;

      let r=Math.max(
        0,
        s.restRemaining-
          (s.restRunning&&s.restLast
            ? t-s.restLast
            :0)
      );

      return `
        <div class="admin-worker">
          <div class="aw-head">
            <b>${s.name}</b>

            <span class="status ${
              s.endedAt
                ?"done"
                :s.restRunning
                  ?"pause"
                  :s.startedAt
                    ?"on"
                    :""
            }">
              ${
                s.endedAt
                  ?"Завершена"
                  :s.restRunning
                    ?"На отдыхе"
                    :s.startedAt
                      ?"Смена идет"
                      :"Не начал"
              }
            </span>
          </div>

          <div class="aw-time">
            ${fmt(shift)}
          </div>

          <div class="mini">

            <div>
              <small>🍽️ Обед</small>
              <b>
                ${
                  s.meal
                    ?(
                      s.meal.finished
                        ?(
                          s.meal.ack
                            ?"Я тут ✓"
                            :"Закончен"
                        )
                        :"Идёт"
                    )
                    :"Не брал"
                }
              </b>
            </div>

            <div>
              <small>☕ Отдых</small>
              <b>${fmt(r,true)}</b>
            </div>

          </div>
        </div>
      `;

    }).join("");

  $("#statActive").textContent=active;
  $("#statMeal").textContent=meal;
  $("#statRest").textContent=rest;
  $("#statDone").textContent=done;

  let ev=[];

  ws.forEach(s=>
    s.events.forEach(e=>
      ev.push({
        ...e,
        name:s.name
      })
    )
  );

  ev.sort((a,b)=>b.at-a.at);

  $("#allEvents").innerHTML=
    ev.slice(0,80)
      .map(e=>
        `<div class="event">
          <time>${new Date(e.at).toLocaleTimeString("ru-RU")}</time>
          <b>${e.name}</b> ${e.text}
        </div>`
      )
      .join("");
}


/* CLOCK + REFRESH */
setInterval(()=>{

  if($("#clock"))
    $("#clock").textContent=
      new Date().toLocaleTimeString("ru-RU");

  if(me)
    refresh();

},1000);
