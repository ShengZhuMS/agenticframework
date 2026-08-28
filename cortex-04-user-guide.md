# Cortex — User guide

**Cortex is one place to find what Defra already has, build something with it, and share what you build.**

> **This is an alpha service running against real systems.** Everything you see comes from Microsoft Purview, API Management and Foundry. What you publish is genuinely published. The estate shown is a thin slice of Defra, not the whole department — but it is a real slice, not a sample.

---

## Contents

1. [What Cortex is for](#1-what-cortex-is-for)
2. [Finding what exists](#2-finding-what-exists)
3. [Reading an entry](#3-reading-an-entry)
4. [Understanding what you can and cannot see](#4-understanding-what-you-can-and-cannot-see)
5. [Asking for access](#5-asking-for-access)
6. [Asking a question](#6-asking-a-question)
7. [Building an agent](#7-building-an-agent)
8. [Publishing what you build](#8-publishing-what-you-build)
9. [Sharing your team's data](#9-sharing-your-teams-data)
10. [Glossary](#10-glossary)
11. [Getting help](#11-getting-help)

---

## 1. What Cortex is for

Defra holds a great deal of data and has built a great many agents. Almost none of it is findable by anyone outside the team that made it. If you want to know whether something already exists, you ask around.

Cortex is the front door. It shows you what exists, tells you honestly whether you can use it, and lets you build with the parts you are allowed to use — without copying anything, and without anyone's access rights changing.

**Three things to understand before you start:**

- **Nothing is copied.** Cortex connects to data where it lives. There is no upload, and there is no file picker. Your data stays in your system, under your control.
- **Your access does not change.** Cortex never shows you data you could not already see, and an agent you build can never reach further than you can.
- **Everything you build becomes a part someone else can build with.** That is the point.

---

## 2. Finding what exists

Cortex opens on the **Marketplace**, not on an empty search box. You start by seeing what is there.

### The four categories

| Category | What it is | Example |
|---|---|---|
| **Data** | A connected source you can read or ask questions of | Water quality archive |
| **Skill** | A single, callable thing that does one job | Permit history lookup |
| **Agent** | An assistant someone has built and shared | Incident triage assistant |
| **App** | An existing application registered so you can find it | Catchment Data Explorer |

### Searching and filtering

- The **search box in the black bar** works from every page. It matches names, descriptions, owning teams and clusters.
- **Category checkboxes** narrow to any combination of Data, Skills, Agents and Apps.
- **Cluster filters** narrow to a subject area — water, land, farming, animal and plant health, waste, marine, air quality, flood, or corporate.
- **Sort** by any column: name, owner, freshness, use.

The result count tells you how many entries match what is registered. How much of Defra's estate is not yet registered is genuinely unknown — Cortex counts what it can see rather than estimating what it cannot.

### The map view

**Switch to Map** to see the estate as nine clusters, sized by how much each contains, with lines showing dependencies between them. Underneath is a count of **cross-cluster dependencies**.

That count is the honest test of whether Defra is joining up. One number, tracked over time. If it goes up, the department is connecting. If it stays flat, it is not.

---

## 3. Reading an entry

Every entry page shows the same standard set of fields, so you can compare two things fairly.

**The left column** is written to be read: what this is, what it is for, and what you should be careful about.

**The table on the right** is the entry standard:

| Field | What it tells you |
|---|---|
| **Owner** | The team accountable. If it says *proposed*, nobody has confirmed it yet — see [Claiming an entry](#claiming-an-entry). |
| **Freshness** | How current it is: 15 minutes, hourly, daily, monthly. |
| **Sensitivity** | Official, or Official–Sensitive. |
| **Access** | Who can reach it, in plain words. |
| **Licence** | The licence model **and who it covers** — a licence that does not cover contractors says so here. |
| **Known limitations** | What this data will mislead you about if you are not careful. Read this one. |
| **Lineage and dependencies** | What it is built from. Where a dependency is itself registered, the name is a link — follow it. |
| **Minimum aggregation** | Where an entry can only be answered at a grouped level, the smallest grouping allowed. |
| **Use and health** | Calls, error rate and latency over 90 days, measured by the gateway. An entry with no traffic says so rather than showing a zero. |

**Every row shows where the field came from and who maintains it** — an agent or a person. A field an agent derived and no human has checked says so. You can judge how much to trust it.

### Known limitations — why this field matters

The most useful field on the page is the one that tells you what the data cannot do. *"Sampling is not uniform in space or time. Absence of a result is not evidence of absence of a pollutant."* That sentence prevents a wrong conclusion.

### Claiming an entry

Some entries have an owner that was **proposed by an agent** from resource tags, and never confirmed by a person. These show a **Claim this entry** control. If it belongs to your team, claim it. It takes ten seconds and it makes the register trustworthy.

### Reporting a correction

**Report a correction** on any entry. It goes to the owner, not to Cortex. If the entry has no confirmed owner, you will be told that, and where it goes instead.

---

## 4. Understanding what you can and cannot see

Every entry carries one of six states. They are shown as a **shape and a label** — never colour alone — so they work in black and white and with a screen reader.

| State | What it means | What to do |
|---|---|---|
| **Available** | You can use it now. | Use it now |
| **Available to you, needs a request** | You are eligible, but you must ask. | Request access |
| **Licence does not cover you** | The data exists and you may be eligible, but the commercial licence does not include your role. | Commercial question — Cortex tells you who to ask |
| **Sensitivity precludes you** | There is no route to this in your current role. | Nothing. Cortex tells you plainly rather than letting you waste time. |
| **Not yet registered for use** | Connected, but no clearance decision has been made. | Wait, or ask the AI Unit |
| **Answerable by a person** | You cannot have the data, but someone who holds it can give you an answer from it. | Request an answer |

### That last one is the important one

**"Answerable by a person"** covers the most common situation in Defra and the one that costs the most time: *you are allowed the answer, but not the data behind it.*

A manager is entitled to know average days sick per employee. They are not entitled to individual sickness records. Their agent inherits their access, so it cannot reach the records either — and today that means an email, a spreadsheet, and a week.

Cortex shows this as a state rather than a dead end, and routes you to the person who can answer. *(The full request workflow is coming in a later phase.)*

---

## 5. Asking for access

On an entry marked **Available to you, needs a request**, select **Request access**.

You will be asked:
- **What you need it for.** Write plainly. The owner uses this to judge what to release.
- **Once, or on a repeating basis.**

You then get a reference and an indication of when to expect a decision. Track it under **Your things**.

The owner sees your request alongside every other request for their data, in one place, with your purpose and how long you have waited.

> **Why Cortex handles this rather than the Purview portal:** so that requests for data, for skills and for agents all arrive in one queue, in one format, whatever the underlying system. One place to ask.

---

## 6. Asking a question

**Ask a question** lets you type in ordinary language and get an answer from the data you are allowed to reach.

Ask it the way you would ask a colleague. *"How many waste carrier registrations lapsed in the North East last year?"* is a good question. You do not need to know which system holds the answer.

### Every answer shows its working

Below each answer is a **provenance panel**:

- **The sources used**, and what was taken from each.
- **How fresh each source was** at the time of asking.
- **A confidence level.**
- **What it could not reach** — and this is the part to read. An answer built from three of five relevant sources is a different answer, and Cortex says so rather than quietly giving you a number.

You can **follow any claim back to the entry it came from**.

### When nothing was found

You get the working, not a blank. Cortex tells you what it looked in, what it could not reach and why, and — where one exists — offers you a person who could answer instead.

### Carrying on

Follow-ups stay in the same thread and keep their context. Previous conversations are listed down the left, grouped into Today, Yesterday and Earlier.

---

## 7. Building an agent

**Build an agent** assembles an assistant from parts that are already approved. You do not write code.

### Search before you build

Before the form, Cortex tells you roughly how many agents already exist and invites you to search the Marketplace first. Most of them have never been examined by anyone outside the team that built them. **Check whether yours already exists.** It often does.

### The form

1. **Name it.** Say what it does, not what it is called internally.
2. **Choose a model** from the approved catalogue. First-party general, first-party small and fast, or a third-party model marked as needing review.
3. **Write instructions.** Tell it how to behave. Good instructions say: *name your sources and their freshness, say what you could not reach, and do not guess.*
4. **Attach knowledge.** A checklist of sources.
5. **Tick what it may do.**

### Attach only knowledge you can already see

The knowledge checklist shows **everything relevant** — but anything you cannot see yourself is **greyed out, disabled, and labelled with the reason**.

This is deliberate. An agent you build can never reach further than you can. You will never accidentally build something that leaks. If you need one of the greyed-out sources, request access to it first, and it becomes available here once granted.

### What it may do

Four permitted actions. In this phase:

| Action | Available |
|---|---|
| Read registered sources | ✅ Ticked |
| Summarise and cite | ✅ Ticked |
| Write to a source system | ❌ Not this phase |
| Send externally | ❌ Not this phase |

The unavailable ones are shown, greyed out, so you know they are coming and are not left wondering.

### Assurance gates

Before you share it, check **which gates apply and why**. Seven gates:

| Gate | Typical status |
|---|---|
| Data protection impact assessment | Not required, if there is no personal data |
| Security review of the gateway registration | Complete, per registration, by the AI Unit |
| Responsible AI review | Required if the agent summarises for a decision |
| Model catalogue approval | Complete for first-party approved models |
| Red team report | Indirect injection through retrieved content is the live risk |
| Accessibility to WCAG 2.2 AA | A legal obligation, not a nice-to-have |
| Service assessment | Not applicable for internal, staff-only tools |

Each gate says **why it applies to your agent specifically**. Gates that are complete, not required, or not applicable show a dash. Gates that are outstanding carry a button through to the evidence.

### Test it

Create it, then ask it something real. It answers with its sources and freshness. If the answer is wrong, change the instructions and try again — nothing is shared until you share it.

---

## 8. Publishing what you build

This is what makes Cortex different from building an agent anywhere else.

When your agent works, select **Publish**. Choose how others may use it:

- **As an agent** — other people can use it through Cortex.
- **As an MCP server** — other *agents* and developers can call it as a tool, from Foundry, from Copilot Studio, or from their own code.
- **As an API** — conventional REST, for systems that do not speak MCP.

You declare **what it reads and what it may do**, and choose who can call it — your team, a directorate, or all staff.

### Then it appears in the Marketplace

Your agent becomes an entry like any other, with its own page, its own entry standard, its own usage figures, and its own visibility state. Someone in another cluster can find it, see what it reads, check its gates, and build something on top of it.

**That is the whole idea.** Every agent anyone builds becomes a part everyone else can build with. An agent that answers permit questions becomes a tool inside someone else's waste crime assistant, which becomes a tool inside someone else's regional briefing agent. The estate compounds instead of sprawling.

---

## 9. Sharing your team's data

**Share your data** is where you connect a source your team owns.

### There is no file picker, and that is deliberate

You are not uploading. **Nothing is copied and nothing moves.** You are registering a connection to data where it already lives, so that it can be found and — where you allow it — read in place. Your team stays in control, the data stays current, and there is no second copy to go stale or leak.

### Connecting a source

A short form: the source system, the object or endpoint, and the owning team. Submitting it raises a **gateway registration request**, reviewed by the AI Unit and the Cloud Centre of Excellence.

You will be told where you are in the queue and the median time to a decision. Every connection currently gets the same review — there is no fast lane yet.

### Confirming what is already yours

Some entries have been proposed as belonging to your team, from resource tags, and never confirmed. They appear in a block on your Share tab. **Confirm** the ones that are yours; mark the ones that are not.

### Handling requests for your data

Everyone asking for access to your team's entries appears in **one table**: who they are, what they want it for, how long they have waited. Approve, decline with a reason, or route it to someone who actually holds it.

### Seeing how your data is used

- What you share, how fresh it is, and how many teams call it.
- **What is called most**, measured by the gateway rather than estimated.
- **What is registered and never called** — candidates for retirement.
- What other teams have automated on top of your data.

---

## 10. Glossary

| Term | Meaning |
|---|---|
| **Agent** | An assistant built from a model, instructions, knowledge and permitted actions. |
| **Cluster** | A subject area. Cortex has nine, each with an owning team. |
| **Data product** | A registered, described, owned unit of data with a defined standard of description. |
| **Entry** | Anything in the Marketplace — data, skill, agent or app. |
| **Entry standard** | The mandatory set of fields every entry must carry. |
| **Gateway** | The route through which sources are connected and reviewed. Nothing reaches Cortex without passing it. |
| **Lineage** | What a thing is built from, and what is built from it. |
| **MCP** | Model Context Protocol. The standard way an agent calls a tool. Publishing as MCP means other agents can use what you built. |
| **Minimum aggregation** | The smallest grouping at which an entry may be answered — e.g. by directorate, never by person. |
| **Provenance** | Where an answer or a field came from, and who maintains it. |
| **Responder** | Whoever can reach the data this time, and answers from it. |
| **Visibility state** | One of six states describing whether you can use an entry, and what to do about it. |

---

## 11. Why can I not see something?

Your access comes from your Microsoft Entra group membership. Cortex grants nothing on its own — it shows you what your groups already entitle you to, and tells you what to do about the rest.

Open **What can I see?** in the bar at the top of any page. It lists your groups, your clearance, and how many entries fall into each of the six states. If it says you are in no named groups, that is why the Marketplace looks sparse, and it is a configuration matter for the Cortex team rather than something you can fix.

If an entry says **Available to you, needs a request**, ask for it — that is the intended route, and the owner sees your reason alongside every other request they have.

---

## 12. Getting help

- **Help** in the top navigation covers what Cortex can and cannot do today.
- **Was this page useful?** at the bottom of every page — it is recorded and read.
- For access to a specific entry, contact the **owner named on the entry**, not Cortex.
- For gateway registrations and clearance decisions, contact the **AI Unit and the Cloud Centre of Excellence**.

### What Cortex cannot do yet

Honesty about the boundary saves you time:

- It cannot write to a source system, and no agent built in it can.
- It cannot send anything outside Defra.
- It does not hold data. If an entry is not connected, Cortex cannot reach it.
- It cannot give you data your role does not permit — but it will tell you when a person can answer instead.
- The estate shown is a **thin slice**, deliberately. The coverage screen shows how much of the believed estate is registered.
