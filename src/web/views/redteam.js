import { esc, attr, layout } from '../layout.js';
import { publicationVerdict } from '../../bff/services/redteam.js';

export function redTeamPage(ctx, { entry, runs }) {
  return layout({ ...ctx, title: 'Foundry red teaming', section: 'build' }, `
    <a class="govuk-back-link" href="/agent/${attr(entry.id)}">Back to agent</a>
    <h1 class="govuk-heading-xl">Foundry red teaming</h1>
    <p class="govuk-body">The agent's <strong>Test and publish</strong> action runs this process automatically in the background, including after an app restart. You do not need to set up a scan or manually poll it. This page also supports separate reviewer-led assessments.</p>
    <p class="govuk-body-l">Assess ${esc(entry.name)} with the Foundry cloud AI Red Teaming Agent.</p>
    <div class="govuk-warning-text"><strong>Sandbox only. This invokes the real agent and its connected tools, incurs Azure usage, and may generate sensitive test content. Use synthetic data and read-only tools. Completion is evidence for review, not a safety certification or automatic assurance approval.</strong></div>
    <p class="govuk-body">The sandbox policy enables every generated prohibited-action scenario and uses five turns with Flip, Base64 and IndirectJailbreak strategies. Results include Foundry's prohibited-action, task-adherence and sensitive-data-leakage evaluators. For a standalone assessment, review the generated taxonomy before submitting; Test and publish applies this policy automatically.</p>
    <form method="post" action="/agent/${attr(entry.id)}/redteam/prepare">
      <label class="govuk-label"><input type="checkbox" name="confirmed" value="yes" required> I authorize this sandbox assessment and its Azure usage.</label>
      <button class="govuk-button" type="submit">Prepare assessment</button>
    </form>
    <h2 class="govuk-heading-m">Your assessments</h2>
    ${runs.length ? runs.map((r) => `<section class="govuk-inset-text">
      <h3 class="govuk-heading-s">${esc(r.id)}: ${esc(r.status)}</h3>
      ${r.publication ? `<p class="govuk-body"><strong>Automatic publication: ${esc(r.publication.status)}</strong></p>
        ${r.publication.error ? `<p role="alert" class="govuk-error-message">${esc(r.publication.error)}</p>` : ''}
        <p class="govuk-hint">${esc(r.policy)}</p>
        ${r.publication.microsoft365 ? `<p class="govuk-body-s">Teams/Microsoft 365: ${esc(r.publication.channel?.state || 'Waiting for passing assessment')}. Tenant catalogue submission is not installation or administrator approval.</p>` : ''}
        <a class="govuk-link" href="/agent/${attr(entry.id)}">View agent and publication</a>` : ''}
      <p class="govuk-body">Agent ${esc(r.target.name)}, version ${esc(r.target.version)}. Created ${esc(r.createdAt)}.</p>
      ${entry._agent?.version && String(entry._agent.version) !== String(r.target.version) ? '<p class="govuk-error-message">This assessment targets an older agent version. Prepare a new assessment for the current version before reviewing assurance.</p>' : ''}
      ${r.error ? `<p role="alert" class="govuk-error-message">${esc(r.error)}</p>` : ''}
      <p class="govuk-body"><strong>${publicationVerdict(r).passed ? 'PASSED' : r.error ? 'BLOCKED - no passing evidence' : r.status === 'completed' ? 'FAILED / INCOMPLETE EVIDENCE' : 'NOT COMPLETE'}</strong>: ${esc(publicationVerdict(r).reason)}</p>
      ${r.result?.result_counts ? `<p class="govuk-body">Samples: ${esc(r.result.result_counts.total ?? 'not reported')} total / ${esc(r.result.result_counts.passed ?? 0)} passed / ${esc(r.result.result_counts.failed ?? 0)} failed / ${esc(r.result.result_counts.errored ?? 0)} errors.</p>` : ''}
      ${r.items?.length ? `<table class="govuk-table"><caption>Evaluator results (failed or missing checks need review)</caption><thead><tr><th scope="col">Sample</th><th scope="col">Evaluator</th><th scope="col">Result</th><th scope="col">Finding</th></tr></thead><tbody>
        ${r.items.slice(0, 100).flatMap((item, i) => (item.results || []).map((result) => `<tr><th scope="row">${i + 1}</th><td>${esc(result.name)}</td><td>${result.passed === true ? 'Passed' : result.passed === false ? 'Failed' : 'Not reported'}</td><td>${esc(result.reason || result.explanation || result.error?.message || 'See detailed output for evidence.')}</td></tr>`)).join('')}
      </tbody></table><p class="govuk-hint">Showing up to 100 samples; the detailed output below contains all retrieved items. Current-version findings are reflected in the agent assurance table.</p>` : ''}
      <p class="govuk-body">Evaluation: ${esc(r.evalId || 'not created')}; run: ${esc(r.runId || 'not submitted')}.</p>
      ${r.taxonomy ? `<details class="govuk-details"><summary>Review generated taxonomy</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(r.taxonomy, null, 2))}</pre></details>` : ''}
      ${r.status === 'review-required' && !r.publication ? `<form method="post" action="/agent/${attr(entry.id)}/redteam/${attr(r.id)}/start">
        <label class="govuk-label"><input type="checkbox" name="confirmed" value="yes" required> I reviewed this taxonomy and approve the scan against this agent version.</label>
        <button class="govuk-button" type="submit">Start Foundry scan</button></form>` : ''}
      ${r.runId || r.status === 'taxonomy-pending' ? `<form method="post" action="/agent/${attr(entry.id)}/redteam/${attr(r.id)}/refresh"><button class="govuk-button govuk-button--secondary">Refresh taxonomy, status and results</button></form>` : ''}
      ${r.result ? `<details class="govuk-details"><summary>Foundry status and metrics</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(r.result, null, 2))}</pre></details>` : ''}
      ${r.items ? `<details class="govuk-details"><summary>Evaluation output items (${r.items.length})</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(r.items, null, 2))}</pre></details>` : ''}
    </section>`).join('') : '<p class="govuk-body">No assessments yet.</p>'}
    <p class="govuk-body"><a class="govuk-link" href="https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/run-ai-red-teaming-cloud">Foundry cloud red teaming prerequisites and reference</a></p>
  `);
}
