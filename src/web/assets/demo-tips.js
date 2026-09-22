document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-demo-fields]');
  if (!button) return;
  const values = JSON.parse(button.dataset.demoFields);
  const controls = Object.keys(values).map((id) => document.getElementById(id));
  const status = button.closest('.cortex-demo-tip').querySelector('[data-demo-status]');
  if (controls.some((control) => !control)) {
    status.textContent = 'This example is not available on this form. Copy the example text instead.';
    return;
  }
  controls.forEach((control, i) => {
    control.value = values[Object.keys(values)[i]];
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
  controls[0]?.focus();
  status.textContent = 'Example filled in. Review it, then submit when ready. Nothing has run.';
});
