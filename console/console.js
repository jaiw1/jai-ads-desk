// Reviewer console: Facebook Login for Business with PKCE, entirely in the browser.
//
// Rules this file keeps:
// - The access token lives in one variable (`token`) in this closure. It is never written to cookies,
//   localStorage, sessionStorage, IndexedDB, the URL bar or the page. Closing or reloading the tab ends it.
// - No app secret exists. The code is exchanged with Graph using the PKCE verifier, which also exists
//   only in memory, for the duration of one login.
// - Everything from Meta is rendered with textContent (never innerHTML), so names, captions and ad copy
//   cannot inject markup.
// - The only write is a PAUSED campaign with no ad sets, ads or budget, and the page can rename or delete
//   only a campaign it created in this tab. Every write needs a typed confirmation word.
// - ?demo serves invented data ("Acme Foods") and makes no network request at all.
(function () {
  "use strict";

  var CFG = window.ADSDESK_CONFIG;
  var GRAPH = "https://graph.facebook.com/" + CFG.GRAPH_VERSION;
  var DIALOG = "https://www.facebook.com/" + CFG.GRAPH_VERSION + "/dialog/oauth";
  var DEMO = new URLSearchParams(window.location.search).has("demo");
  var LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
  var IG_METRICS = ["reach", "profile_views", "accounts_engaged", "total_interactions", "website_clicks"];
  var ROUND_ONE = ["public_profile", "ads_read", "ads_management", "pages_show_list", "pages_read_engagement",
                   "instagram_basic", "instagram_manage_insights"];

  var token = null;          // the only place the token is held
  var pending = null;        // {state, verifier, timer} for the one login in progress
  var created = null;        // {id, accountId, name} of the campaign this tab created
  var accounts = [];         // [{account_id, name, currency}]
  var igAccounts = [];       // [{id, username, page}]
  var busy = false;

  function $(id) { return document.getElementById(id); }

  // ---------- naming ----------
  document.querySelectorAll("[data-product-name]").forEach(function (n) { n.textContent = CFG.PRODUCT_NAME; });
  document.querySelectorAll("[data-app-name]").forEach(function (n) { n.textContent = CFG.APP_NAME; });
  document.title = CFG.PRODUCT_NAME + " reviewer console";
  if (DEMO) $("demo-banner").classList.remove("hidden");

  // ---------- small helpers ----------
  function redirectUri() {
    var u = new URL("callback.html", window.location.href);
    u.search = ""; u.hash = "";
    return u.href;
  }

  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(byteCount) {
    var a = new Uint8Array(byteCount);
    crypto.getRandomValues(a);
    return b64url(a);
  }

  function challengeFor(verifier) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (d) {
      return b64url(new Uint8Array(d));
    });
  }

  function redact(text) {
    var s = String(text == null ? "" : text);
    if (token && token.length > 8) s = s.split(token).join("[token]");
    return s.replace(/access_token=[^&\s"']+/g, "access_token=[token]");
  }

  function setStatus(id, text, kind) {
    var n = $(id);
    n.textContent = text ? redact(text) : "";
    n.className = "status" + (kind ? " " + kind : "");
  }

  function safeHref(v) {
    try {
      var u = new URL(v);
      return u.protocol === "https:" && /(^|\.)(instagram\.com|facebook\.com)$/.test(u.hostname);
    } catch (e) { return false; }
  }

  // Build DOM nodes. Strings become text nodes, never HTML.
  function el(tag, attrs) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === "class") n.className = v;
      else if (k === "href") { if (safeHref(v)) { n.href = v; n.rel = "noopener noreferrer"; n.target = "_blank"; } }
      else n.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      n.append(c instanceof Node ? c : String(c));
    }
    return n;
  }

  function fillTable(tableEl, headers, rows) {
    tableEl.replaceChildren();
    var head = el("tr");
    headers.forEach(function (h) { head.append(el("th", { scope: "col" }, h)); });
    tableEl.append(el("thead", null, head));
    var body = el("tbody");
    if (!rows.length) {
      body.append(el("tr", null, el("td", { colspan: String(headers.length) }, "Nothing to show.")));
    }
    rows.forEach(function (r) {
      var tr = el("tr");
      r.forEach(function (cell) { tr.append(el("td", null, cell)); });
      body.append(tr);
    });
    tableEl.append(body);
  }

  function kpi(label, value) {
    return el("div", { class: "kpi" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value));
  }

  var numberFmt = new Intl.NumberFormat("en-IN");
  function num(v) {
    if (v == null || v === "") return "–";
    var n = Number(v);
    return isFinite(n) ? numberFmt.format(n) : String(v);
  }
  function money(v, currency) {
    if (v == null || v === "") return "–";
    var n = Number(v);
    if (!isFinite(n)) return String(v);
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "USD" }).format(n); }
    catch (e) { return numberFmt.format(n) + " " + (currency || ""); }
  }
  function truncate(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function validName(s) {
    return typeof s === "string" && s.trim().length > 0 && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s);
  }

  function GraphError(err) {
    this.message = redact((err && err.message) || "Meta returned an error");
    this.code = err && err.code;
    this.subcode = err && err.error_subcode;
  }
  GraphError.prototype = Object.create(Error.prototype);

  // ---------- Graph access ----------
  function request(method, path, params) {
    if (DEMO) return demoGraph(method, path, params || {});
    if (!token) return Promise.reject(new Error("Not logged in"));
    if (!/^\/[A-Za-z0-9_\/]+$/.test(path)) return Promise.reject(new Error("Unexpected request path"));
    var init = { method: method, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error" };
    var url;
    if (method === "GET") {
      // Query-string token, as Meta's own JavaScript SDK does: keeps the request CORS-simple.
      var u = new URL(GRAPH + path);
      Object.keys(params || {}).forEach(function (k) { u.searchParams.set(k, params[k]); });
      u.searchParams.set("access_token", token);
      url = u.href;
    } else {
      var body = new URLSearchParams(params || {});
      body.set("access_token", token);
      init.body = body;
      url = GRAPH + path;
    }
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { throw new Error("Meta returned HTTP " + res.status); }).then(function (data) {
        if (data && data.error) throw new GraphError(data.error);
        if (!res.ok) throw new Error("Meta returned HTTP " + res.status);
        return data;
      });
    });
  }

  function collect(path, params, maxPages) {
    var out = [];
    var pages = 0;
    function next(after) {
      var p = Object.assign({ limit: "50" }, params || {});
      if (after) p.after = after;
      return request("GET", path, p).then(function (data) {
        out = out.concat(Array.isArray(data.data) ? data.data : []);
        pages += 1;
        var cursor = data.paging && data.paging.next && data.paging.cursors && data.paging.cursors.after;
        return cursor && pages < (maxPages || 3) ? next(cursor) : out;
      });
    }
    return next(null);
  }

  // ---------- login ----------
  function startLogin() {
    if (DEMO) {
      token = "demo-mode";
      afterLogin();
      return;
    }
    if (!window.crypto || !crypto.subtle) {
      setStatus("login-status", "This page must be opened over HTTPS (or on localhost) to log in.", "error");
      return;
    }
    // Open the window inside the click handler so pop-up blockers allow it, then point it at Meta.
    var popup = window.open("about:blank", "adsdesk-login", "popup,width=640,height=780");
    if (!popup) {
      setStatus("login-status", "Your browser blocked the login window. Allow pop-ups for this page and try again.", "error");
      return;
    }
    if (pending) clearTimeout(pending.timer);
    var state = randomString(32);
    var verifier = randomString(64);
    challengeFor(verifier).then(function (challenge) {
      var u = new URL(DIALOG);
      u.searchParams.set("client_id", CFG.APP_ID);
      u.searchParams.set("config_id", CFG.CONFIG_ID);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("redirect_uri", redirectUri());
      u.searchParams.set("state", state);
      // Same as the CLI: openid is what the live PKCE test used; the ID token is never used.
      u.searchParams.set("scope", "openid");
      u.searchParams.set("code_challenge", challenge);
      u.searchParams.set("code_challenge_method", "S256");
      pending = {
        state: state, verifier: verifier,
        timer: setTimeout(function () {
          pending = null;
          setStatus("login-status", "The login timed out. Start again.", "error");
        }, LOGIN_TIMEOUT_MS),
      };
      popup.location.href = u.href;
      setStatus("login-status", "Finish logging in to Meta in the pop-up window…");
    });
  }

  function onCallback(data) {
    if (!pending || !data || data.type !== "adsdesk-login-callback") return;
    if (typeof data.state !== "string" || data.state !== pending.state) return; // not our login
    var verifier = pending.verifier;
    clearTimeout(pending.timer);
    pending = null;
    if (data.error) {
      setStatus("login-status", data.error === "access_denied" ? "Login was cancelled."
        : "Meta did not complete the login (" + truncate(data.error, 64) + ").", "error");
      return;
    }
    var code = data.code;
    if (typeof code !== "string" || !code || code.length > 4096 || /[^\x21-\x7e]/.test(code)) {
      setStatus("login-status", "Meta returned an invalid login code. Start again.", "error");
      return;
    }
    setStatus("login-status", "Completing login with Meta…");
    var body = new URLSearchParams({ client_id: CFG.APP_ID, redirect_uri: redirectUri(), code_verifier: verifier, code: code });
    fetch(GRAPH + "/oauth/access_token", {
      method: "POST", body: body, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error",
    }).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok || j.error || typeof j.access_token !== "string" || /\s/.test(j.access_token)) {
          throw new GraphError(j.error || { message: "Meta did not return a token" });
        }
        token = j.access_token; // id_token, if any, is ignored and dropped with j
      });
    }).then(afterLogin).catch(function (e) {
      setStatus("login-status", "Login failed: " + e.message, "error");
    });
  }

  window.addEventListener("message", function (ev) {
    if (ev.origin !== window.location.origin) return;
    onCallback(ev.data);
  });
  if (typeof BroadcastChannel === "function") {
    new BroadcastChannel("adsdesk-login").onmessage = function (ev) { onCallback(ev.data); };
  }

  function afterLogin() {
    setStatus("login-status", "Loading your account…");
    return Promise.all([
      request("GET", "/me", { fields: "id,name" }),
      collect("/me/permissions", {}, 2),
    ]).then(function (r) {
      var me = r[0];
      var granted = r[1].filter(function (p) { return p.status === "granted"; }).map(function (p) { return p.permission; });
      $("me-name").textContent = me.name || "(no name)";
      $("me-id").textContent = me.id || "";
      $("me-perms").replaceChildren();
      granted.sort().forEach(function (p, i) {
        if (i) $("me-perms").append(", ");
        $("me-perms").append(el("code", null, p));
      });
      var missing = ROUND_ONE.filter(function (p) { return granted.indexOf(p) < 0; });
      $("logged-out").classList.add("hidden");
      $("logged-in").classList.remove("hidden");
      $("app").classList.remove("hidden");
      setStatus("login-status", missing.length ? "Not granted (those sections will show an error): " + missing.join(", ") : "Logged in. Nothing is stored; reloading this tab logs you out.", missing.length ? "" : "ok");
      $("new-name").value = CFG.PRODUCT_NAME + " review test " + new Date().toISOString().slice(0, 16).replace("T", " ");
      loadAccounts();
      loadPages();
    }).catch(function (e) {
      token = null;
      setStatus("login-status", "Could not read your account: " + e.message, "error");
    });
  }

  function logout() {
    token = null;
    pending = null;
    created = null;
    accounts = [];
    igAccounts = [];
    ["account-kpis", "campaigns-table", "insights-table", "pages-table", "ig-profile", "ig-insights", "ig-media",
     "created-kpis", "account-select", "ig-select", "me-perms"].forEach(function (id) { $(id).replaceChildren(); });
    $("me-name").textContent = ""; $("me-id").textContent = "";
    ["ads-status", "pages-status", "ig-status", "write-status"].forEach(function (id) { setStatus(id, ""); });
    $("created").classList.add("hidden");
    $("app").classList.add("hidden");
    $("logged-in").classList.add("hidden");
    $("logged-out").classList.remove("hidden");
  }

  function revoke() {
    confirmAction({
      title: "Remove app access on Meta",
      summary: "This removes the “" + CFG.APP_NAME + "” app's access to your Facebook account everywhere (DELETE /me/permissions), including the command-line tool if you use it. Then this page forgets the token.",
      rows: [["Request", "DELETE /me/permissions"]],
      word: "REMOVE",
    }).then(function (ok) {
      if (!ok) return;
      request("POST", "/me/permissions", { method: "delete" }).then(function (r) {
        logout();
        setStatus("login-status", r && r.success ? "App access removed on Meta and token forgotten." : "Meta did not confirm the removal; token forgotten. Check Facebook → Settings → Business integrations.", r && r.success ? "ok" : "error");
      }).catch(function (e) { setStatus("login-status", "Could not remove access: " + e.message, "error"); });
    });
  }

  // ---------- ad accounts (ads_read) ----------
  function selectedAccount() {
    var id = $("account-select").value;
    return accounts.filter(function (a) { return a.account_id === id; })[0] || null;
  }

  function loadAccounts() {
    setStatus("ads-status", "Loading ad accounts…");
    collect("/me/adaccounts", { fields: "id,account_id,name,currency,account_status" }, 3).then(function (list) {
      accounts = list.filter(function (a) { return /^\d+$/.test(String(a.account_id || "")); });
      var sel = $("account-select");
      sel.replaceChildren();
      accounts.forEach(function (a) {
        sel.append(el("option", { value: a.account_id }, (a.name || "(unnamed)") + " · act_" + a.account_id));
      });
      if (!accounts.length) { setStatus("ads-status", "No ad accounts were shared with this login.", "error"); return; }
      loadAdAccount();
    }).catch(function (e) { setStatus("ads-status", "Ad accounts: " + e.message, "error"); });
  }

  function loadAdAccount() {
    var acct = selectedAccount();
    if (!acct) return;
    var preset = $("preset-select").value;
    var act = "/act_" + acct.account_id;
    setStatus("ads-status", "Loading " + (acct.name || acct.account_id) + "…");
    Promise.allSettled([
      request("GET", act + "/insights", { fields: "spend,impressions,reach,clicks,ctr,cpm", date_preset: preset, level: "account" }),
      collect(act + "/campaigns", { fields: "id,name,status,effective_status,objective" }, 2),
      collect(act + "/insights", { fields: "campaign_id,campaign_name,spend,impressions,clicks,ctr", date_preset: preset, level: "campaign" }, 2),
    ]).then(function (r) {
      var errors = [];
      var box = $("account-kpis");
      box.replaceChildren();
      if (r[0].status === "fulfilled") {
        var row = (r[0].value.data || [])[0] || {};
        box.append(kpi("Spend", money(row.spend || 0, acct.currency)), kpi("Impressions", num(row.impressions || 0)),
                   kpi("Reach", num(row.reach || 0)), kpi("Clicks", num(row.clicks || 0)),
                   kpi("CTR", row.ctr ? Number(row.ctr).toFixed(2) + "%" : "–"), kpi("CPM", money(row.cpm, acct.currency)));
      } else errors.push("account insights: " + r[0].reason.message);
      if (r[1].status === "fulfilled") {
        fillTable($("campaigns-table"), ["Campaign", "ID", "Status", "Delivery", "Objective"], r[1].value.map(function (c) {
          return [c.name, c.id, c.status, c.effective_status, c.objective];
        }));
      } else { fillTable($("campaigns-table"), ["Campaign"], []); errors.push("campaigns: " + r[1].reason.message); }
      if (r[2].status === "fulfilled") {
        fillTable($("insights-table"), ["Campaign", "Spend", "Impressions", "Clicks", "CTR"], r[2].value.map(function (c) {
          return [c.campaign_name, money(c.spend, acct.currency), num(c.impressions), num(c.clicks), c.ctr ? Number(c.ctr).toFixed(2) + "%" : "–"];
        }));
      } else { fillTable($("insights-table"), ["Campaign"], []); errors.push("campaign insights: " + r[2].reason.message); }
      setStatus("ads-status", errors.length ? errors.join(" · ") : "Read from Meta just now.", errors.length ? "error" : "");
    });
  }

  // ---------- Pages (pages_show_list, pages_read_engagement) ----------
  function loadPages() {
    setStatus("pages-status", "Loading Pages…");
    collect("/me/accounts", { fields: "id,name,category,fan_count,followers_count,instagram_business_account{id,username}" }, 3).then(function (pages) {
      igAccounts = [];
      fillTable($("pages-table"), ["Page", "ID", "Category", "Likes", "Followers", "Linked Instagram account"], pages.map(function (p) {
        var ig = p.instagram_business_account;
        if (ig && /^\d+$/.test(String(ig.id || ""))) igAccounts.push({ id: ig.id, username: ig.username, page: p.name });
        return [p.name, p.id, p.category, num(p.fan_count), num(p.followers_count), ig ? "@" + (ig.username || ig.id) : "none"];
      }));
      setStatus("pages-status", pages.length ? "" : "No Pages were shared with this login.", pages.length ? "" : "error");
      var sel = $("ig-select");
      sel.replaceChildren();
      igAccounts.forEach(function (a) { sel.append(el("option", { value: a.id }, "@" + (a.username || a.id) + " (Page: " + a.page + ")")); });
      if (igAccounts.length) loadInstagram();
      else setStatus("ig-status", "None of the shared Pages has a linked Instagram professional account.", "error");
    }).catch(function (e) {
      setStatus("pages-status", "Pages: " + e.message, "error");
      setStatus("ig-status", "Instagram accounts are found through your Pages, which could not be read.", "error");
    });
  }

  // ---------- Instagram (instagram_basic, instagram_manage_insights) ----------
  function igInsights(igId, since, until) {
    var base = { period: "day", metric_type: "total_value", since: String(since), until: String(until) };
    function parse(data) {
      var out = {};
      (data.data || []).forEach(function (m) { out[m.name] = m.total_value ? m.total_value.value : null; });
      return out;
    }
    return request("GET", "/" + igId + "/insights", Object.assign({ metric: IG_METRICS.join(",") }, base)).then(function (d) {
      return { values: parse(d), dropped: [] };
    }).catch(function () {
      // Meta rejects the whole request if one metric is unavailable; find which ones it serves.
      return Promise.allSettled(IG_METRICS.map(function (m) {
        return request("GET", "/" + igId + "/insights", Object.assign({ metric: m }, base));
      })).then(function (rs) {
        var values = {}, dropped = [];
        rs.forEach(function (r, i) {
          if (r.status === "fulfilled") Object.assign(values, parse(r.value)); else dropped.push(IG_METRICS[i]);
        });
        return { values: values, dropped: dropped };
      });
    });
  }

  function loadInstagram() {
    var igId = $("ig-select").value;
    if (!/^\d+$/.test(igId)) return;
    setStatus("ig-status", "Loading Instagram…");
    var until = Math.floor(Date.now() / 1000);
    var since = until - 7 * 86400;
    Promise.allSettled([
      request("GET", "/" + igId, { fields: "id,username,name,followers_count,follows_count,media_count" }),
      igInsights(igId, since, until),
      request("GET", "/" + igId + "/media", { fields: "id,caption,media_type,timestamp,permalink,like_count,comments_count", limit: "6" }),
    ]).then(function (r) {
      var errors = [];
      var prof = $("ig-profile");
      prof.replaceChildren();
      if (r[0].status === "fulfilled") {
        var p = r[0].value;
        prof.append(kpi("Account", "@" + (p.username || p.id)), kpi("Followers", num(p.followers_count)),
                    kpi("Following", num(p.follows_count)), kpi("Posts", num(p.media_count)));
      } else errors.push("profile: " + r[0].reason.message);
      var ins = $("ig-insights");
      ins.replaceChildren();
      if (r[1].status === "fulfilled") {
        var labels = { reach: "Reach", profile_views: "Profile views", accounts_engaged: "Accounts engaged",
                       total_interactions: "Interactions", website_clicks: "Website clicks" };
        IG_METRICS.forEach(function (m) {
          if (m in r[1].value.values) ins.append(kpi(labels[m], num(r[1].value.values[m])));
        });
        if (r[1].value.dropped.length) errors.push("Meta did not return: " + r[1].value.dropped.join(", "));
      } else errors.push("insights: " + r[1].reason.message);
      if (r[2].status === "fulfilled") {
        fillTable($("ig-media"), ["Posted", "Type", "Caption", "Likes", "Comments", "Link"], (r[2].value.data || []).map(function (m) {
          return [String(m.timestamp || "").slice(0, 10), m.media_type, truncate(m.caption, 120), num(m.like_count), num(m.comments_count),
                  m.permalink && safeHref(m.permalink) ? el("a", { href: m.permalink }, "Open") : "–"];
        }));
      } else { fillTable($("ig-media"), ["Posted"], []); errors.push("media: " + r[2].reason.message); }
      setStatus("ig-status", errors.join(" · "), errors.length ? "error" : "");
    });
  }

  // ---------- confirmation dialog ----------
  function confirmAction(opts) {
    return new Promise(function (resolve) {
      var dlg = $("confirm-dialog"), input = $("confirm-input"), ok = $("confirm-ok");
      $("confirm-title").textContent = opts.title;
      $("confirm-summary").textContent = opts.summary;
      fillTable($("confirm-table"), ["Field", "Value"], opts.rows);
      $("confirm-word").textContent = opts.word;
      input.value = "";
      ok.disabled = true;
      input.oninput = function () { ok.disabled = input.value !== opts.word; };
      dlg.onclose = function () { resolve(dlg.returnValue === "ok" && input.value === opts.word); };
      dlg.returnValue = "";
      dlg.showModal();
      input.focus();
    });
  }

  function withBusy(fn) {
    if (busy) { setStatus("write-status", "Another change is still running; nothing new was sent. Try again in a moment.", "error"); return; }
    busy = true;
    ["create-btn", "rename-btn", "delete-btn"].forEach(function (id) { $(id).disabled = true; });
    Promise.resolve().then(fn).catch(function (e) {
      setStatus("write-status", e.message, "error");
    }).then(function () {
      busy = false;
      ["create-btn", "rename-btn", "delete-btn"].forEach(function (id) { $(id).disabled = false; });
    });
  }

  function readCampaign(id) {
    return request("GET", "/" + id, { fields: "id,account_id,name,status,effective_status,objective" });
  }

  function showCreated(c) {
    $("created").classList.remove("hidden");
    $("created-kpis").replaceChildren(kpi("Campaign ID", c.id), kpi("Name", c.name), kpi("Status", c.status),
                                      kpi("Objective", c.objective || "–"));
  }

  // ---------- the one safe write (ads_management) ----------
  function createCampaign() {
    var acct = selectedAccount();
    var name = $("new-name").value;
    if (!acct) { setStatus("write-status", "Pick an ad account in section 2 first.", "error"); return; }
    if (!validName(name)) { setStatus("write-status", "Enter a campaign name (1–200 characters).", "error"); return; }
    if (created) { setStatus("write-status", "Delete the campaign created in this tab before creating another.", "error"); return; }
    confirmAction({
      title: "Create a paused campaign",
      summary: "This sends one request to Meta and creates the campaign below. It is PAUSED and has no ad sets, ads or budget, so it cannot spend money.",
      rows: [["Ad account", (acct.name || "") + " (act_" + acct.account_id + ")"], ["Name", name], ["Status", "PAUSED"],
             ["Objective", "OUTCOME_AWARENESS"], ["Special ad categories", "none"], ["Request", "POST /act_" + acct.account_id + "/campaigns"]],
      word: "CREATE",
    }).then(function (ok) {
      if (!ok) { setStatus("write-status", "Cancelled. Nothing was sent."); return; }
      withBusy(function () {
        setStatus("write-status", "Creating…");
        return request("POST", "/act_" + acct.account_id + "/campaigns", {
          name: name, objective: "OUTCOME_AWARENESS", status: "PAUSED",
          special_ad_categories: "[]", is_adset_budget_sharing_enabled: "false",
        }).then(function (res) {
          if (!res || !/^\d+$/.test(String(res.id || ""))) throw new Error("Meta did not return a campaign ID.");
          created = { id: String(res.id), accountId: acct.account_id, name: name };
          return readCampaign(created.id);
        }).then(function (c) {
          created.name = c.name;
          showCreated(c);
          $("rename-name").value = c.name + " (renamed)";
          if (c.status !== "PAUSED") {
            setStatus("write-status", "Warning: Meta reports status " + c.status + ", not PAUSED. Delete it now.", "error");
          } else {
            setStatus("write-status", "Created and read back from Meta: status PAUSED.", "ok");
          }
          loadAdAccount();
        });
      });
    });
  }

  function guardCreated() {
    if (!created) throw new Error("This tab has not created a campaign.");
    return readCampaign(created.id).then(function (c) {
      if (String(c.account_id) !== created.accountId) throw new Error("The campaign is not in the expected ad account.");
      if (c.status !== "PAUSED") throw new Error("The campaign is no longer PAUSED (" + c.status + "); this page only changes paused campaigns.");
      return c;
    });
  }

  function renameCampaign() {
    var name = $("rename-name").value;
    if (!created) { setStatus("write-status", "Create a campaign first.", "error"); return; }
    if (!validName(name)) { setStatus("write-status", "Enter a new name (1–200 characters).", "error"); return; }
    confirmAction({
      title: "Rename the campaign",
      summary: "This changes only the name. Status stays PAUSED; nothing else changes.",
      rows: [["Campaign ID", created.id], ["Current name", created.name], ["New name", name], ["Request", "POST /" + created.id]],
      word: "RENAME",
    }).then(function (ok) {
      if (!ok) { setStatus("write-status", "Cancelled. Nothing was sent."); return; }
      withBusy(function () {
        setStatus("write-status", "Renaming…");
        return guardCreated().then(function () {
          return request("POST", "/" + created.id, { name: name });
        }).then(function () { return readCampaign(created.id); }).then(function (c) {
          created.name = c.name;
          showCreated(c);
          setStatus("write-status", c.name === name ? "Renamed and read back from Meta." : "Meta reports a different name than requested: " + c.name, c.name === name ? "ok" : "error");
          loadAdAccount();
        });
      });
    });
  }

  function deleteCampaign() {
    if (!created) { setStatus("write-status", "Create a campaign first.", "error"); return; }
    confirmAction({
      title: "Delete the campaign",
      summary: "This sets the campaign's status to DELETED. Meta does not let a deleted campaign be restored.",
      rows: [["Campaign ID", created.id], ["Name", created.name], ["Request", "POST /" + created.id + " status=DELETED"]],
      word: "DELETE",
    }).then(function (ok) {
      if (!ok) { setStatus("write-status", "Cancelled. Nothing was sent."); return; }
      withBusy(function () {
        setStatus("write-status", "Deleting…");
        return guardCreated().then(function () {
          return request("POST", "/" + created.id, { status: "DELETED" });
        }).then(function () {
          return readCampaign(created.id).then(function (c) { return c.status; }, function (e) {
            if (e.code === 100) return "GONE"; // Meta no longer returns deleted objects to some reads
            throw e;
          });
        }).then(function (status) {
          if (status === "DELETED" || status === "GONE") {
            created = null;
            $("created").classList.add("hidden");
            setStatus("write-status", "Deleted, and confirmed with Meta.", "ok");
          } else {
            setStatus("write-status", "Meta still reports status " + status + ". Check Ads Manager.", "error");
          }
          loadAdAccount();
        });
      });
    });
  }

  // ---------- demo data (no network) ----------
  var demo = {
    nextId: 120200000000001,
    campaigns: [
      { id: "120100000000001", account_id: "1111111111", name: "Weekend menu – reach", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_AWARENESS" },
      { id: "120100000000002", account_id: "1111111111", name: "Lunch boxes – traffic", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_TRAFFIC" },
    ],
  };
  function demoGraph(method, path, params) {
    var ig = "17841400000000001";
    function reply(v) { return new Promise(function (r) { setTimeout(function () { r(JSON.parse(JSON.stringify(v))); }, 120); }); }
    function fail(code, msg) { return new Promise(function (_, j) { setTimeout(function () { j(new GraphError({ code: code, message: msg })); }, 120); }); }
    var live = demo.campaigns.filter(function (c) { return c.status !== "DELETED"; });
    if (method === "GET") {
      if (path === "/me") return reply({ id: "1000000000000001", name: "Alex Reviewer" });
      if (path === "/me/permissions") return reply({ data: ROUND_ONE.map(function (p) { return { permission: p, status: "granted" }; }) });
      if (path === "/me/adaccounts") return reply({ data: [{ id: "act_1111111111", account_id: "1111111111", name: "Acme Foods", currency: "INR", account_status: 1 }] });
      if (path === "/act_1111111111/insights" && params.level === "account") return reply({ data: [{ spend: "4250.75", impressions: "182340", reach: "90211", clicks: "2311", ctr: "1.2674", cpm: "23.31" }] });
      if (path === "/act_1111111111/insights") return reply({ data: [{ campaign_id: "120100000000001", campaign_name: "Weekend menu – reach", spend: "3120.50", impressions: "151002", clicks: "1702", ctr: "1.127" }, { campaign_id: "120100000000002", campaign_name: "Lunch boxes – traffic", spend: "1130.25", impressions: "31338", clicks: "609", ctr: "1.943" }] });
      if (path === "/act_1111111111/campaigns") return reply({ data: live });
      if (path === "/me/accounts") return reply({ data: [{ id: "2000000000000001", name: "Acme Foods", category: "Restaurant", fan_count: 1520, followers_count: 1874, instagram_business_account: { id: ig, username: "acmefoods" } }] });
      if (path === "/" + ig) return reply({ id: ig, username: "acmefoods", name: "Acme Foods", followers_count: 2410, follows_count: 180, media_count: 96 });
      if (path === "/" + ig + "/insights") return reply({ data: String(params.metric).split(",").map(function (m, i) { return { name: m, period: "day", total_value: { value: [8120, 640, 512, 1290, 37][IG_METRICS.indexOf(m)] || i } }; }) });
      if (path === "/" + ig + "/media") return reply({ data: [
        { id: "1", caption: "New weekend menu is here. Book a table!", media_type: "IMAGE", timestamp: "2026-11-21T10:00:00+0000", permalink: "https://www.instagram.com/p/demo1/", like_count: 132, comments_count: 9 },
        { id: "2", caption: "Behind the scenes in our kitchen", media_type: "VIDEO", timestamp: "2026-11-18T09:30:00+0000", permalink: "https://www.instagram.com/p/demo2/", like_count: 208, comments_count: 14 },
      ] });
      var found = demo.campaigns.filter(function (c) { return "/" + c.id === path; })[0];
      if (found) return found.status === "DELETED" ? fail(100, "Unsupported get request.") : reply(found);
      return fail(100, "Unknown demo path " + path);
    }
    if (path === "/me/permissions") return reply({ success: true });
    if (path === "/act_1111111111/campaigns") {
      var c = { id: String(demo.nextId++), account_id: "1111111111", name: params.name, status: params.status, effective_status: params.status, objective: params.objective };
      demo.campaigns.push(c);
      return reply({ id: c.id });
    }
    var target = demo.campaigns.filter(function (x) { return "/" + x.id === path; })[0];
    if (target) {
      if (params.name) target.name = params.name;
      if (params.status) { target.status = params.status; target.effective_status = params.status; }
      return reply({ success: true });
    }
    return fail(100, "Unknown demo path " + path);
  }

  // ---------- wiring ----------
  $("login-btn").addEventListener("click", startLogin);
  $("logout-btn").addEventListener("click", function () { logout(); setStatus("login-status", "Token forgotten."); });
  $("revoke-btn").addEventListener("click", revoke);
  $("account-select").addEventListener("change", loadAdAccount);
  $("preset-select").addEventListener("change", loadAdAccount);
  $("refresh-ads").addEventListener("click", loadAdAccount);
  $("ig-select").addEventListener("change", loadInstagram);
  $("create-btn").addEventListener("click", createCampaign);
  $("rename-btn").addEventListener("click", renameCampaign);
  $("delete-btn").addEventListener("click", deleteCampaign);
})();
