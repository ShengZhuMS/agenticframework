/**
 * The agent page — test it, see its gates, publish it.
 *
 * This is where the golden path turns: an agent that answers a real question
 * with its sources named, and then becomes a part everyone else can build
 * with. Steps 8, 9 and 10 of the demo all happen on this screen.
 */

import { esc, attr, layout } from '../layout.js';
import { gateTable } from './build.js';
import { demoTip, DEMO_PROMPTS } from '../demo.js';

function toolCallList(calls) {
  const rows = (calls || []).filter((c) => c.kind !== 'list');
  if (!rows.length) return '';
  return `<h3 class="govuk-heading-s">Tools this answer used</h3>
  <ul class="govuk-list govuk-list--bullet">
    ${rows
      .map(
        (c) => `<li><strong>${esc(c.server || 'tool')}</strong>${c.tool ? ` › ${esc(c.tool)}` : ''}
          ${c.arguments && c.arguments !== '{}' ? `<span class="cortex-src">with ${esc(c.arguments)}</span>` : ''}
          ${c.error ? `<span class="cortex-src" style="color:#d4351c">failed: ${esc(c.error)}</span>` : ''}</li>`
      )
      .join('')}
  </ul>
  <p class="govuk-hint">Every tool call was approved by Cortex on your behalf and recorded here. That is the approval gate: visible and attributable, not a click mid-answer.</p>`;
}

/** A failure, said plainly, with the raw text folded away for whoever debugs it. */
function failurePanel(error) {
  return `<div class="govuk-warning-text">
    <span class="govuk-warning-text__icon" aria-hidden="true">!</span>
    <strong class="govuk-warning-text__text"><span class="govuk-visually-hidden">Warning</span>${esc(error.heading)}</strong>
  </div>
  <p class="govuk-body">${esc(error.message)}</p>
  <details class="govuk-details"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">Technical detail</span></summary>
    <div class="govuk-details__text"><code style="font-size:13px;word-break:break-all">${esc(error.detail)}</code></div></details>`;
}

function provenancePanel(answer) {
  if (!answer) return '';
  return `
<div class="govuk-inset-text">
  ${toolCallList(answer.toolCalls)}
  <h3 class="govuk-heading-s">Where this answer came from</h3>
  ${
    answer.sources?.length
      ? `<dl class="govuk-summary-list">
           ${answer.sources
             .map(
               (s) => `<div class="govuk-summary-list__row">
                 <dt class="govuk-summary-list__key">${esc(s.name)}</dt>
                 <dd class="govuk-summary-list__value">
                   ${esc(s.used || 'Used in the answer')}
                   ${s.freshness ? `<span class="cortex-src">Freshness at time of asking: ${esc(s.freshness)}</span>` : ''}
                 </dd>
               </div>`
             )
             .join('')}
         </dl>`
      : '<p class="govuk-body">No sources were named.</p>'
  }
  ${
    answer.confidence
      ? `<p class="govuk-body-s"><strong>Confidence:</strong> ${esc(answer.confidence)}</p>`
      : ''
  }
  ${
    answer.couldNotReach?.length
      ? `<h3 class="govuk-heading-s">What it could not reach</h3>
         <ul class="govuk-list govuk-list--bullet">
           ${answer.couldNotReach.map((c) => `<li>${esc(c)}</li>`).join('')}
         </ul>
         <p class="govuk-hint govuk-!-margin-bottom-0">
           An answer built from some of the relevant sources is a different answer.
           Cortex says so rather than quietly giving you a number.
         </p>`
      : ''
  }
</div>`;
}

export function agentPage(ctx, { entry, gates, knowledge, tools, answer, question, published, rebuilt }) {
  const a = entry._agent || {};
  const def = a.definition || {};
  const exampleQuestion = def.artefactId
    ? 'Use your source_agent tool to ask the connected agent for one sentence about drafting a synthetic operations briefing. Return its reply; do not claim access to company data.'
    : (def.knowledge || []).length ? DEMO_PROMPTS.record : 'Review this draft and identify unsupported claims: these values are synthetic examples, not operational evidence.';

  const content = `
${
  rebuilt
    ? `<div class="govuk-notification-banner govuk-notification-banner--success" role="alert" aria-labelledby="rb-t">
         <div class="govuk-notification-banner__header"><p class="govuk-notification-banner__title" id="rb-t">Tools rebuilt</p></div>
         <div class="govuk-notification-banner__content"><p class="govuk-body govuk-!-margin-bottom-0">Version ${esc(a.version || '')} in Foundry, with ${esc((a.connections || []).length)} tool connection${(a.connections || []).length === 1 ? '' : 's'}${a.grounding?.grounded?.length ? ` and ${esc(a.grounding.grounded.length)} data index${a.grounding.grounded.length === 1 ? '' : 'es'}` : ''}. Ask it something.</p></div>
       </div>`
    : ''
}
${
  published
    ? `<div class="govuk-notification-banner govuk-notification-banner--success" role="alert" aria-labelledby="pub-t">
         <div class="govuk-notification-banner__header">
           <p class="govuk-notification-banner__title" id="pub-t">Published</p>
         </div>
         <div class="govuk-notification-banner__content">
           <p class="govuk-body">
             <strong>${esc(entry.name)}</strong> is now in Cortex, and callable as an MCP server.
           </p>
           <p class="govuk-body govuk-!-margin-bottom-0">
             <a class="govuk-link" href="/entry/${attr(entry.id)}">See its Cortex entry</a>
           </p>
         </div>
       </div>`
    : ''
}

<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <span class="govuk-caption-l">Agent · built by ${esc(def.builtByTeam || entry.owner)}</span>
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">${esc(entry.name)}</h1>
    <p class="govuk-body"><a class="govuk-link" href="/entry/${attr(entry.id)}/lineage">View artefact lineage</a> · <a class="govuk-link" href="/share?kind=m365">Publish to Teams and Microsoft 365</a></p>
    <p class="govuk-body-l">${esc(def.instructions || entry.desc)}</p>
    ${
      a.published
        ? '<strong class="govuk-tag govuk-tag--green">Published</strong>'
        : '<strong class="govuk-tag govuk-tag--grey">Not shared yet</strong>'
    }
  </div>
</div>

<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">

    <h2 class="govuk-heading-m">Test it</h2>
    ${demoTip({ text: exampleQuestion, fields: { question: exampleQuestion }, note: 'Review the answer and source evidence; synthetic data is not operational or clinical advice.' })}
    <p class="govuk-body">
      Ask it something real. If the answer is wrong, change the instructions and try
      again — nothing is shared until you share it.
    </p>

    <form method="post" action="/agent/${attr(entry.id)}/ask">
      <div class="govuk-form-group">
        <label class="govuk-label" for="question">Your question</label>
        <input class="govuk-input" id="question" name="question" type="text"
               value="${attr(question || '')}"
               placeholder="Summarise the synthetic service performance data and cite its limitations.">
      </div>
      <button class="govuk-button" type="submit">Ask it</button>
    </form>

    ${
      answer?.error
        ? failurePanel(answer.error)
        : answer
          ? `<h3 class="govuk-heading-s">Answer</h3>
           <div style="border-left:5px solid #b1b4b6;padding-left:15px;margin-bottom:20px">
             <p class="govuk-body" style="white-space:pre-wrap">${esc(answer.text)}</p>
           </div>
           ${provenancePanel(answer)}`
          : ''
    }

    <p class="govuk-body">
      <a class="govuk-button govuk-button--secondary" href="/agent/${attr(entry.id)}/chat" role="button">Chat with this agent</a>
      <span class="cortex-src" style="margin-left:8px">Opens a bottom-right chat panel. Without JavaScript, opens the conversation page.</span>
    </p>

    <h2 class="govuk-heading-m">Assurance gates</h2>
    <p class="govuk-body">
      Computed from what this agent reads and what it may do.
    </p>
    ${gateTable(gates.map((gate) => gate.id === 'redteam' ? { ...gate, evidence: `/agent/${encodeURIComponent(entry.id)}/redteam` } : gate))}
    <p class="govuk-body"><a class="govuk-link" href="/agent/${attr(entry.id)}/assurance">Responsible AI report and accessibility evidence</a></p>
    <p class="govuk-body"><a class="govuk-button govuk-button--secondary" href="/agent/${attr(entry.id)}/redteam">Foundry red team assessment</a></p>
    <p class="govuk-hint">Generate, review and run a native Foundry assessment against a pinned agent version. Reports are evidence for a human reviewer; a completed scan does not automatically clear assurance gates.</p>

    <h2 class="govuk-heading-m">What it reads</h2>
    ${
      knowledge.length
        ? `<ul class="govuk-list govuk-list--bullet">
             ${knowledge
               .map(
                 (k) =>
                   `<li><a class="govuk-link" href="/entry/${attr(k.id)}">${esc(k.name)}</a>
                    <span class="cortex-src">${esc(k.fresh)} · ${esc(k.sens)}</span></li>`
               )
               .join('')}
           </ul>`
        : '<p class="govuk-hint">Nothing attached.</p>'
    }

    <h2 class="govuk-heading-m">What it may do</h2>
    <ul class="govuk-list govuk-list--bullet">
      ${(def.actions || []).map((x) => `<li>${esc(x)}</li>`).join('')}
    </ul>

    <h2 class="govuk-heading-m">Instructions it actually runs with</h2>
    <p class="govuk-hint">
      Your words, plus the house rules Cortex appends. Shown rather than hidden —
      an instruction you cannot see is one you cannot be accountable for.
    </p>
    <details style="margin-bottom:20px">
      <summary class="govuk-link" style="cursor:pointer">Show the full instructions</summary>
      <pre style="white-space:pre-wrap;font-family:inherit;font-size:16px;background:#f3f2f1;padding:15px;margin-top:10px">${esc(
        a.composedInstructions || def.instructions || ''
      )}</pre>
    </details>
  </div>

  <!-- ------------------------------------------------------ publish panel -->
  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">${a.published ? 'Published' : 'Share it'}</h2>
      ${
        a.published
          ? `<p class="govuk-body-s">Other agents and developers can call this.</p>
             <h3 class="govuk-heading-s">MCP endpoint</h3>
             <code style="font-size:14px;word-break:break-all;display:block;background:#fff;padding:8px;border:1px solid #b1b4b6">${esc(
               entry._endpoints?.mcp || ''
             )}</code>
             ${
               entry._endpoints?.openapi
                 ? `<h3 class="govuk-heading-s" style="margin-top:15px">OpenAPI</h3>
                    <code style="font-size:14px;word-break:break-all;display:block;background:#fff;padding:8px;border:1px solid #b1b4b6">${esc(
                      entry._endpoints.openapi
                    )}</code>`
                 : ''
             }
             <p class="govuk-body-s" style="margin-top:15px">
               Visible as: <strong>${esc(entry.access)}</strong>
             </p>
             <p class="govuk-body-s govuk-!-margin-bottom-0">
               <a class="govuk-link" href="/entry/${attr(entry.id)}">See it in Cortex</a>
             </p>`
          : `<p class="govuk-body-s">
               Publishing makes this callable by other people, other agents and other
               developers. It becomes an entry in Cortex like any other.
             </p>
             <form method="post" action="/agent/${attr(entry.id)}/publish">
               <div class="govuk-form-group">
                 <fieldset class="govuk-fieldset">
                   <legend class="govuk-fieldset__legend"><strong>Who can call it?</strong></legend>
                   <div class="govuk-radios govuk-radios--small">
                     <div class="govuk-radios__item">
                       <input class="govuk-radios__input" id="v-team" name="visibility" type="radio" value="team" checked>
                       <label class="govuk-radios__label" for="v-team">My team</label>
                     </div>
                     <div class="govuk-radios__item">
                       <input class="govuk-radios__input" id="v-dir" name="visibility" type="radio" value="directorate">
                       <label class="govuk-radios__label" for="v-dir">My cluster</label>
                     </div>
                     <div class="govuk-radios__item">
                       <input class="govuk-radios__input" id="v-all" name="visibility" type="radio" value="all">
                       <label class="govuk-radios__label" for="v-all">All staff</label>
                     </div>
                   </div>
                 </fieldset>
               </div>
               <button class="govuk-button govuk-!-margin-bottom-0" type="submit">Test and publish</button>
               <details class="govuk-details"><summary>Publish with acknowledged findings instead</summary>
                 <p class="govuk-body-s">Advisory policy: failed, missing or blocked assurance stays visible. This does not mark any gate as passed and does not start a new billable scan.</p>
                 <label class="govuk-label"><input type="checkbox" name="acknowledge" value="yes"> I have reviewed the assurance table and accept the outstanding findings for this version and audience.</label>
                 <button class="govuk-button govuk-button--secondary" name="publishMode" value="acknowledge">Publish with acknowledgement</button>
               </details>
             </form>
             <p class="govuk-body-s" style="margin-top:12px;margin-bottom:0">
               Test and publish authorizes a billable sandbox red-team assessment and publishes only on passing evidence. Alternatively, explicitly acknowledge outstanding findings above. Changed versions must be reviewed again.
             </p>`
      }
    </div>

    <div class="cortex-filters">
      <h2 class="govuk-heading-m">How it reaches its tools</h2>
      ${
        (a.connections || []).length
          ? `<p class="govuk-body-s">Each API Management tool has a Foundry project connection carrying the gateway key:</p>
             <ul class="govuk-list govuk-body-s">${a.connections.map((c) => `<li>${esc(c.entry)} <span class="cortex-src">${esc(c.connection)}</span></li>`).join('')}</ul>`
          : '<p class="govuk-body-s">No API Management tools attached, or this agent was built before tool connections existed.</p>'
      }
      ${
        a.grounding
          ? `<p class="govuk-body-s govuk-!-margin-bottom-1"><strong>Data it can query:</strong> ${
              a.grounding.grounded?.length
                ? a.grounding.grounded.map((g) => `${esc(g.entry)} <span class="cortex-src">${esc(g.documents)} rows indexed</span>`).join(', ')
                : 'none — no index yet'
            }</p>
            ${a.grounding.describedOnly?.length ? `<p class="govuk-body-s"><strong>Described only:</strong> ${a.grounding.describedOnly.map(esc).join(', ')} <span class="cortex-src">build the index from the data product page, then rebuild here</span></p>` : ''}`
          : ''
      }
      ${(a.warnings || []).length ? `<p class="govuk-body-s" style="color:#d4351c">${a.warnings.map(esc).join('<br>')}</p>` : ''}
      <form method="post" action="/agent/${attr(entry.id)}/rebuild">
        <button class="govuk-button govuk-button--secondary govuk-!-margin-bottom-1" type="submit">Rebuild tools</button>
      </form>
      <p class="govuk-body-s govuk-!-margin-bottom-0">Makes a new version in Foundry with fresh connections and any indexes built since. Fixes "could not sign in to one of its tools".</p>
    </div>

    <p class="govuk-body-s"><a class="govuk-link" href="/build">Build another</a></p>
  </div>
</div>`;

  return layout({ ...ctx, title: entry.name, section: 'build' }, content);
}

/** The publish result — the steps ARE the demo, so show them. */
export function publishResultPage(ctx, { entry, steps, mcpUrl, openApiUrl }) {
  const content = `
<div class="govuk-panel">
  <h1 class="govuk-panel__title">Published</h1>
  <div class="govuk-panel__body">${esc(entry.name)} is now a part others can build with</div>
</div>

<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h2 class="govuk-heading-m">What Cortex just did</h2>
    <ol class="govuk-list govuk-list--spaced" style="counter-reset:s">
      ${steps
        .map(
          (s, i) => `<li>
            <strong>${i + 1}. ${esc(s.label)}</strong>
            <span class="cortex-src">${esc(s.detail)}</span>
          </li>`
        )
        .join('')}
    </ol>

    <div class="govuk-inset-text">
      <p class="govuk-body govuk-!-margin-bottom-0">
        There is no first-party way to expose a Foundry agent as an MCP server —
        Foundry's own registration path produces an HTTP or A2A API instead.
        Those four steps are the piece Cortex adds.
      </p>
    </div>

    <h2 class="govuk-heading-m">Call it as an MCP server</h2>
    <code style="font-size:15px;word-break:break-all;display:block;background:#f3f2f1;padding:12px">${esc(mcpUrl)}</code>
    <p class="govuk-body-s">
      Any MCP client can use this: a Foundry agent, Copilot Studio, VS Code, or code.
    </p>

    <h2 class="govuk-heading-m">Or as a REST API</h2>
    <code style="font-size:15px;word-break:break-all;display:block;background:#f3f2f1;padding:12px">${esc(openApiUrl)}</code>

    <hr class="govuk-section-break govuk-section-break--visible govuk-section-break--l">

    <p class="govuk-body-l">
      Every agent anyone builds becomes a part everyone else can build with.
    </p>
    <a class="govuk-button" href="/cortex?cat=Agent" role="button">
      See it in Cortex
    </a>
    <p class="govuk-body">
      <a class="govuk-link" href="/agent/${attr(entry.id)}">Back to the agent</a>
    </p>
  </div>
</div>`;

  return layout({ ...ctx, title: 'Published', section: 'build' }, content);
}
