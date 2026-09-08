// Referme la fenêtre de consentement et prévient la page principale.
// Ce script est externe (et non en ligne) pour rester compatible avec la CSP.
const ok = document.body.dataset.ok === 'true';
if (window.opener) {
  window.opener.postMessage({ type: 'familyboard:oauth', ok }, window.location.origin);
  setTimeout(() => window.close(), 1200);
}
