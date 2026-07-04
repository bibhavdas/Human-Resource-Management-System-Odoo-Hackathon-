import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase.js";

/* ============================================================
   Alignt HRMS — sign-in / sign-up page logic
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

  // --- REAL FIREBASE SIGN IN ---
  $("#signin-form").addEventListener("submit", e => {
    e.preventDefault();
    const email = $("#signin-email").value.trim();
    const password = $("#signin-password").value;
    const errorEl = $("#signin-error");

    if (!email || !password){
      errorEl.textContent = "Enter a valid email and password to continue.";
      errorEl.hidden = false;
      return;
    }
    
    errorEl.hidden = true;
    const submitBtn = $("#signin-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    signInWithEmailAndPassword(auth, email, password)
      .then(async (userCredential) => {
          const user = userCredential.user;
          
          try {
              // Fetch proper role and info from Firestore
              const userDoc = await getDoc(doc(db, "users", email));
              let userData = userDoc.exists() ? userDoc.data() : { name: user.displayName || "Employee", empId: "EMP-0000", role: authRole };
              
              const session = {
                  name: userData.name, 
                  empId: userData.empId, 
                  email: user.email,
                  role: userData.role 
              };
              
              setSession(session);
              window.location.href = "dashboard.html";
          } catch(err) {
              console.error("Firestore retrieval error:", err);
              errorEl.textContent = "Error securely fetching your profile data.";
              errorEl.hidden = false;
              submitBtn.disabled = false;
              submitBtn.textContent = "Sign in";
          }
      })
      .catch((error) => {
          console.error("Firebase Auth Error:", error.code);
          submitBtn.disabled = false;
          submitBtn.textContent = "Sign in";
          
          if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
              errorEl.textContent = "This email is not registered or credentials invalid.";
              errorEl.hidden = false;
          } else {
              errorEl.textContent = "Sign-in failed. Please check your credentials.";
              errorEl.hidden = false;
          }
      });
  });

  // --- REAL FIREBASE SIGN UP ---
  $("#signup-form").addEventListener("submit", e => {
    e.preventDefault();
    const name = $("#signup-name").value.trim();
    const empId = $("#signup-empid").value.trim();
    const email = $("#signup-email").value.trim();
    const password = $("#signup-password").value;
    
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating account...";

    createUserWithEmailAndPassword(auth, email, password)
      .then(async (userCredential) => {
          // Initialize user's document in Firestore 
          await setDoc(doc(db, "users", email), {
              name: name,
              empId: empId,
              email: email,
              role: signupRole,
              department: "—",
              status: "absent",
              joined: new Date().toLocaleDateString("en-IN", { month: 'short', year: 'numeric' }),
              createdAt: Date.now()
          });

          toast(`Account created! You can now sign in.`);
          e.target.reset();
          $$(".auth-tab")[0].click();
          $("#signin-email").value = email;
      })
      .catch((error) => {
          console.error("Firebase Auth Error:", error.code);
          if (error.code === 'auth/email-already-in-use') {
              toast(`This email is already registered.`, 'warning');
          } else if (error.code === 'auth/weak-password') {
              toast(`Password should be at least 6 characters.`, 'danger');
          } else {
              toast(`Sign-up failed: ${error.message}`, 'danger');
          }
      })
      .finally(() => {
          submitBtn.disabled = false;
          submitBtn.textContent = "Create account";
      });
  });
}

clearSession();
initAuth();