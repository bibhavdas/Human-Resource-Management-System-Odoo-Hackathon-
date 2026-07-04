import { doc, setDoc, collection, onSnapshot, addDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";

/* ============================================================
   Alignt HRMS — dashboard logic
   ============================================================ */

const session = getSession();
if (!session){
  window.location.href = "index.html";
  throw new Error("No session — redirecting to sign in.");
}

const CURRENT_USER = {
  name: session.name && session.name !== "Employee" ? session.name : deriveNameFromEmail(session.email),
  empId: session.empId && session.empId !== "AU-00000" ? session.empId : "AU-Pending",
  role: session.role || "employee",
  title: session.role === "admin" ? "HR Administrator" : "Employee",
  email: session.email,
  phone: "",
  address: "",
  department: "—",
  manager: "—",
  joined: "—",
  createdAt: session.createdAt || Date.now(),
  status: "absent",
  initials: initialsOf(session.name && session.name !== "Employee" ? session.name : deriveNameFromEmail(session.email)),
  avatarData: null,
  coverData: null
};

/* ---------------------------------------------------------
   Local Reactive Store
   --------------------------------------------------------- */
let EMPLOYEES = [];
let PAYROLL_SELF = [];
let leaves = [];
const ADMIN_NET = {};

let punched = false;
let isFirstLoad = true;
let isFirstLeaveLoad = true;

const notiSound = new Audio("noti.mp3");

/* ---------------------------------------------------------
   Small helpers
   --------------------------------------------------------- */
const rupee = n => "₹" + Math.abs(n).toLocaleString("en-IN");

function notifyEvent(type, title, message){
  notiSound.play().catch(e => console.warn("Audio play prevented (User must interact with page first)", e));
  
  if (typeof Notify !== "undefined"){
    Notify.notify({ type, title, message });
  } else {
    toast(message);
  }
}

function getAvatarColor(name) {
  const colors = ['#1F6F5C', '#3FA796', '#F2A93B', '#D9534F', '#6C7FD8', '#8A5B10'];
  let hash = 0;
  for (let i = 0; i < (name || "A").length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function timeAgo(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

// Universal Image Compressor
const compressImage = (file, maxDim = 256) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
        const img = new Image();
        img.src = event.target.result;
        img.onload = () => {
            const canvas = document.createElement("canvas");
            let { width, height } = img;
            
            if (width > height) {
                if (width > maxDim) { height *= maxDim / width; width = maxDim; }
            } else {
                if (height > maxDim) { width *= maxDim / height; height = maxDim; }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL("image/jpeg", 0.7)); 
        };
        img.onerror = reject;
    };
    reader.onerror = reject;
});

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
    btn.addEventListener("click", () => {
        if (btn.dataset.view === "profile") {
            renderProfileView(CURRENT_USER);
        }
        switchView(btn.dataset.view);
    });
  });
  
  $("#logout-btn").addEventListener("click", logout);
  $("#hamburger").addEventListener("click", () => $(".sidebar").classList.toggle("is-open"));

  setupRealtimeListeners(role);
  renderQuickCards(role);
  initProfileEdit(); 
  initLeave(); 

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

  if (view === "approvals" && CURRENT_USER.role === "admin") renderAdminLeaves();
  if (view === "leave") renderEmployeeLeaves();
  if (view === "employees" && CURRENT_USER.role === "admin") initEmployees();
  if (view === "attendance") initAttendance(CURRENT_USER.role);
  if (view === "payroll") initPayroll(CURRENT_USER.role);
  if (view === "dashboard" && CURRENT_USER.role === "admin") renderAdminSummary();
}

function logout(){
  clearSession();
  window.location.href = "index.html";
}

/* ---------------------------------------------------------
   Real-Time Data Handlers (Firestore)
   --------------------------------------------------------- */
function setupRealtimeListeners(role) {
  // 1. Employee Profiles & Ghost Account Cleaner
  onSnapshot(collection(db, "users"), (snapshot) => {
      let docsData = snapshot.docs.map(docSnap => ({ id: docSnap.id, email: docSnap.id, ...docSnap.data() }));
      
      docsData.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

      EMPLOYEES = docsData.map((data, index) => {
          const correctEmpId = "AU-" + String(index + 1).padStart(5, '0');
          let needsPatch = false;
          const patch = {};

          // DESTROY AU-00000 and generic "Employee" names!
          if (data.empId !== correctEmpId || data.empId === "AU-00000") {
              patch.empId = correctEmpId;
              needsPatch = true;
          }
          if (!data.name || data.name === "Employee") {
              patch.name = deriveNameFromEmail(data.email);
              needsPatch = true;
          }
          if (!data.joined) {
              patch.joined = new Date(data.createdAt || Date.now()).toLocaleDateString("en-IN", { day: 'numeric', month: 'short', year: 'numeric' });
              needsPatch = true;
          }
          if (!data.createdAt) {
              patch.createdAt = Date.now();
              needsPatch = true;
          }
          if (!data.role) {
              patch.role = "employee";
              needsPatch = true;
          }
          
          if (needsPatch) {
              updateDoc(doc(db, "users", data.id), patch).catch(e => console.warn(e));
              Object.assign(data, patch); 
          }

          if (data.id === CURRENT_USER.email) {
              const prevStatus = CURRENT_USER.status;
              
              CURRENT_USER.name = data.name;
              CURRENT_USER.phone = data.phone || "";
              CURRENT_USER.address = data.address || "";
              CURRENT_USER.joined = data.joined;
              CURRENT_USER.createdAt = data.createdAt;
              CURRENT_USER.department = data.department || "—";
              CURRENT_USER.avatarData = data.avatarData || null;
              CURRENT_USER.coverData = data.coverData || null;
              CURRENT_USER.empId = data.empId;
              CURRENT_USER.status = data.status || "absent";
              CURRENT_USER.role = data.role; 

              $("#topbar-username").textContent = CURRENT_USER.name;
              updateTopbarAvatar(); 

              punched = (CURRENT_USER.status === "present");
              const punchBtn = $("#dash-punch-btn");
              if (punchBtn) {
                  punchBtn.textContent = punched ? "Punch out" : "Punch in";
                  $("#stat-status").textContent = punched ? "In" : "Out";
              }
              
              if (isFirstLoad) {
                  if (punched && dashBadge && typeof dashBadge.flip === 'function') dashBadge.flip(); 
                  isFirstLoad = false;
              }

              if ($("#profile-edit-grid") && $("#profile-edit-grid").hidden && $("#profile-name-main").textContent === CURRENT_USER.name) {
                  renderProfileView(CURRENT_USER);
              }

              if (prevStatus !== CURRENT_USER.status && currentView === "attendance") renderCalendar();
          }
          return { ...data, status: data.status || "absent" };
      });

      EMPLOYEES.sort((a,b) => (a.name || "").localeCompare(b.name || ""));

      if (role === "admin") {
          if (currentView === "dashboard") renderAdminSummary();
          if (currentView === "employees") initEmployees();
          if (currentView === "attendance") initAttendance(role);
      }
  });

  // 2. Global Leave System with SMART Notifications
  onSnapshot(collection(db, "leaves"), (snapshot) => {
      
      snapshot.docChanges().forEach(change => {
          if (!isFirstLeaveLoad) {
              const data = change.doc.data();
              
              if (role === "admin" && change.type === "added" && data.status === "pending") {
                  notifyEvent("info", "New Leave Request", `${data.who} applied for ${data.type}`);
              }
              
              if (role !== "admin" && change.type === "modified" && data.email === CURRENT_USER.email) {
                  if (data.status === "approved") notifyEvent("success", "Leave Approved", `Your ${data.type} request was approved!`);
                  if (data.status === "rejected") notifyEvent("danger", "Leave Rejected", `Your ${data.type} request was denied.`);
              }
          }
      });
      isFirstLeaveLoad = false;

      leaves = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
          .sort((a, b) => b.createdAt - a.createdAt);

      if (currentView === "leave") renderEmployeeLeaves();
      if (role === "admin") {
          if (currentView === "approvals" || currentView === "leave") renderAdminLeaves();
          if (currentView === "dashboard") renderAdminSummary();
      }
  });

  // 3. Centralized Payroll System 
  onSnapshot(collection(db, "payroll"), (snapshot) => {
      snapshot.docs.forEach(docSnap => {
          const data = docSnap.data();
          ADMIN_NET[docSnap.id] = data.netPay;
          
          if (docSnap.id === CURRENT_USER.email) {
              PAYROLL_SELF = data.components || [
                  { label: "Basic Pay", amount: data.netPay || 0, deduction: false }
              ];
          }
      });
      
      if (currentView === "payroll") {
          if (role === "admin" && !document.activeElement.closest("#admin-payroll-table")) renderAdminPayroll();
          if (!document.activeElement.closest("#admin-payroll-table")) initPayroll(role);
      }
  });

  // 4. Live Activity Logs
  onSnapshot(collection(db, "activity_logs"), (snapshot) => {
      const allLogs = snapshot.docs.map(docSnap => docSnap.data()).sort((a, b) => b.ts - a.ts);
      const visibleLogs = role === "admin" ? allLogs : allLogs.filter(l => l.email === CURRENT_USER.email);
      renderActivity(visibleLogs, role);
  });
}

/* ---------------------------------------------------------
   Activity Feed Actions
   --------------------------------------------------------- */
async function logActivity(action) {
    try {
        await addDoc(collection(db, "activity_logs"), {
            action,
            name: CURRENT_USER.name,
            email: CURRENT_USER.email,
            ts: Date.now()
        });
    } catch(err) {
        console.error("Activity log error:", err);
    }
}

function renderActivity(logs, role) {
  const list = $("#activity-list");
  list.innerHTML = "";
  if (!logs || logs.length === 0) {
    list.innerHTML = `<li><span class="muted">No recent activity.</span></li>`;
    return;
  }
  
  logs.slice(0, 10).forEach(log => {
    const text = role === "admin" ? `<b>${log.name}</b> ${log.action.toLowerCase()}` : log.action;
    const li = document.createElement("li");
    li.innerHTML = `<span class="a-dot"></span><span style="flex:1">${text}</span><time>${timeAgo(log.ts)}</time>`;
    list.appendChild(li);
  });
}

/* ---------------------------------------------------------
   Punch in/out (dashboard)
   --------------------------------------------------------- */
async function handlePunch(){
  const newStatus = punched ? "absent" : "present";
  
  try {
      await setDoc(doc(db, "users", CURRENT_USER.email), { status: newStatus }, { merge: true });
      await logActivity(newStatus === "present" ? "Punched in" : "Punched out for the day");
      
      dashBadge.flip();

      if (newStatus === "present"){
        notifyEvent("success", "Punched in", "Timer started for today.");
      } else {
        notifyEvent("info", "Punched out", `Logged out for today.`);
      }
  } catch (err) {
      console.error("Failed to sync attendance status", err);
  }
}

/* ---------------------------------------------------------
   Dashboard: quick cards + admin summary
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

function renderAdminSummary(){
  const pendingCount = leaves.filter(l => l.status === "pending").length;
  
  const employeeList = EMPLOYEES.filter(e => e.role !== "admin");
  const presentCount = employeeList.filter(e => e.status === "present").length;
  
  $("#admin-summary").innerHTML = `
    <div class="panel"><span class="muted">Team size (Employees)</span><span class="big">${employeeList.length}</span></div>
    <div class="panel"><span class="muted">Online / Present</span><span class="big">${presentCount}/${employeeList.length}</span></div>
    <div class="panel"><span class="muted">Pending approvals</span><span class="big">${pendingCount}</span></div>
  `;
}

/* ---------------------------------------------------------
   Profile & Strict Avatar/Cover Constraints
   --------------------------------------------------------- */
function updateTopbarAvatar() {
    const topbarAvatar = $("#topbar-avatar");
    if (!topbarAvatar) return;

    topbarAvatar.style.overflow = 'hidden'; 

    if (CURRENT_USER.avatarData) {
        topbarAvatar.innerHTML = `<img src="${CURRENT_USER.avatarData}" style="width:34px; height:34px; max-width:34px; max-height:34px; min-width:34px; min-height:34px; object-fit:cover; display:block; border-radius:50%; margin:0; padding:0;">`;
        topbarAvatar.style.backgroundColor = 'transparent';
    } else {
        topbarAvatar.innerHTML = "";
        topbarAvatar.textContent = initialsOf(CURRENT_USER.name);
        topbarAvatar.style.backgroundColor = getAvatarColor(CURRENT_USER.name);
    }
}

function renderProfileView(userObj) {
  const isSelf = userObj.email === CURRENT_USER.email;

  $("#profile-name-main").textContent = userObj.name;
  const displayTitle = userObj.title || (userObj.role === 'admin' ? 'HR Administrator' : 'Employee');
  $("#profile-role-line").textContent = `${displayTitle} · ${userObj.department || '—'}`;
  $("#profile-location-text").textContent = userObj.address || "Not added yet";

  const giantAvatar = $("#profile-avatar");
  if (giantAvatar) {
      giantAvatar.style.overflow = "hidden";
      if (userObj.avatarData) {
          giantAvatar.innerHTML = `<img src="${userObj.avatarData}" style="width:112px; height:112px; max-width:112px; max-height:112px; min-width:112px; min-height:112px; object-fit:cover; display:block; border-radius:50%; border:none; margin:0; padding:0;">`;
          giantAvatar.style.backgroundColor = 'transparent';
          giantAvatar.style.border = 'none';
      } else {
          giantAvatar.innerHTML = "";
          giantAvatar.textContent = initialsOf(userObj.name);
          giantAvatar.style.backgroundColor = getAvatarColor(userObj.name);
          giantAvatar.style.border = "4px solid var(--card)";
      }
      
      const wrapper = $(".profile-avatar-wrapper");
      if (wrapper && userObj.avatarData) {
          wrapper.style.padding = "0";
          wrapper.style.background = "transparent";
      } else if (wrapper) {
          wrapper.style.padding = "4px";
          wrapper.style.background = "var(--card)";
      }
  }

  const coverEl = $(".profile-cover");
  if (coverEl) {
      if (userObj.coverData) {
          coverEl.style.background = `url(${userObj.coverData}) center/cover`;
      } else {
          coverEl.style.background = `linear-gradient(120deg, var(--brand-dark), var(--brand))`;
      }
  }

  const fields = [
    ["Full name", userObj.name],
    ["Employee ID", userObj.empId],
    ["Work email", userObj.email],
    ["Phone", userObj.phone || "Not added yet"],
    ["Address", userObj.address || "Not added yet"],
    ["Joined on", userObj.joined || "—"]
  ];
  const grid = $("#profile-view-grid");
  grid.innerHTML = fields.map(([label, val]) => `
    <div class="p-field"><b>${label}</b><span>${val}</span></div>
  `).join("");

  const editBtn = $("#edit-profile-btn");
  if (editBtn) {
      editBtn.style.display = isSelf ? "block" : "none";
  }
}

function initProfileEdit(){
  const editBtn = $("#edit-profile-btn");
  const cancelBtn = $("#cancel-edit-btn");
  const form = $("#profile-edit-grid");
  const grid = $("#profile-view-grid");

  if (!form || form.dataset.bound) return;

  editBtn.addEventListener("click", () => {
    grid.hidden = true;
    $("#edit-name").value = CURRENT_USER.name;
    $("#edit-phone").value = CURRENT_USER.phone;
    $("#edit-address").value = CURRENT_USER.address;
    $("#edit-avatar-file").value = ""; 
    
    const coverInput = $("#edit-cover-file");
    if (coverInput) coverInput.value = ""; 
    
    form.hidden = false;
    form.setAttribute("data-active", "");
    anime({ targets: form, opacity: [0, 1], duration: 280, easing: "easeOutQuad" });
  });
  
  cancelBtn.addEventListener("click", () => {
    form.hidden = true;
    form.removeAttribute("data-active");
    grid.hidden = false;
  });
  
  form.addEventListener("submit", async e => {
    e.preventDefault();
    
    const newName = $("#edit-name").value;
    const newPhone = $("#edit-phone").value;
    const newAddress = $("#edit-address").value;
    const fileInput = $("#edit-avatar-file");
    const coverInput = $("#edit-cover-file");
    
    const saveBtn = e.target.querySelector('button[type="submit"]');
    const userDocRef = doc(db, "users", CURRENT_USER.email);

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
      let updatedData = {
        name: newName,
        phone: newPhone,
        address: newAddress
      };

      if (fileInput.files && fileInput.files.length > 0) {
          updatedData.avatarData = await compressImage(fileInput.files[0], 256);
      }
      if (coverInput && coverInput.files && coverInput.files.length > 0) {
          updatedData.coverData = await compressImage(coverInput.files[0], 1024);
      }

      await setDoc(userDocRef, updatedData, { merge: true });

      const session = getSession();
      session.name = newName;
      setSession(session);
      
      form.hidden = true;
      form.removeAttribute("data-active");
      grid.hidden = false;

      notifyEvent("success", "Profile updated", "Your profile changes were permanently saved.");
    } catch (error) {
      console.error("Firebase update failed: ", error);
      notifyEvent("danger", "Update failed", "Could not save your details. Ensure image isn't too large.");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save changes";
    }
  });

  form.dataset.bound = "true";
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
    const employeeList = EMPLOYEES.filter(e => e.role !== "admin");
    
    table.innerHTML = `
      <tr><th>Employee</th><th>ID</th><th>Department</th><th>Status</th></tr>
      ${employeeList.length === 0 ? `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted)">No employee data available.</td></tr>` : 
      employeeList.map(e => `
        <tr>
          <td>${e.name}</td><td>${e.empId}</td><td>${e.department || '—'}</td>
          <td><span class="status-pill ${e.status}">${label(e.status)}</span></td>
        </tr>`).join("")}
    `;
  } else {
    $("#admin-attendance-panel")?.remove();
  }
}

function label(status){
  return { present: "Present", half: "Half-day", absent: "Absent", leave: "Leave", weekend: "Weekend" }[status] || status;
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
    const cellTime = d.getTime();
    
    const joinDate = new Date(CURRENT_USER.createdAt);
    const joinStart = new Date(joinDate.getFullYear(), joinDate.getMonth(), joinDate.getDate()).getTime();
    
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const isFuture = cellTime > todayStart;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    
    let status = "";
    
    if (cellTime < joinStart) {
        status = ""; 
    } else if (isFuture) {
        status = ""; 
    } else if (isWeekend) {
        status = "weekend"; 
    } else if (cellTime === todayStart) {
        status = CURRENT_USER.status === "present" ? "present" : "absent";
    } else {
        status = "present"; 
    }

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
   Leave Submissions
   --------------------------------------------------------- */
function initLeave(){
  const leaveForm = $("#leave-form");
  if (!leaveForm || leaveForm.dataset.bound) return;
  
  leaveForm.addEventListener("submit", async e => {
    e.preventDefault(); 
    
    const from = $("#leave-from").value;
    const to = $("#leave-to").value;
    const leaveType = $("#leave-type").value;
    
    if (!from || !to){ toast("Pick a start and end date."); return; }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    try {
        await addDoc(collection(db, "leaves"), {
          who: CURRENT_USER.name,
          email: CURRENT_USER.email,
          type: leaveType,
          from, to,
          remarks: $("#leave-remarks").value,
          status: "pending",
          createdAt: Date.now()
        });
        
        await logActivity(`Applied for ${leaveType.toLowerCase()}`);
        
        e.target.reset();
        notifyEvent("info", "Leave request submitted", `${leaveType} · awaiting approval.`);
    } catch (err) {
        console.error("Leave Submission Error:", err);
        notifyEvent("danger", "Submission failed", "Unable to log the request at this time.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit request";
    }
  });
  
  leaveForm.dataset.bound = "true";
}

function fmtRange(from, to){
  const opts = { day: "numeric", month: "short" };
  const f = new Date(from).toLocaleDateString("en-IN", opts);
  const t = new Date(to).toLocaleDateString("en-IN", opts);
  return f === t ? f : `${f} – ${t}`;
}

function renderEmployeeLeaves(){
  const mine = leaves.filter(l => l.email === CURRENT_USER.email);
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
  if (!list) return;
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
  const id = li.dataset.id;
  const action = btn.dataset.act;

  anime({
    targets: li,
    opacity: 0,
    translateX: action === "approved" ? 30 : -30,
    duration: 260,
    easing: "easeInQuad",
    complete: async () => {
      try {
          const rec = leaves.find(l => l.id === id);
          await updateDoc(doc(db, "leaves", id), { status: action });
          await logActivity(`${action === "approved" ? "Approved" : "Rejected"} leave for ${rec ? rec.who : 'employee'}`);
          notifyEvent(
             action === "approved" ? "success" : "danger",
             `Leave ${action}`,
             rec ? `${rec.who} · ${rec.type} · ${fmtRange(rec.from, rec.to)}` : `Request ${action}.`
          );
      } catch (err) {
          console.error("Resolve error:", err);
          notifyEvent("danger", "Failed to resolve", "Could not complete the leave action.");
          anime({ targets: li, opacity: 1, translateX: 0, duration: 200 });
      }
    }
  });
}

function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------------------------------------------------------
   Payroll
   --------------------------------------------------------- */
function initPayroll(role){
  const net = PAYROLL_SELF.reduce((sum, r) => sum + (r.deduction ? -r.amount : r.amount), 0);
  const table = $("#payroll-table-employee");
  
  table.innerHTML = `
    <tr><th>Component</th><th style="text-align:right">Amount</th></tr>
    ${PAYROLL_SELF.length === 0 ? `<tr><td colspan="2" style="text-align:center; padding:20px; color:var(--muted)">No payroll data available.</td></tr>` :
    PAYROLL_SELF.map(r => `
      <tr>
        <td>${r.label}</td>
        <td style="text-align:right; ${r.deduction ? "color:#B23B36" : ""}">${r.deduction ? "−" : ""}${rupee(r.amount)}</td>
      </tr>`).join("")}
    <tr><td><b>Net pay</b></td><td style="text-align:right"><b>${rupee(net)}</b></td></tr>
  `;

  if (role === "admin"){
    renderAdminPayroll();
  } else {
    $("#admin-payroll-panel")?.remove();
  }
}

function renderAdminPayroll(){
  const table = $("#admin-payroll-table");
  
  const empList = EMPLOYEES.filter(e => e.role !== "admin");
  
  table.innerHTML = `
    <tr><th>Employee</th><th>ID</th><th>Net pay</th><th></th></tr>
    ${empList.length === 0 ? `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted)">No employee data available.</td></tr>` : 
    empList.map(e => `
      <tr data-id="${e.email}">
        <td>${e.name}</td><td>${e.empId}</td>
        <td><input class="editable-input" type="number" value="${ADMIN_NET[e.email] ?? 0}"></td>
        <td><button class="save-row-btn">Save</button></td>
      </tr>`).join("")}
  `;
  
  $$("#admin-payroll-table .save-row-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr");
      const email = row.dataset.id;
      const val = row.querySelector(".editable-input").value;
      
      btn.disabled = true;
      btn.textContent = "Saving...";

      try {
          await setDoc(doc(db, "payroll", email), {
              netPay: Number(val),
              updatedAt: Date.now()
          }, { merge: true });
          
          anime({ targets: row, backgroundColor: ["#DCF1EC", "transparent"], duration: 900, easing: "easeOutQuad" });
          notifyEvent("success", "Salary updated", `New net pay saved for ${email}.`);
      } catch (err) {
          console.error("Payroll save error:", err);
          notifyEvent("danger", "Update failed", "Could not save the new net pay amount.");
      } finally {
          btn.disabled = false;
          btn.textContent = "Save";
      }
    });
  });
}

/* ---------------------------------------------------------
   Employees (admin) - HR Directory w/ Profiles
   --------------------------------------------------------- */
function initEmployees(){
  const table = $("#employees-table");
  if (!table) return;
  
  const empList = EMPLOYEES.filter(e => e.role !== "admin");
  
  table.innerHTML = `
    <tr><th>Employee</th><th>ID</th><th>Department</th><th>Today</th></tr>
    ${empList.length === 0 ? `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted)">No employee data available.</td></tr>` : 
    empList.map(e => {
      
      const avatarHTML = e.avatarData 
        ? `<img src="${e.avatarData}" style="width:28px;height:28px;max-width:28px;max-height:28px;min-width:28px;min-height:28px;border-radius:50%;object-fit:cover;display:block;">`
        : `<div style="width:28px;height:28px;border-radius:50%;background:${getAvatarColor(e.name)};color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;">${initialsOf(e.name)}</div>`;

      return `
      <tr class="emp-row" data-email="${e.email}" style="cursor:pointer; transition: background 0.15s;">
        <td style="display:flex;align-items:center;gap:10px;">
           ${avatarHTML}
           <span style="font-weight: 500;">${e.name}</span>
        </td>
        <td>${e.empId}</td>
        <td>${e.department || '—'}</td>
        <td><span class="status-pill ${e.status}">${label(e.status)}</span></td>
      </tr>`;
    }).join("")}
  `;

  $$(".emp-row").forEach(row => {
      row.addEventListener("mouseover", () => row.style.backgroundColor = "var(--paper-2)");
      row.addEventListener("mouseout", () => row.style.backgroundColor = "transparent");
      
      row.addEventListener("click", () => {
          const email = row.dataset.email;
          const targetEmployee = EMPLOYEES.find(e => e.email === email);
          if (targetEmployee) {
              renderProfileView(targetEmployee);
              switchView("profile");
          }
      });
  });
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */
initApp(session.role);
