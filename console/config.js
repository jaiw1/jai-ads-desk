// Reviewer console configuration. Every value here is public (no secret exists in this login).
//
// PRODUCT_NAME is the product's WORKING name and the only place the console defines it.
// The pages fill every element marked data-product-name from it, and the page title too.
//
// APP_ID / CONFIG_ID must match auth_defaults.py in the repository (the same Meta app and the same
// Facebook Login for Business configuration the CLI uses).
//
// The redirect URI is not configured here: it is always callback.html next to this page, computed at
// runtime, and it must be added EXACTLY to the app's Valid OAuth Redirect URIs in Meta. See README.md.
window.ADSDESK_CONFIG = Object.freeze({
  PRODUCT_NAME: "adsdesk",
  APP_NAME: "Jai Ads Manager",
  APP_ID: "1423255306634410",
  // Production round-1 Login for Business configuration ("adsdesk round 1", 2026-11-24).
  CONFIG_ID: "29829580363397910",
  GRAPH_VERSION: "v26.0",
  PRIVACY_URL: "../privacy.html",
  DELETION_URL: "../data-deletion.html",
  REPO_URL: "https://github.com/jaiw1/adsdesk",
});
