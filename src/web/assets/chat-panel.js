const panel = document.getElementById('agent-chat-panel');
if (panel) {
  const content = panel.querySelector('[data-chat-content]');
  const status = panel.querySelector('[data-chat-status]');
  const expand = panel.querySelector('[data-chat-expand]');
  let opener;
  let busy = false;

  async function load(url, options) {
    if (busy) return;
    busy = true;
    status.textContent = options?.method === 'POST' ? 'Waiting for the agent...' : 'Opening conversation...';
    content.setAttribute('aria-busy', 'true');
    content.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch(url, { ...options, credentials: 'same-origin' });
      const document = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (!response.ok) throw new Error(document.querySelector('main p')?.textContent || 'The conversation could not be loaded.');
      const chat = document.querySelector('.cortex-chat');
      if (!chat) throw new Error('The conversation could not be opened. Your session may have expired; reload the page to sign in.');
      content.replaceChildren(chat);
      status.textContent = chat.querySelector('.govuk-warning-text') ? 'The agent reported a problem. Review the message below.' : 'Conversation ready.';
      chat.querySelector('#latest')?.scrollIntoView({ block: 'nearest' });
      if (panel.open) chat.querySelector('textarea')?.focus();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      content.removeAttribute('aria-busy');
      content.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = false; });
    }
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !/^\/agent\/[^/]+\/chat$/.test(url.pathname)) return;
    event.preventDefault();
    if (!panel.open) {
      opener = link;
      panel.showModal();
    }
    load(url);
  });
  panel.addEventListener('submit', (event) => {
    const form = event.target;
    event.preventDefault();
    load(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)) });
  });
  panel.querySelector('[data-chat-close]').addEventListener('click', () => panel.close());
  panel.addEventListener('close', () => opener?.focus());
  expand.addEventListener('click', () => {
    const expanded = panel.classList.toggle('cortex-chat-panel--expanded');
    expand.setAttribute('aria-pressed', String(expanded));
    expand.textContent = expanded ? 'Shrink' : 'Expand';
  });
}
