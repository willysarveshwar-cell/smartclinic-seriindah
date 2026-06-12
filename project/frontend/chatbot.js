(function () {
  'use strict';

  const API_URL = 'http://localhost:5000/api/chat';
  const ID = 'sc-chat';

  if (document.getElementById(ID + '-btn')) return;

  let history = [];
  let isOpen = false;
  let isTyping = false;

  // ── Styles ────────────────────────────────────────────────────────────────────

  const css = `
    #${ID}-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      background: linear-gradient(135deg, #0d9488, #0f766e);
      color: #fff;
      border: none;
      border-radius: 50%;
      font-size: 22px;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(13,148,136,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
      z-index: 9999;
    }
    #${ID}-btn:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 20px rgba(13,148,136,0.55);
    }
    #${ID}-panel {
      position: fixed;
      bottom: 92px;
      right: 24px;
      width: 360px;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.18);
      display: flex;
      flex-direction: column;
      z-index: 9998;
      overflow: hidden;
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      transform: scale(0.95) translateY(12px);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.22s ease, opacity 0.22s ease;
    }
    #${ID}-panel.open {
      transform: scale(1) translateY(0);
      opacity: 1;
      pointer-events: all;
    }
    #${ID}-header {
      background: linear-gradient(135deg, #0d9488, #0f766e);
      color: #fff;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    #${ID}-header-avatar {
      width: 36px;
      height: 36px;
      background: rgba(255,255,255,0.22);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
    }
    #${ID}-header-info { flex: 1; min-width: 0; }
    #${ID}-header-info strong { display: block; font-size: 14px; font-weight: 600; }
    #${ID}-header-info span { font-size: 11px; opacity: 0.82; }
    #${ID}-close-btn {
      background: none;
      border: none;
      color: #fff;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 6px;
      line-height: 1;
      opacity: 0.82;
      transition: opacity 0.15s;
      flex-shrink: 0;
    }
    #${ID}-close-btn:hover { opacity: 1; }
    #${ID}-messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px 14px 8px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 220px;
      max-height: 320px;
    }
    #${ID}-messages::-webkit-scrollbar { width: 4px; }
    #${ID}-messages::-webkit-scrollbar-track { background: transparent; }
    #${ID}-messages::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 2px; }
    .${ID}-msg {
      max-width: 84%;
      padding: 9px 12px;
      border-radius: 12px;
      font-size: 13.5px;
      line-height: 1.55;
      word-break: break-word;
    }
    .${ID}-msg.user {
      background: #0d9488;
      color: #fff;
      align-self: flex-end;
      border-bottom-right-radius: 3px;
    }
    .${ID}-msg.bot {
      background: #f1f5f9;
      color: #1e293b;
      align-self: flex-start;
      border-bottom-left-radius: 3px;
    }
    .${ID}-msg.error {
      background: #fef2f2;
      color: #dc2626;
      align-self: flex-start;
      border-bottom-left-radius: 3px;
      font-size: 13px;
    }
    #${ID}-typing {
      display: none;
      align-self: flex-start;
      padding: 10px 14px;
      background: #f1f5f9;
      border-radius: 12px;
      border-bottom-left-radius: 3px;
      gap: 4px;
      align-items: center;
    }
    #${ID}-typing.visible { display: flex; }
    #${ID}-typing span {
      width: 7px;
      height: 7px;
      background: #94a3b8;
      border-radius: 50%;
      animation: scChatBounce 1.2s infinite ease-in-out;
    }
    #${ID}-typing span:nth-child(2) { animation-delay: 0.2s; }
    #${ID}-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes scChatBounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-5px); }
    }
    #${ID}-disclaimer {
      font-size: 10.5px;
      color: #94a3b8;
      text-align: center;
      padding: 6px 14px 4px;
      flex-shrink: 0;
      line-height: 1.4;
    }
    #${ID}-footer {
      border-top: 1px solid #e2e8f0;
      padding: 10px 12px;
      display: flex;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }
    #${ID}-input {
      flex: 1;
      border: 1px solid #e2e8f0;
      border-radius: 20px;
      padding: 8px 14px;
      font-size: 13.5px;
      font-family: inherit;
      outline: none;
      color: #1e293b;
      background: #f8fafc;
      transition: border-color 0.15s;
      min-width: 0;
    }
    #${ID}-input:focus { border-color: #0d9488; background: #fff; }
    #${ID}-input:disabled { opacity: 0.6; }
    #${ID}-send {
      width: 38px;
      height: 38px;
      background: #0d9488;
      color: #fff;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, transform 0.12s;
      flex-shrink: 0;
    }
    #${ID}-send:hover { background: #0f766e; }
    #${ID}-send:active { transform: scale(0.92); }
    #${ID}-send:disabled { background: #cbd5e1; cursor: not-allowed; transform: none; }
    @media (max-width: 480px) {
      #${ID}-panel { width: calc(100vw - 32px); right: 16px; bottom: 84px; }
      #${ID}-btn { right: 16px; bottom: 16px; }
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── DOM ───────────────────────────────────────────────────────────────────────

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <button id="${ID}-btn" title="Chat with Clinic Assistant" aria-label="Open clinic assistant chat">
      <i class="fas fa-comment-medical"></i>
    </button>
    <div id="${ID}-panel" role="dialog" aria-label="Clinic Assistant Chat" aria-modal="true">
      <div id="${ID}-header">
        <div id="${ID}-header-avatar"><i class="fas fa-robot"></i></div>
        <div id="${ID}-header-info">
          <strong>Smart Clinic Assistant</strong>
          <span>Clinic info · Health · Medication</span>
        </div>
        <button id="${ID}-close-btn" aria-label="Close chat">&times;</button>
      </div>
      <div id="${ID}-messages" aria-live="polite"></div>
      <div id="${ID}-typing"><span></span><span></span><span></span></div>
      <div id="${ID}-disclaimer">
        For emergencies call <strong>999</strong>. General information only — not a substitute for professional medical advice.
      </div>
      <div id="${ID}-footer">
        <input id="${ID}-input" type="text" placeholder="Ask about the clinic or health…" maxlength="500" autocomplete="off" />
        <button id="${ID}-send" title="Send message" aria-label="Send message">
          <i class="fas fa-paper-plane"></i>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(wrapper);

  const btn      = document.getElementById(ID + '-btn');
  const panel    = document.getElementById(ID + '-panel');
  const msgArea  = document.getElementById(ID + '-messages');
  const input    = document.getElementById(ID + '-input');
  const sendBtn  = document.getElementById(ID + '-send');
  const closeBtn = document.getElementById(ID + '-close-btn');
  const typingEl = document.getElementById(ID + '-typing');

  // Greeting message
  addMessage('bot', 'Hello! I\'m your Smart Clinic assistant. Ask me about our doctors, services, general health questions, or medication information. How can I help you today?');

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function openPanel() {
    isOpen = true;
    panel.classList.add('open');
    btn.innerHTML = '<i class="fas fa-times"></i>';
    setTimeout(() => input.focus(), 50);
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('open');
    btn.innerHTML = '<i class="fas fa-comment-medical"></i>';
  }

  function scrollToBottom() {
    msgArea.scrollTop = msgArea.scrollHeight;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderText(text) {
    return escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = ID + '-msg ' + role;
    div.innerHTML = (role === 'bot') ? renderText(text) : escapeHtml(text);
    msgArea.appendChild(div);
    scrollToBottom();
  }

  function setLoading(loading) {
    isTyping = loading;
    if (loading) {
      typingEl.classList.add('visible');
      msgArea.appendChild(typingEl);
      scrollToBottom();
    } else {
      typingEl.classList.remove('visible');
    }
    sendBtn.disabled = loading;
    input.disabled = loading;
    if (!loading) setTimeout(() => input.focus(), 20);
  }

  // ── Send logic ────────────────────────────────────────────────────────────────

  async function handleSend() {
    const text = input.value.trim();
    if (!text || isTyping) return;

    input.value = '';
    addMessage('user', text);
    history.push({ role: 'user', content: text });

    setLoading(true);

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Something went wrong. Please try again.');
      }

      const reply = data.reply;
      history.push({ role: 'assistant', content: reply });
      setLoading(false);
      addMessage('bot', reply);
    } catch (err) {
      setLoading(false);
      const div = document.createElement('div');
      div.className = ID + '-msg error';
      div.textContent = err.message || 'Unable to connect. Please check your connection and try again.';
      msgArea.appendChild(div);
      scrollToBottom();
      // Remove failed user message from history so it can be retried
      if (history[history.length - 1]?.role === 'user') {
        history.pop();
      }
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────────

  btn.addEventListener('click', () => (isOpen ? closePanel() : openPanel()));
  closeBtn.addEventListener('click', closePanel);
  sendBtn.addEventListener('click', handleSend);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Close on outside click
  document.addEventListener('click', function (e) {
    if (isOpen && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closePanel();
    }
  });

})();
