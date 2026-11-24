// OAuth redirect target for the reviewer console (the registered redirect URI).
//
// Meta sends the login popup here with ?code=…&state=… (or ?error=…). This page hands those values to the
// console window and closes. It never displays the code, never stores anything, and removes the code from
// the address bar straight away. Exchanging the code needs the PKCE verifier, which exists only in the
// console window's memory, so the code is useless to anything else.
//
// Two same-origin channels, no storage:
//   1. window.opener.postMessage(…, our own origin)   the normal popup path;
//   2. BroadcastChannel("adsdesk-login")              if a Cross-Origin-Opener-Policy on Meta's pages cut
//                                                     the opener link (same browser, same origin only).
// The console accepts a message only if its state matches the one it generated for that login.
(function () {
  "use strict";
  var params = new URLSearchParams(window.location.search);
  var payload = {
    type: "adsdesk-login-callback",
    code: params.get("code"),
    state: params.get("state"),
    error: params.get("error"),
    errorReason: params.get("error_reason"),
  };
  // Drop the code from the URL and history before doing anything else.
  try { window.history.replaceState(null, "", window.location.pathname); } catch (e) { /* ignore */ }

  var message = document.getElementById("message");
  var delivered = false;
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
      delivered = true;
    }
  } catch (e) { /* opener not reachable */ }
  if (typeof BroadcastChannel === "function") {
    try {
      var channel = new BroadcastChannel("adsdesk-login");
      channel.postMessage(payload);
      channel.close();
      delivered = true;
    } catch (e) { /* ignore */ }
  }
  if (delivered) {
    message.textContent = "Login finished. You can close this window and go back to the console.";
    window.close();
  } else {
    message.textContent = "This window could not reach the console. Close it and start again from the console.";
    message.className = "status error";
  }
})();
