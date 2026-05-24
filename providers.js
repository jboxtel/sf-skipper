// LLM provider adapters. The rest of the extension speaks Anthropic Messages
// shape — system / messages (text + image + tool_use + tool_result blocks) /
// tools / tool_choice. This file translates that shape to/from OpenAI and
// Gemini on the way out and back so the content scripts (ask.js, shared.js)
// don't need provider-specific code paths.
//
// Loaded by background.js via importScripts.

var PROVIDER_TIMEOUT_MS = 60000;

var DEFAULT_MODEL = {
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4.1-mini'
};

// Resolve the active provider + key + model from sfnavOptions, handling the
// legacy single-key shape ({ anthropicApiKey, model }) so existing installs
// keep working without a user-visible migration step.
function resolveProvider(opts) {
  opts = opts || {};
  var providers = opts.providers || {};

  // Legacy install: top-level anthropicApiKey + no providers map.
  if (!opts.provider && opts.anthropicApiKey && !providers.anthropic) {
    return {
      provider: 'anthropic',
      apiKey: opts.anthropicApiKey,
      model: opts.model || DEFAULT_MODEL.anthropic,
      debug: !!opts.debug
    };
  }

  var name = opts.provider || 'gemini';
  var p = providers[name] || {};
  return {
    provider: name,
    apiKey: p.apiKey || '',
    model: p.model || DEFAULT_MODEL[name] || '',
    debug: !!opts.debug
  };
}

function missingKeyError(providerName) {
  var label = providerName === 'gemini' ? 'Google' : providerName === 'openai' ? 'OpenAI' : 'Anthropic';
  return 'No ' + label + ' API key configured. Open the extension Options and paste your key.';
}

// ─── Public entry point ─────────────────────────────────────────────────────
// `body` is Anthropic-shaped: { system, messages, tools, tool_choice, max_tokens, model }
// Returns Anthropic-shaped { content, stop_reason }.
async function providerMessageStep(opts, body) {
  var resolved = resolveProvider(opts);
  if (!resolved.apiKey) throw new Error(missingKeyError(resolved.provider));
  if (!body.model) body.model = resolved.model;
  if (!body.max_tokens) body.max_tokens = 2048;

  if (resolved.debug) {
    console.log('sfnav: providerMessageStep', {
      provider: resolved.provider,
      model: body.model,
      messages: (body.messages || []).length,
      tools: (body.tools || []).length
    });
  }

  if (resolved.provider === 'anthropic') return callAnthropicRaw(resolved, body);
  if (resolved.provider === 'openai')    return callOpenAI(resolved, body);
  if (resolved.provider === 'gemini')    return callGemini(resolved, body);
  throw new Error('Unknown provider: ' + resolved.provider);
}

// ─── Anthropic (passthrough) ────────────────────────────────────────────────

async function callAnthropicRaw(resolved, body) {
  var reqBody = Object.assign({}, body);
  var res = await timedFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': resolved.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(reqBody)
  });
  var raw = await res.text();
  var parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!res.ok) {
    var errType = parsed && parsed.error && parsed.error.type;
    var rawMsg = (parsed && parsed.error && parsed.error.message) || raw || ('HTTP ' + res.status);
    var msg = (res.status === 529 || errType === 'overloaded_error')
      ? 'Anthropic API is overloaded — please try again in a moment'
      : rawMsg;
    throw new Error(msg);
  }
  return {
    content: (parsed && parsed.content) || [],
    stop_reason: (parsed && parsed.stop_reason) || 'end_turn'
  };
}

// ─── OpenAI (Chat Completions) ──────────────────────────────────────────────

function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.filter(function (b) { return b && b.type === 'text'; })
      .map(function (b) { return b.text || ''; })
      .join('\n');
  }
  return '';
}

// Build an id→toolName map from the assistant tool_use blocks in messages so
// we can translate tool_result blocks (which only carry tool_use_id) back to
// the provider's expected shape (OpenAI tool_call_id, Gemini function_response.name).
function buildToolIdIndex(messages) {
  var idToName = {};
  (messages || []).forEach(function (m) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    m.content.forEach(function (b) {
      if (b && b.type === 'tool_use' && b.id) idToName[b.id] = b.name;
    });
  });
  return idToName;
}

function anthropicToOpenAIMessages(messages, idToName) {
  var out = [];
  (messages || []).forEach(function (m) {
    var content = m.content;
    if (m.role === 'user') {
      if (typeof content === 'string') {
        out.push({ role: 'user', content: content });
        return;
      }
      // Collect tool_result blocks (must become separate role:'tool' messages
      // in OpenAI shape) and remaining text/image parts (one user message).
      var parts = [];
      var toolResults = [];
      (content || []).forEach(function (b) {
        if (!b) return;
        if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text || '' });
        } else if (b.type === 'image') {
          var src = b.source || {};
          var url = src.type === 'base64'
            ? 'data:' + (src.media_type || 'image/jpeg') + ';base64,' + (src.data || '')
            : (src.url || '');
          if (url) parts.push({ type: 'image_url', image_url: { url: url } });
        } else if (b.type === 'tool_result') {
          toolResults.push(b);
        }
      });
      if (parts.length === 1 && parts[0].type === 'text') {
        out.push({ role: 'user', content: parts[0].text });
      } else if (parts.length) {
        out.push({ role: 'user', content: parts });
      }
      toolResults.forEach(function (tr) {
        var c = tr.content;
        if (typeof c !== 'string') {
          try { c = JSON.stringify(c); } catch (_) { c = String(c); }
        }
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: c });
      });
    } else if (m.role === 'assistant') {
      if (typeof content === 'string') {
        out.push({ role: 'assistant', content: content });
        return;
      }
      var textParts = [];
      var toolCalls = [];
      (content || []).forEach(function (b) {
        if (!b) return;
        if (b.type === 'text') {
          textParts.push(b.text || '');
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
          });
        }
      });
      var msg = { role: 'assistant' };
      var joined = textParts.join('\n').trim();
      if (joined) msg.content = joined;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      // OpenAI rejects assistant messages with neither content nor tool_calls.
      if (!msg.content && !msg.tool_calls) msg.content = '';
      out.push(msg);
    }
  });
  return out;
}

function anthropicToolsToOpenAI(tools) {
  if (!tools || !tools.length) return null;
  return tools.map(function (t) {
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    };
  });
}

function anthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice) return null;
  if (typeof toolChoice === 'string') return toolChoice;
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any')  return 'required';
  if (toolChoice.type === 'none') return 'none';
  return null;
}

async function callOpenAI(resolved, body) {
  var idToName = buildToolIdIndex(body.messages);
  var systemText = systemToText(body.system);
  var oaMessages = anthropicToOpenAIMessages(body.messages, idToName);
  if (systemText) oaMessages.unshift({ role: 'system', content: systemText });

  var reqBody = {
    model: body.model,
    messages: oaMessages,
    max_tokens: body.max_tokens
  };
  var tools = anthropicToolsToOpenAI(body.tools);
  if (tools) reqBody.tools = tools;
  var tc = anthropicToolChoiceToOpenAI(body.tool_choice);
  if (tc != null) reqBody.tool_choice = tc;

  var res = await timedFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + resolved.apiKey
    },
    body: JSON.stringify(reqBody)
  });
  var raw = await res.text();
  var parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!res.ok) {
    var msg = (parsed && parsed.error && parsed.error.message) || raw || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return openAIToAnthropicResponse(parsed);
}

function openAIToAnthropicResponse(parsed) {
  var choice = parsed && parsed.choices && parsed.choices[0];
  if (!choice) return { content: [], stop_reason: 'end_turn' };
  var msg = choice.message || {};
  var content = [];
  if (msg.content) {
    if (typeof msg.content === 'string') {
      content.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      msg.content.forEach(function (p) {
        if (p && p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
      });
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach(function (tc) {
      if (!tc || tc.type !== 'function' || !tc.function) return;
      var input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch (_) { input = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id || ('call_' + Math.random().toString(36).slice(2, 10)),
        name: tc.function.name,
        input: input
      });
    });
  }
  var stop = choice.finish_reason === 'tool_calls' ? 'tool_use'
           : choice.finish_reason === 'length'     ? 'max_tokens'
           : 'end_turn';
  return { content: content, stop_reason: stop };
}

// ─── Gemini (generateContent) ───────────────────────────────────────────────

function anthropicToGeminiContents(messages, idToName) {
  var out = [];
  (messages || []).forEach(function (m) {
    var content = m.content;
    var role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof content === 'string') {
      out.push({ role: role, parts: [{ text: content }] });
      return;
    }
    var parts = [];
    (content || []).forEach(function (b) {
      if (!b) return;
      if (b.type === 'text') {
        if (b.text) parts.push({ text: b.text });
      } else if (b.type === 'image') {
        var src = b.source || {};
        if (src.type === 'base64' && src.data) {
          parts.push({ inline_data: { mime_type: src.media_type || 'image/jpeg', data: src.data } });
        }
      } else if (b.type === 'tool_use') {
        parts.push({ function_call: { name: b.name, args: b.input || {} } });
      } else if (b.type === 'tool_result') {
        var name = idToName[b.tool_use_id] || 'unknown_tool';
        var resultValue = b.content;
        if (typeof resultValue === 'string') {
          // Gemini wants a structured response object; wrap strings in {result}.
          resultValue = { result: resultValue };
        }
        if (b.is_error) resultValue = { error: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) };
        parts.push({ function_response: { name: name, response: resultValue || {} } });
      }
    });
    if (parts.length) out.push({ role: role, parts: parts });
  });
  return out;
}

function anthropicToolsToGemini(tools) {
  if (!tools || !tools.length) return null;
  return [{
    function_declarations: tools.map(function (t) {
      return {
        name: t.name,
        description: t.description || '',
        parameters: sanitizeGeminiSchema(t.input_schema || { type: 'object', properties: {} })
      };
    })
  }];
}

// Gemini's OpenAPI subset doesn't accept some JSON Schema keywords (e.g. extra
// metadata, additionalProperties on primitives). Strip aggressively and only
// keep the fields Gemini documents.
function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  var allowed = ['type', 'description', 'enum', 'properties', 'required', 'items', 'format', 'nullable'];
  var out = {};
  allowed.forEach(function (k) {
    if (schema[k] === undefined) return;
    if (k === 'properties' && schema.properties && typeof schema.properties === 'object') {
      out.properties = {};
      Object.keys(schema.properties).forEach(function (p) {
        out.properties[p] = sanitizeGeminiSchema(schema.properties[p]);
      });
    } else if (k === 'items') {
      out.items = sanitizeGeminiSchema(schema.items);
    } else {
      out[k] = schema[k];
    }
  });
  // Gemini chokes on type:'integer' with extra constraints in some versions —
  // 'integer' is fine on its own; leave as is.
  return out;
}

function anthropicToolChoiceToGemini(toolChoice, tools) {
  if (!toolChoice) return null;
  var t = typeof toolChoice === 'string' ? { type: toolChoice } : toolChoice;
  if (t.type === 'auto') return { function_calling_config: { mode: 'AUTO' } };
  if (t.type === 'none') return { function_calling_config: { mode: 'NONE' } };
  if (t.type === 'any')  return { function_calling_config: { mode: 'ANY' } };
  if (t.type === 'tool' && t.name) {
    return { function_calling_config: { mode: 'ANY', allowed_function_names: [t.name] } };
  }
  return null;
}

async function callGemini(resolved, body) {
  var idToName = buildToolIdIndex(body.messages);
  var contents = anthropicToGeminiContents(body.messages, idToName);
  var reqBody = {
    contents: contents,
    generationConfig: { maxOutputTokens: body.max_tokens }
  };
  var sys = systemToText(body.system);
  if (sys) reqBody.system_instruction = { parts: [{ text: sys }] };
  var gtools = anthropicToolsToGemini(body.tools);
  if (gtools) reqBody.tools = gtools;
  var tcfg = anthropicToolChoiceToGemini(body.tool_choice, body.tools);
  if (tcfg) reqBody.tool_config = tcfg;

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(body.model) + ':generateContent?key=' + encodeURIComponent(resolved.apiKey);

  var res = await timedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody)
  });
  var raw = await res.text();
  var parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!res.ok) {
    var msg = (parsed && parsed.error && parsed.error.message) || raw || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return geminiToAnthropicResponse(parsed);
}

function geminiToAnthropicResponse(parsed) {
  var cand = parsed && parsed.candidates && parsed.candidates[0];
  if (!cand) {
    // Surface block reasons explicitly — Gemini will sometimes return an empty
    // candidates list with promptFeedback when content is filtered.
    var pf = parsed && parsed.promptFeedback;
    if (pf && pf.blockReason) {
      throw new Error('Gemini blocked the request: ' + pf.blockReason);
    }
    return { content: [], stop_reason: 'end_turn' };
  }
  var parts = (cand.content && cand.content.parts) || [];
  var content = [];
  var sawToolCall = false;
  parts.forEach(function (p, i) {
    if (!p) return;
    if (typeof p.text === 'string' && p.text) {
      content.push({ type: 'text', text: p.text });
    } else if (p.functionCall) {
      sawToolCall = true;
      content.push({
        type: 'tool_use',
        id: 'gem_' + Date.now().toString(36) + '_' + i + '_' + Math.random().toString(36).slice(2, 8),
        name: p.functionCall.name,
        input: p.functionCall.args || {}
      });
    }
  });
  var stop = sawToolCall ? 'tool_use'
           : cand.finishReason === 'MAX_TOKENS' ? 'max_tokens'
           : 'end_turn';
  return { content: content, stop_reason: stop };
}

// ─── Shared fetch with timeout ──────────────────────────────────────────────

function timedFetch(url, init) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, PROVIDER_TIMEOUT_MS);
  return fetch(url, Object.assign({}, init, { signal: controller.signal }))
    .finally(function () { clearTimeout(timer); });
}

// Lightweight one-shot test call used by the Options page's "Save and test"
// button. Sends a one-token ping and returns the trimmed response text or
// throws a provider error verbatim. We avoid tool use here so it works the
// same on a fresh key with no extra perms.
async function providerTestCall(opts) {
  var resolved = resolveProvider(opts);
  if (!resolved.apiKey) throw new Error(missingKeyError(resolved.provider));
  var body = {
    model: resolved.model,
    max_tokens: 16,
    system: 'Reply with exactly the word "ok" and nothing else.',
    messages: [{ role: 'user', content: 'ping' }]
  };
  var resp = await providerMessageStep(opts, body);
  var text = (resp.content.find(function (b) { return b.type === 'text'; }) || {}).text || '';
  return { provider: resolved.provider, model: resolved.model, text: text.trim() };
}
