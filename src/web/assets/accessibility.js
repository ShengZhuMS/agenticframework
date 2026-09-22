const button = document.querySelector('[data-run-audit]');
button?.addEventListener('click', async () => {
  const status = document.getElementById('audit-status');
  button.disabled = true;
  status.textContent = 'Running WCAG A/AA browser checks...';
  try {
    if (!window.axe) throw new Error('Accessibility engine not available. Rebuild the vendored assets.');
    const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    const finding = (item) => ({ id: item.id, description: item.description, impact: item.impact, targets: item.nodes.map((node) => node.target.join(' ')) });
    const response = await fetch(button.dataset.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: button.dataset.fingerprint, uiRevision: button.dataset.revision,
        automatic: { version: result.testEngine.version, passes: result.passes.length, violations: result.violations.map(finding), incomplete: result.incomplete.map(finding) } })
    });
    if (!response.ok) throw new Error('The audit ran but evidence could not be saved. Reload to check permissions or stale agent/UI versions.');
    status.textContent = `${result.violations.length} violations; ${result.incomplete.length} rules need manual review; ${result.passes.length} automated rules passed. Evidence saved. Return to the assurance report for details and the manual checklist.`;
  } catch (error) {
    status.textContent = error.message;
  } finally { button.disabled = false; }
});
