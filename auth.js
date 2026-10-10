// Accounts: email + password, then a code emailed to you.
// The database (supabase/schema.sql) refuses data access until both steps pass.

(function () {
  const arrivedFrom = (location.hash.match(/[#&]type=(\w+)/) || [])[1] || "";  // signup, magiclink, recovery
  const cfg = window.APP_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase);
  const client = enabled ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;
  const $ = id => document.getElementById(id);
  const RESEND_SECONDS = 60;

  let pendingEmail = "";
  let onVerified = null;
  let resendTimer = null;

  function show(view) {
    $("auth").hidden = false;
    $("app").hidden = true;
    for (const v of ["vSignIn", "vSignUp", "vCode", "vForgot", "vNewPw"]) $(v).hidden = v !== view;
    setMsg("");
    const focus = $(view).querySelector("input");
    if (focus) setTimeout(() => focus.focus(), 0);
  }
  function setMsg(text, isErr) {
    const m = $("authMsg");
    m.textContent = text || "";
    m.className = "msg" + (isErr ? " err" : "");
  }
  function busy(form, on) { form.querySelectorAll("button, input").forEach(el => { el.disabled = on; }); }
  function friendly(err) {
    const t = (err && (err.message || err.error_description)) || String(err);
    if (/Invalid login credentials/i.test(t)) return "That email and password don't match. Try again or reset your password.";
    if (/Email not confirmed/i.test(t)) return "Confirm your email first: open the link we sent when you created the account.";
    if (/rate limit|too many/i.test(t)) return "Too many emails were sent in a short time. Wait a few minutes, then try again.";
    if (/Token has expired|invalid/i.test(t) && /token|otp/i.test(t)) return "That code is wrong or expired. Check the latest email, or send a new code.";
    if (/User already registered/i.test(t)) return "There's already an account for that email. Sign in instead.";
    if (/Password should be/i.test(t)) return "Use a password with at least 8 characters.";
    return t;
  }

  function amrOf(session) {
    try {
      const claims = JSON.parse(atob(session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return (claims.amr || []).map(a => a.method);
    } catch { return []; }
  }

  async function sendCode() {
    const { error } = await client.auth.signInWithOtp({ email: pendingEmail, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    startResendCountdown();
  }
  function startResendCountdown() {
    let left = RESEND_SECONDS;
    const btn = $("resendCode");
    btn.disabled = true;
    clearInterval(resendTimer);
    const tick = () => {
      btn.textContent = left > 0 ? `Send a new code in ${left}s` : "Send a new code";
      btn.disabled = left > 0;
      left -= 1;
      if (left < -1) clearInterval(resendTimer);
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  async function finish() {
    const { data: { user } } = await client.auth.getUser();
    $("accountEmail").textContent = user?.email || "";
    $("auth").hidden = true;
    $("app").hidden = false;
    if (onVerified) await onVerified(user);
  }

  // Step 1: password. Step 2: emailed code.
  async function onSignIn(e) {
    e.preventDefault();
    const form = e.target;
    const email = $("siEmail").value.trim().toLowerCase();
    const password = $("siPassword").value;
    busy(form, true);
    setMsg("Checking your password…");
    try {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const { error: rpcErr } = await client.rpc("password_checked");
      if (rpcErr) throw rpcErr;
      await client.auth.signOut({ scope: "local" });
      pendingEmail = email;
      await sendCode();
      $("codeEmail").textContent = email;
      form.reset();
      show("vCode");
      setMsg("");
    } catch (err) {
      setMsg(friendly(err), true);
    }
    busy(form, false);
  }

  async function onCode(e) {
    e.preventDefault();
    const form = e.target;
    const token = $("codeInput").value.replace(/\D/g, "");
    if (token.length < 6) { setMsg("Enter the code from the email.", true); return; }
    busy(form, true);
    setMsg("Verifying…");
    try {
      const { error } = await client.auth.verifyOtp({ email: pendingEmail, token, type: "email" });
      if (error) throw error;
      const { error: rpcErr } = await client.rpc("verify_session");
      if (rpcErr) { await client.auth.signOut({ scope: "local" }); throw rpcErr; }
      form.reset();
      await finish();
    } catch (err) {
      setMsg(friendly(err), true);
      if (/expired\. Start/i.test(err.message || "")) show("vSignIn");
    }
    busy(form, false);
    $("resendCode").disabled = true;
  }

  async function onSignUp(e) {
    e.preventDefault();
    const form = e.target;
    const email = $("suEmail").value.trim().toLowerCase();
    const password = $("suPassword").value;
    if (password.length < 8) { setMsg("Use a password with at least 8 characters.", true); return; }
    if (password !== $("suPassword2").value) { setMsg("The two passwords don't match.", true); return; }
    busy(form, true);
    setMsg("Creating your account…");
    try {
      const { error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      form.reset();
      show("vSignIn");
      $("siEmail").value = email;
      setMsg(`Almost done. Open the confirmation link we sent to ${email}, then sign in here.`);
    } catch (err) {
      setMsg(friendly(err), true);
    }
    busy(form, false);
  }

  async function onForgot(e) {
    e.preventDefault();
    const form = e.target;
    busy(form, true);
    try {
      const { error } = await client.auth.resetPasswordForEmail($("fpEmail").value.trim().toLowerCase(), { redirectTo: location.origin + location.pathname });
      if (error) throw error;
      setMsg("If that email has an account, a reset link is on its way. Open it on this device.");
    } catch (err) {
      setMsg(friendly(err), true);
    }
    busy(form, false);
  }

  async function onNewPassword(e) {
    e.preventDefault();
    const form = e.target;
    const password = $("npPassword").value;
    if (password.length < 8) { setMsg("Use a password with at least 8 characters.", true); return; }
    busy(form, true);
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      await client.auth.signOut({ scope: "local" });
      form.reset();
      show("vSignIn");
      setMsg("Password changed. Sign in with it now.");
    } catch (err) {
      setMsg(friendly(err), true);
    }
    busy(form, false);
  }

  async function start(callback) {
    onVerified = callback;
    $("fSignIn").addEventListener("submit", onSignIn);
    $("fCode").addEventListener("submit", onCode);
    $("fSignUp").addEventListener("submit", onSignUp);
    $("fForgot").addEventListener("submit", onForgot);
    $("fNewPw").addEventListener("submit", onNewPassword);
    $("resendCode").addEventListener("click", async () => {
      try { await sendCode(); setMsg("New code sent."); } catch (err) { setMsg(friendly(err), true); }
    });
    document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));
    $("codeInput").addEventListener("input", e => { const n = e.target.value.replace(/\D/g, "").length; if (n === 8) $("fCode").requestSubmit(); });  // Supabase codes are 6 to 10 digits; 8 is the default
    $("signOut").addEventListener("click", async () => { await client.auth.signOut(); location.reload(); });

    let recovering = arrivedFrom === "recovery";
    client.auth.onAuthStateChange(event => { if (event === "PASSWORD_RECOVERY") { recovering = true; show("vNewPw"); } });

    const { data: { session } } = await client.auth.getSession();
    if (recovering) { show("vNewPw"); return; }
    if (session) {
      const { data: ok } = await client.rpc("session_verified");
      if (ok) { await finish(); return; }
      // Arrived from the "Sign in" link in the email: that link is step 2.
      if (amrOf(session).some(m => m === "otp" || m === "magiclink")) {
        const { error } = await client.rpc("verify_session");
        if (!error) { history.replaceState(null, "", location.pathname); await finish(); return; }
        await client.auth.signOut({ scope: "local" });
        history.replaceState(null, "", location.pathname);
        show("vSignIn");
        if (arrivedFrom === "signup") setMsg("Email confirmed. Sign in to finish.");
        else setMsg("That sign-in link only works within 10 minutes of entering your password. Sign in again.", true);
        return;
      }
      await client.auth.signOut({ scope: "local" });
    }
    show("vSignIn");
  }

  // Data access for a verified session.
  const toRow = it => ({ item: String(it.item), name: it.name || null, paid: it.paid ?? null, bought_on: it.date || null, warehouse: it.warehouse || null, note: it.note || null });
  const fromRow = r => ({ item: r.item, name: r.name || "", paid: r.paid == null ? null : Number(r.paid), date: r.bought_on, warehouse: r.warehouse, note: r.note || "" });

  async function loadItems() {
    const { data, error } = await client.from("items").select("*").order("added_at");
    if (error) throw error;
    return data.map(fromRow);
  }
  async function saveItems(next, prev) {
    const keep = new Set(next.map(i => String(i.item)));
    const gone = prev.filter(i => !keep.has(String(i.item))).map(i => String(i.item));
    if (next.length) {
      const { error } = await client.from("items").upsert(next.map(toRow), { onConflict: "user_id,item" });
      if (error) throw error;
    }
    if (gone.length) {
      const { error } = await client.from("items").delete().in("item", gone);
      if (error) throw error;
    }
  }
  // Profile: store and email preference. Falls back to the store alone if the newer columns aren't in the database yet.
  async function loadProfile() {
    let { data, error } = await client.from("profiles").select("warehouse, warehouse_name, email_alerts").maybeSingle();
    if (error) ({ data } = await client.from("profiles").select("warehouse").maybeSingle());
    return data || {};
  }
  async function saveProfile(patch) {
    const row = { ...patch, updated_at: new Date().toISOString() };
    let { error } = await client.from("profiles").upsert(row);
    if (error && /column/i.test(error.message)) {
      if (!("warehouse" in patch) || "email_alerts" in patch) throw new Error("Email settings need the latest database update (run supabase/schema.sql again).");
      ({ error } = await client.from("profiles").upsert({ warehouse: patch.warehouse, updated_at: row.updated_at }));
    }
    if (error) throw error;
  }

  window.Cloud = { enabled, start, loadItems, saveItems, loadProfile, saveProfile };
})();
