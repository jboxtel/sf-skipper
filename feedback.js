// Feedback — collects free-text user feedback and POSTs it to the
// Supabase backend via the publishable (anon) key. The row is gated by RLS
// policies (see migration 004_feedback.sql) so the key being public is fine:
// inserts only, no select, signed-in users can't spoof another user_id.
//
// The actual POST happens in background.js (feedback.submit handler) so the
// CORS surface stays consistent with the other backend calls.

var SKIPPER_SUPABASE_URL = 'https://bdfndqbnuganvfdgtvcg.supabase.co';
var SKIPPER_SUPABASE_ANON_KEY = 'sb_publishable_Kt9RftY4MGU_QAkdjCzx-A_qij1Zl4F';

function buildFeedbackPayload(message, email, context) {
  var manifest = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest()
    : null;
  return {
    message: String(message || '').trim(),
    email: (email && String(email).trim()) || null,
    extension_ver: (manifest && manifest.version) || null,
    user_agent: (typeof navigator !== 'undefined' && navigator.userAgent) || null,
    context: (context && typeof context === 'object') ? context : null
  };
}

function sendFeedback(message, email, context) {
  return new Promise(function (resolve, reject) {
    var payload = buildFeedbackPayload(message, email, context);
    if (!payload.message) {
      reject(new Error('Message is required'));
      return;
    }
    if (payload.message.length > 4000) {
      reject(new Error('Message is too long (4000 chars max)'));
      return;
    }
    chrome.runtime.sendMessage({ type: 'feedback.submit', payload: payload }, function (resp) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!resp || !resp.ok) { reject(new Error((resp && resp.error) || 'Unknown error')); return; }
      resolve(resp);
    });
  });
}
