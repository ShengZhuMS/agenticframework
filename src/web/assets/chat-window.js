document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-chat-window]');
  if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin) return;
  const width = Math.min(760, screen.availWidth);
  const height = Math.min(840, screen.availHeight);
  const popup = window.open(url.href, `cortex-chat-${url.pathname.split('/')[2]}`,
    `popup,width=${width},height=${height},resizable=yes,scrollbars=yes`);
  if (popup) {
    popup.opener = null;
    popup.focus();
    event.preventDefault();
  }
});

const form = document.querySelector('.cortex-chat__form');
form?.addEventListener('submit', () => {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Waiting for agent...';
  form.setAttribute('aria-busy', 'true');
  document.querySelector('[data-chat-status]').textContent = 'Your message is being sent. Keep this window open.';
});
window.addEventListener('pageshow', () => {
  const button = form?.querySelector('button[type="submit"]');
  if (button) { button.disabled = false; button.textContent = 'Send'; }
  form?.removeAttribute('aria-busy');
});
