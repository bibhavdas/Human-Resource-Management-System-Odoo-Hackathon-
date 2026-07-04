/* ============================================================
   Alignt HRMS — dashboard logic
   Static prototype: all data below is mocked in-memory and
   resets on reload. Firebase Firestore will replace EMPLOYEES,
   leaves, and payroll reads/writes later; the shapes here are
   deliberately kept close to what those documents would look like.
   ============================================================ */

/* ---- Require a session — no dashboard without signing in first ---- */
const session = getSession();
if (!session){
  window.location.href = "index.html";
  throw new Error("No session — redirecting to sign in.");
}

const CURRENT_USER = {
  name: session.name,
  empId: session.empId,
  title: session.role === "admin" ? "HR Administrator" : "Employee",
  email: session.email,
  phone: "",
  address: "",
  department: "—",
  manager: "—",
  joined: "—",
  initials: initialsOf(session.name)
};

/* ---------------------------------------------------------
   Mock data (stand-ins for Firestore collections)
   --------------------------------------------------------- */
const EMPLOYEES = [
  { name: "Arindam Basu", empId: "EMP-0011", dept: "Design", status: "present" },
  { name: "Riya Sen", empId: "EMP-0027", dept: "Engineering", status: "half" },
  { name: "Tanmoy Ghosh", empId: "EMP-0033", dept: "Engineering", status: "absent" },
  { name: "Priya Das", empId: "EMP-0019", dept: "HR", status: "present" },
  { name: "Sourav Mondal", empId: "EMP-0058", dept: "Sales", status: "present" }
];

const PAYROLL_SELF = [
  { label: "Basic pay", amount: 32000 },
  { label: "House rent allowance", amount: 9600 },
  { label: "Special allowance", amount: 4200 },
  { label: "Provident fund", amount: -3840, deduction: true },
  { label: "Professional tax", amount: -200, deduction: true }
];

let leaves = [
  { id: 1, who: "Arindam Basu", type: "Sick leave", from: "2026-06-18", to: "2026-06-19", remarks: "Fever, resting at home.", status: "approved" },
  { id: 2, who: "Riya Sen", type: "Unpaid leave", from: "2026-07-06", to: "2026-07-06", remarks: "Personal work.", status: "pending" },
  { id: 3, who: "Tanmoy Ghosh", type: "Sick leave", from: "2026-07-02", to: "2026-07-03", remarks: "", status: "pending" }
];
let leaveIdCounter = 4;

let punched = false;
let hoursToday = 0;

/* ---------------------------------------------------------
   Small helpers
   --------------------------------------------------------- */
const rupee = n => "₹" + Math.abs(n).toLocaleString("en-IN");

// Pushes an entry into the notification centre + shows a matching toast.
// Falls back to the plain toast() helper if notify.js isn't on the page.
function notifyEvent(type, title, message){
  if (typeof Notify !== "undefined"){
    Notify.notify({ type, title, message });
  } else {
    toast(message);
  }
}

/* ---------------------------------------------------------
   App shell / routing
   --------------------------------------------------------- */
let dashBadge = null;
let currentView = "dashboard";

function initApp(role){
  if (typeof Notify !== "undefined"){
    Notify.init({ position: "top-right", defaultDuration: 4200 });
    Notify.mountBell("#notif-bell-slot");
  }

  $("#topbar-username").textContent = CURRENT_USER.name;
  $("#topbar-avatar").textContent = CURRENT_USER.initials;
  $("#topbar-role").textContent = role === "admin" ? "HR / Admin" : "Employee";
  document.body.classList.toggle("role-admin", role === "admin");

  $("#today-date").textContent = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

  let badgeReady = { flip(){}, destroy(){} };
  try {
    badgeReady = createBadge($("#dash-badge-canvas"));
  } catch (err) {
    console.warn("Badge visual unavailable:", err);
  }
  dashBadge = badgeReady;
  const punchBtn = $("#dash-punch-btn");
  if (punchBtn) punchBtn.addEventListener("click", handlePunch);

  $$(".nav-item[data-view]").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  $("#logout-btn").addEventListener("click", logout);
  $("#hamburger").addEventListener("click", () => $(".sidebar").classList.toggle("is-open"));

  renderQuickCards(role);
  renderActivity();
  if (role === "admin") renderAdminSummary();

  initProfile();
  initAttendance(role);
  initLeave(role);
  initPayroll(role);
  if (role === "admin") initEmployees();

  switchView("dashboard");
}

function switchView(view){
  currentView = view;
  $$(".nav-item[data-view]").forEach(b => b.classList.toggle("is-active", b.dataset.view === view));
  $(".sidebar").classList.remove("is-open");

  const titles = {
    dashboard: "Dashboard", profile: "Profile", attendance: "Attendance",
    leave: "Leave", payroll: "Payroll", employees: "Employees", approvals: "Approvals"
  };
  $("#view-title").textContent = titles[view] || view;

  $$(".view").forEach(sec => {
    if (sec.dataset.view === view){
      sec.classList.add("is-active");
      anime({ targets: sec, opacity: [0, 1], translateY: [10, 0], duration: 320, easing: "easeOutQuad" });
    } else {
      sec.classList.remove("is-active");
    }
  });
}

function logout(){
  // TODO(firebase): replace with signOut(auth)
  clearSession();
  window.location.href = "index.html";
}

/* ---------------------------------------------------------
   Punch in/out (dashboard)
   --------------------------------------------------------- */
function handlePunch(){
  dashBadge.flip();
  punched = !punched;
  $("#dash-punch-btn").textContent = punched ? "Punch out" : "Punch in";
  $("#stat-status").textContent = punched ? "In" : "Out";

  if (punched){
    notifyEvent("success", "Punched in", "Timer started for today.");
    prependActivity("Punched in");
  } else {
    hoursToday += 0.25 + Math.random() * 0.5;
    const counter = { v: parseFloat($("#stat-hours").textContent) };
    anime({
      targets: counter,
      v: hoursToday,
      duration: 700,
      easing: "easeOutQuad",
      round: 100,
      update: () => { $("#stat-hours").textContent = counter.v.toFixed(1); }
    });
    notifyEvent("info", "Punched out", `Logged ${hoursToday.toFixed(1)} hours for today.`);
    prependActivity("Punched out for the day");
  }
}

/* ---------------------------------------------------------
   Dashboard: quick cards + activity + admin summary
   --------------------------------------------------------- */
function renderQuickCards(role){
  const cards = [
    { view: "profile", title: "Profile", desc: "View & edit your details", icon: profileIcon() },
    { view: "attendance", title: "Attendance", desc: "Check today's record", icon: calendarIcon() },
    { view: "leave", title: "Leave requests", desc: "Apply or track status", icon: checkIcon() },
    { view: "payroll", title: "Payroll", desc: "View salary structure", icon: coinIcon() }
  ];
  const wrap = $("#quick-cards");
  wrap.innerHTML = "";
  cards.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "quick-card";
    btn.innerHTML = `${c.icon}<b>${c.title}</b><span>${c.desc}</span>`;
    btn.addEventListener("click", () => switchView(c.view));
    wrap.appendChild(btn);
  });
  anime({ targets: "#quick-cards .quick-card", opacity: [0, 1], translateY: [10, 0], delay: anime.stagger(60), duration: 380, easing: "easeOutQuad" });
}

function profileIcon(){ return `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c1.4-4 4-6 7.5-6s6.1 2 7.5 6"/></svg>`; }
function calendarIcon(){ return `<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 3v3M16 3v3"/></svg>`; }
function checkIcon(){ return `<svg viewBox="0 0 24 24"><path d="M4 12.5l4.5 4.5L20 6"/></svg>`; }
function coinIcon(){ return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M9 9.5h4.2a1.8 1.8 0 0 1 0 3.6H10a1.8 1.8 0 0 0 0 3.6H15"/></svg>`; }

function renderActivity(){
  const items = [
    { text: "You signed in", time: "just now" }
  ];
  const list = $("#activity-list");
  list.innerHTML = "";
  items.forEach(i => list.appendChild(activityRow(i.text, i.time)));
}
function activityRow(text, time){
  const li = document.createElement("li");
  li.innerHTML = `<span class="a-dot"></span><span>${text}</span><time>${time}</time>`;
  return li;
}
function prependActivity(text){
  const list = $("#activity-list");
  const li = activityRow(text, "just now");
  li.style.opacity = 0;
  list.prepend(li);
  anime({ targets: li, opacity: [0, 1], translateX: [-8, 0], duration: 320, easing: "easeOutQuad" });
}

function renderAdminSummary(){
  const pendingCount = leaves.filter(l => l.status === "pending").length;
  const presentCount = EMPLOYEES.filter(e => e.status === "present").length;
  $("#admin-summary").innerHTML = `
    <div class="panel"><span class="muted">Team size</span><span class="big">${EMPLOYEES.length}</span></div>
    <div class="panel"><span class="muted">Present today</span><span class="big">${presentCount}/${EMPLOYEES.length}</span></div>
    <div class="panel"><span class="muted">Pending approvals</span><span class="big">${pendingCount}</span></div>
  `;
}

/* ---------------------------------------------------------
   Profile
   --------------------------------------------------------- */
function initProfile(){
  $("#profile-name").textContent = CURRENT_USER.name;
  $("#profile-role-line").textContent = `${CURRENT_USER.title} · ${CURRENT_USER.empId}`;
  $("#profile-avatar").textContent = CURRENT_USER.initials;

  const fields = [
    ["Full name", CURRENT_USER.name],
    ["Employee ID", CURRENT_USER.empId],
    ["Department", CURRENT_USER.department],
    ["Reporting manager", CURRENT_USER.manager],
    ["Work email", CURRENT_USER.email],
    ["Phone", CURRENT_USER.phone || "Not added yet"],
    ["Address", CURRENT_USER.address || "Not added yet"],
    ["Joined on", CURRENT_USER.joined]
  ];
  const grid = $("#profile-view-grid");
  grid.innerHTML = fields.map(([label, val]) => `
    <div class="p-field"><b>${label}</b><span>${val}</span></div>
  `).join("");

  $("#edit-profile-btn").addEventListener("click", () => {
    grid.hidden = true;
    const editGrid = $("#profile-edit-grid");
    $("#edit-phone").value = CURRENT_USER.phone;
    $("#edit-address").value = CURRENT_USER.address;
    editGrid.hidden = false;
    editGrid.setAttribute("data-active", "");
    anime({ targets: editGrid, opacity: [0, 1], duration: 280, easing: "easeOutQuad" });
  });
  $("#cancel-edit-btn").addEventListener("click", () => {
    $("#profile-edit-grid").hidden = true;
    $("#profile-edit-grid").removeAttribute("data-active");
    grid.hidden = false;
  });
  $("#profile-edit-grid").addEventListener("submit", e => {
    e.preventDefault();
    // TODO(firebase): write these fields to the employee's Firestore doc
    CURRENT_USER.phone = $("#edit-phone").value;
    CURRENT_USER.address = $("#edit-address").value;
    initProfile();
    $("#profile-edit-grid").hidden = true;
    notifyEvent("success", "Profile updated", "Your contact details were saved.");
  });
}

/* ---------------------------------------------------------
   Attendance
   --------------------------------------------------------- */
function initAttendance(role){
  const monthLabel = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  $("#att-month-label").textContent = monthLabel;
  renderCalendar();

  $$("#att-view-toggle button").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("#att-view-toggle button").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      renderCalendar(btn.dataset.range);
    });
  });

  if (role === "admin"){
    const table = $("#admin-attendance-table");
    table.innerHTML = `
      <tr><th>Employee</th><th>ID</th><th>Department</th><th>Status</th></tr>
      ${EMPLOYEES.map(e => `
        <tr>
          <td>${e.name}</td><td>${e.empId}</td><td>${e.dept}</td>
          <td><span class="status-pill ${e.status}">${label(e.status)}</span></td>
        </tr>`).join("")}
    `;
  } else {
    $("#admin-attendance-panel").remove();
  }
}

function label(status){
  return { present: "Present", half: "Half-day", absent: "Absent", leave: "Leave", weekend: "Weekend" }[status] || status;
}

function seededStatus(day){
  const r = (day * 37) % 11;
  if (r === 0) return "absent";
  if (r === 1 || r === 2) return "half";
  if (r === 3) return "leave";
  return "present";
}

function renderCalendar(range = "month"){
  const grid = $("#cal-grid");
  grid.innerHTML = "";
  const dows = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  dows.forEach(d => {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = d;
    grid.appendChild(el);
  });

  const now = new Date();
  let daysToShow = [];

  if (range === "week"){
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    for (let i = 0; i < 7; i++){
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      daysToShow.push(d);
    }
    const startDow = daysToShow[0].getDay();
    for (let i = 0; i < startDow; i++) grid.appendChild(emptyCell());
  } else {
    const year = now.getFullYear(), month = now.getMonth();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < firstDay.getDay(); i++) grid.appendChild(emptyCell());
    for (let d = 1; d <= daysInMonth; d++) daysToShow.push(new Date(year, month, d));
  }

  daysToShow.forEach(d => {
    const cell = document.createElement("div");
    const isFuture = d > now;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const status = isWeekend ? "weekend" : (isFuture ? "" : seededStatus(d.getDate()));
    cell.className = "cal-cell" + (status ? ` ${status}` : "");
    cell.textContent = d.getDate();
    grid.appendChild(cell);
  });

  anime({ targets: "#cal-grid .cal-cell", opacity: [0, 1], scale: [0.8, 1], delay: anime.stagger(10), duration: 320, easing: "easeOutQuad" });
}
function emptyCell(){
  const el = document.createElement("div");
  el.className = "cal-cell empty";
  return el;
}

/* ---------------------------------------------------------
   Leave
   --------------------------------------------------------- */
function initLeave(role){
  renderEmployeeLeaves();
  if (role === "admin") renderAdminLeaves();

  $("#leave-form").addEventListener("submit", e => {
    e.preventDefault();
    const from = $("#leave-from").value, to = $("#leave-to").value;
    const leaveType = $("#leave-type").value;
    if (!from || !to){ toast("Pick a start and end date."); return; }
    leaves.unshift({
      id: leaveIdCounter++,
      who: CURRENT_USER.name,
      type: leaveType,
      from, to,
      remarks: $("#leave-remarks").value,
      status: "pending"
    });
    renderEmployeeLeaves();
    if (role === "admin") renderAdminLeaves();
    e.target.reset();
    notifyEvent("info", "Leave request submitted", `${leaveType} · awaiting approval.`);
  });
}

function fmtRange(from, to){
  const opts = { day: "numeric", month: "short" };
  const f = new Date(from).toLocaleDateString("en-IN", opts);
  const t = new Date(to).toLocaleDateString("en-IN", opts);
  return f === t ? f : `${f} – ${t}`;
}

function renderEmployeeLeaves(){
  const mine = leaves.filter(l => l.who === CURRENT_USER.name);
  const list = $("#leave-list-employee");
  list.innerHTML = "";
  if (!mine.length){
    list.innerHTML = `<li class="leave-card"><span class="muted">No leave requests yet.</span></li>`;
    return;
  }
  mine.forEach(l => {
    const li = document.createElement("li");
    li.className = "leave-card";
    li.innerHTML = `
      <div class="row1"><b>${l.type}</b><span class="status-pill ${l.status}">${cap(l.status)}</span></div>
      <span class="dates">${fmtRange(l.from, l.to)}</span>
      ${l.remarks ? `<span class="remarks">${l.remarks}</span>` : ""}
    `;
    list.appendChild(li);
  });
}

function renderAdminLeaves(){
  const list = $("#leave-list-admin");
  list.innerHTML = "";
  const pending = leaves.filter(l => l.status === "pending");
  if (!pending.length){
    list.innerHTML = `<li class="leave-card"><span class="muted">No pending requests. All caught up.</span></li>`;
    return;
  }
  pending.forEach(l => {
    const li = document.createElement("li");
    li.className = "leave-card";
    li.dataset.id = l.id;
    li.innerHTML = `
      <div class="row1"><span class="who">${l.who}</span><span class="status-pill pending">Pending</span></div>
      <b>${l.type}</b>
      <span class="dates">${fmtRange(l.from, l.to)}</span>
      ${l.remarks ? `<span class="remarks">${l.remarks}</span>` : ""}
      <div class="leave-actions">
        <button class="approve" data-act="approved">Approve</button>
        <button class="reject" data-act="rejected">Reject</button>
      </div>
    `;
    list.appendChild(li);
  });

  $$("#leave-list-admin .leave-actions button").forEach(btn => {
    btn.addEventListener("click", () => resolveLeave(btn));
  });
}

function resolveLeave(btn){
  const li = btn.closest("li");
  const id = parseInt(li.dataset.id, 10);
  const action = btn.dataset.act;
  anime({
    targets: li,
    opacity: 0,
    translateX: action === "approved" ? 30 : -30,
    duration: 260,
    easing: "easeInQuad",
    complete: () => {
      const rec = leaves.find(l => l.id === id);
      if (rec) rec.status = action;
      renderAdminLeaves();
      renderEmployeeLeaves();
      renderAdminSummary();
      notifyEvent(
        action === "approved" ? "success" : "danger",
        `Leave ${action}`,
        rec ? `${rec.who} · ${rec.type} · ${fmtRange(rec.from, rec.to)}` : `Request ${action}.`
      );
    }
  });
}

function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------------------------------------------------------
   Payroll
   --------------------------------------------------------- */
const ADMIN_NET = { "EMP-0011": 61200, "EMP-0027": 38500, "EMP-0033": 35200, "EMP-0019": 40100, "EMP-0058": 33900 };

function initPayroll(role){
  const net = PAYROLL_SELF.reduce((sum, r) => sum + r.amount, 0);
  const table = $("#payroll-table-employee");
  table.innerHTML = `
    <tr><th>Component</th><th style="text-align:right">Amount</th></tr>
    ${PAYROLL_SELF.map(r => `
      <tr>
        <td>${r.label}</td>
        <td style="text-align:right; ${r.deduction ? "color:#B23B36" : ""}">${r.deduction ? "−" : ""}${rupee(r.amount)}</td>
      </tr>`).join("")}
    <tr><td><b>Net pay</b></td><td style="text-align:right"><b>${rupee(net)}</b></td></tr>
  `;

  if (role === "admin"){
    renderAdminPayroll();
  } else {
    $("#admin-payroll-panel").remove();
  }
}

function renderAdminPayroll(){
  const table = $("#admin-payroll-table");
  table.innerHTML = `
    <tr><th>Employee</th><th>ID</th><th>Net pay</th><th></th></tr>
    ${EMPLOYEES.map(e => `
      <tr data-id="${e.empId}">
        <td>${e.name}</td><td>${e.empId}</td>
        <td><input class="editable-input" type="number" value="${ADMIN_NET[e.empId] ?? 30000}"></td>
        <td><button class="save-row-btn">Save</button></td>
      </tr>`).join("")}
  `;
  $$("#admin-payroll-table .save-row-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const row = btn.closest("tr");
      const id = row.dataset.id;
      const val = row.querySelector(".editable-input").value;
      // TODO(firebase): write payroll updates to Firestore
      ADMIN_NET[id] = Number(val);
      anime({ targets: row, backgroundColor: ["#DCF1EC", "transparent"], duration: 900, easing: "easeOutQuad" });
      notifyEvent("success", "Salary updated", `New net pay saved for ${id}.`);
    });
  });
}

/* ---------------------------------------------------------
   Employees (admin)
   --------------------------------------------------------- */
function initEmployees(){
  const table = $("#employees-table");
  table.innerHTML = `
    <tr><th>Employee</th><th>ID</th><th>Department</th><th>Today</th></tr>
    ${EMPLOYEES.map(e => `
      <tr>
        <td>${e.name}</td><td>${e.empId}</td><td>${e.dept}</td>
        <td><span class="status-pill ${e.status}">${label(e.status)}</span></td>
      </tr>`).join("")}
  `;
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */
initApp(session.role);
