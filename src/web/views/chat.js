/**
 * The chat window — one agent, one conversation, opened in its own window.
 *
 * Server-rendered and JavaScript-free, like every other page: each turn is a
 * form POST, the page reloads and the browser is sent to the newest answer
 * with a fragment link. That keeps the window working with scripting off and
 * keeps the whole conversation readable, printable and bookmarkable.
 */

import { esc, attr, layout } from '../layout.js';
import { UI_REVISION, evidenceFingerprint } from '../../bff/services/evidence.js';

function toolList(calls) {
  if (!calls?.length) return '';
  const rows = calls
    .filter((c) => c.kind !== 'list')
    .map(
      (c) => `<li>
        <strong>${esc(c.server || 'tool')}</strong>${c.tool ? ` › ${esc(c.tool)}` : ''}
        ${c.arguments && c.arguments !== '{}' ? `<span class="cortex-src">with ${esc(c.arguments)}</span>` : ''}
        ${c.error ? `<span class="cortex-src" style="color:#d4351c">failed: ${esc(c.error)}</span>` : ''}
      </li>`
    )
    .join('');
  if (!rows) return '';
  return `<details class="govuk-details govuk-!-margin-bottom-2" style="margin-top:8px">
    <summary class="govuk-details__summary"><span class="govuk-details__summary-text">Tools this answer used</span></summary>
    <div class="govuk-details__text"><ul class="govuk-list govuk-list--bullet govuk-!-margin-bottom-0">${rows}</ul></div>
  </details>`;
}

function sourceList(sources) {
  if (!sources?.length) return '';
  return `<p class="govuk-body-s govuk-!-margin-bottom-1"><strong>Sources:</strong> ${sources
    .map((s) => (s.url ? `<a class="govuk-link" href="${attr(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)))
    .join(', ')}</p>`;
}

function turnBlock(t, i, last) {
  const anchor = last ? ' id="latest"' : '';
  return `<div class="cortex-chat__turn"${anchor}>
    <div class="cortex-chat__q">
      <span class="cortex-chat__who">You</span>
      <p class="govuk-body">${esc(t.question)}</p>
    </div>
    <div class="cortex-chat__a">
      <span class="cortex-chat__who">Agent</span>
      ${
        t.error
          ? `<div class="govuk-warning-text govuk-!-margin-bottom-2">
               <span class="govuk-warning-text__icon" aria-hidden="true">!</span>
               <strong class="govuk-warning-text__text"><span class="govuk-visually-hidden">Warning</span>${esc(t.error.heading)}</strong>
             </div>
             <p class="govuk-body-s">${esc(t.error.message)}</p>
             <details class="govuk-details govuk-!-margin-bottom-2"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">Technical detail</span></summary>
               <div class="govuk-details__text"><code style="font-size:13px;word-break:break-all">${esc(t.error.detail)}</code></div></details>`
          : `<p class="govuk-body" style="white-space:pre-wrap">${esc(t.answer?.text || '(no text was returned)')}</p>
             ${sourceList(t.answer?.sources)}
             ${
               t.answer?.couldNotReach?.length
                 ? `<p class="govuk-body-s" style="color:#d4351c"><strong>Could not reach:</strong> ${t.answer.couldNotReach.map(esc).join('; ')}</p>`
                 : ''
             }
             ${toolList(t.answer?.toolCalls)}`
      }
      <span class="cortex-src">${esc(new Date(t.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))} · ${esc(Math.round((t.ms || 0) / 100) / 10)}s${t.answer?.model ? ` · ${esc(t.answer.model)}` : ''}</span>
    </div>
  </div>`;
}

export function chatPage(ctx, { entry, thread, history, permission }) {
  const turns = thread?.turns || [];
  const def = entry._agent?.definition || {};
  const content = `
<div class="cortex-chat">
  ${ctx.query?.audit === '1' ? `<section aria-labelledby="audit-heading"><h2 class="govuk-heading-m" id="audit-heading">Accessibility checks</h2>
    <button type="button" class="govuk-button" data-run-audit data-endpoint="/agent/${attr(entry.id)}/assurance" data-fingerprint="${evidenceFingerprint(entry)}" data-revision="${UI_REVISION}">Run WCAG browser checks</button>
    <p id="audit-status" class="govuk-body" role="status">Checks have not run.</p><a href="/agent/${attr(entry.id)}/assurance#a11y">Return to assurance evidence</a></section>
    <script src="/assets/vendor/axe.min.js" defer></script><script type="module" src="/assets/accessibility.js"></script>` : ''}
  <div class="cortex-chat__head">
    <div>
      <span class="govuk-caption-m">Chat with an agent · built by ${esc(def.builtByTeam || entry.owner)}</span>
      <h1 class="govuk-heading-l govuk-!-margin-bottom-1">${esc(entry.name)}</h1>
      <p class="govuk-body-s govuk-!-margin-bottom-0">${esc(def.instructions ? def.instructions.slice(0, 220) : entry.desc)}</p>
    </div>
    <div class="cortex-chat__side">
      <a class="govuk-link" href="/agent/${attr(entry.id)}/chat">New conversation</a>
      ${
        history?.some((h) => h.id !== thread?.id)
          ? `<details class="govuk-details govuk-!-margin-bottom-0 govuk-!-margin-top-2">
               <summary class="govuk-details__summary"><span class="govuk-details__summary-text">Earlier conversations (${history.length - (thread ? 1 : 0)})</span></summary>
               <div class="govuk-details__text"><ul class="govuk-list govuk-!-margin-bottom-0">
                 ${history
                   .filter((h) => h.id !== thread?.id)
                   .slice(0, 12)
                   .map((h) => `<li><a class="govuk-link" href="/agent/${attr(entry.id)}/chat?thread=${attr(h.id)}">${esc(h.turns[0]?.question || 'Empty conversation')}</a>
                        <span class="cortex-src">${esc(new Date(h.updatedAt).toLocaleString('en-GB'))}</span></li>`)
                   .join('')}
               </ul></div>
             </details>`
          : ''
      }
    </div>
  </div>

  ${
    permission?.policy === 'all-staff'
      ? `<p class="govuk-body-s cortex-chat__policy">Every member of staff can chat with every agent in this phase. Answers are shaped by what the agent was built to read — not by what you can see.</p>`
      : ''
  }

  <div class="cortex-chat__thread">
    ${
      turns.length
        ? turns.map((t, i) => turnBlock(t, i, i === turns.length - 1)).join('')
        : `<div class="govuk-inset-text govuk-!-margin-top-0">
             <p class="govuk-body govuk-!-margin-bottom-1">Ask something the agent was built to answer. It reads:</p>
             <ul class="govuk-list govuk-list--bullet govuk-!-margin-bottom-0">
               ${
                 (def.knowledge || []).length || (def.tools || []).length
                   ? [...(def.knowledge || []), ...(def.tools || [])]
                       .map((id) => ctx.findByName?.(id))
                       .filter(Boolean)
                       .map((k) => `<li>${esc(k.name)} <span class="cortex-src">${esc(k.cat)}</span></li>`)
                       .join('') || '<li>the sources named in its instructions</li>'
                   : '<li>only its own instructions — it has no sources attached</li>'
               }
             </ul>
           </div>`
    }
  </div>

  <form class="cortex-chat__form" method="post" action="/agent/${attr(entry.id)}/chat">
    ${thread ? `<input type="hidden" name="thread" value="${attr(thread.id)}">` : ''}
    <div class="govuk-form-group govuk-!-margin-bottom-2">
      <label class="govuk-label govuk-visually-hidden" for="q">Your message</label>
      <textarea class="govuk-textarea govuk-!-margin-bottom-0" id="q" name="q" rows="3" maxlength="8000" required
        placeholder="${attr(turns.length ? 'Follow up…' : 'Ask a question…')}"></textarea>
    </div>
    <button class="govuk-button govuk-!-margin-bottom-0" type="submit">Send</button>
    <span class="cortex-src" style="margin-left:12px">Your conversation is stored privately for your account in Cortex and the connected agent service. Answers may be incorrect; review before use.</span>
    <p class="govuk-body-s" data-chat-status role="status" aria-live="polite"></p>
  </form>
</div>`;

  return layout({ ...ctx, title: `Chat — ${entry.name}`, section: 'build', compact: true }, content);
}

export function chatRefusedPage(ctx, { entry, reason }) {
  const content = `
<div class="govuk-grid-row"><div class="govuk-grid-column-two-thirds">
  <h1 class="govuk-heading-l">You cannot chat with ${esc(entry.name)}</h1>
  <p class="govuk-body">${esc(reason || 'This agent is not open to you.')}</p>
  <p class="govuk-body"><a class="govuk-link" href="/entry/${attr(entry.id)}">See its Cortex entry</a> to request access.</p>
</div></div>`;
  return layout({ ...ctx, title: 'Chat', section: 'build', compact: true }, content);
}
