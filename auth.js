/* ============================================================
   Alignt HRMS — sign-in / sign-up page logic
   Static prototype: no backend call is made. Submitting
   Sign in just builds a session object and hands off to the
   dashboard. This is the seam where Firebase Authentication
   will plug in later (onAuthStateChanged / signInWithEmail...).
   ============================================================ */

let authRole = "employee";
let signupRole = "employee";

function initAuth(){
  let badge = { flip(){}, destroy(){} };
  try {
    badge = createBadge($("#badge-canvas"));
  } catch (err) {
    console.warn("Badge visual unavailable:", err);
  }

  const punchBtn = $("#punch-btn");
  if (punchBtn) punchBtn.addEventListener("click", () => badge.flip());

  $$(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$(".auth-tab").forEach(t => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      const target = tab.dataset.tab;
      const showEl = target === "signin" ? $("#signin-form") : $("#signup-form");
      const hideEl = target === "signin" ? $("#signup-form") : $("#signin-form");
      hideEl.classList.remove("is-active");
      showEl.classList.add("is-active");
      anime({ targets: showEl, opacity: [0, 1], translateY: [8, 0], duration: 320, easing: "easeOutQuad" });
    });
  });

  $$("[data-role-toggle] .role-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("[data-role-toggle] .role-opt").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      authRole = btn.dataset.role;
    });
  });
  $$("[data-role-toggle-signup] .role-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("[data-role-toggle-signup] .role-opt").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      signupRole = btn.dataset.role;
    });
  });

  $("#signin-form").addEventListener("submit", e => {
    e.preventDefault();
    const email = $("#signin-email").value.trim();
    const password = $("#signin-password").value;
    if (!email || !password){
      $("#signin-error").hidden = false;
      return;
    }
    $("#signin-error").hidden = true;

    // TODO(firebase): replace with signInWithEmailAndPassword(auth, email, password)
    const session = {
      name: deriveNameFromEmail(email),
      empId: randomEmpId(),
      email,
      role: authRole
    };
    setSession(session);
    window.location.href = "dashboard.html";
  });

  $("#signup-form").addEventListener("submit", e => {
    e.preventDefault();
    const name = $("#signup-name").value.trim();
    const empId = $("#signup-empid").value.trim();
    const email = $("#signup-email").value.trim();

    // TODO(firebase): replace with createUserWithEmailAndPassword(auth, email, password)
    // + sendEmailVerification(), then write { name, empId, role } to Firestore.
    toast(`Account created for ${name || "you"}. Check your email to verify before signing in.`);
    e.target.reset();
    $$(".auth-tab")[0].click();
    $("#signin-email").value = email;
  });
}

// If a session already exists (e.g. someone came back to this page
// mid-session) we still show sign-in rather than auto-entering —
// there is no "already logged in" state in this prototype.
clearSession();
initAuth();
