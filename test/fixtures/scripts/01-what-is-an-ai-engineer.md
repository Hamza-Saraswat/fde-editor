# What Is an AI Engineer? (It's Actually Two Different Jobs)

**Video 1** · target runtime ~9:30 · ~1,350 spoken words · talking head, straight to camera

**Format:** Frame yourself on the left or right third so graphics have open space on the other side. Lines under **SAY** are spoken. Lines starting `GFX` (HyperFrames motion graphics) or `B-ROLL` (screenshots) are edit cues only, so strip them before loading the teleprompter. `[CONFIRM]` marks a line about you to check before recording. `[VERIFY]` marks a fact to re-check on the day you record.

**Title options**
1. What Is an AI Engineer? (It's Actually Two Different Jobs) ← recommended, because it leads with the phrase people search
2. "AI Engineer" Is Two Jobs With One Title
3. AI Engineer vs. Forward Deployed Engineer: What Job Posts Really Want

**Thumbnail:** two job cards side by side, both titled "AI ENGINEER", one tinted blue and one orange. Text: **TWO JOBS. ONE TITLE.**

---

## Cold open (0:00–0:40)

**SAY**

Search "AI engineer" on LinkedIn right now, and you'll find two completely different jobs using the same title.

One wants a developer who uses AI to write code faster. The other wants someone who can walk into a company, figure out where AI actually helps, and build it.

Same title. Different job. And if you're trying to break into this field, chasing the wrong one is a great way to waste six months.

> GFX: two job cards slide in side by side, both titled "AI Engineer." Card A highlights *Copilot · Claude · Node.js*. Card B highlights *RAG · agents · cross-functional*.

**SAY**

So in this video: what an AI engineer actually is, the two kinds of job postings you'll run into, the skills you need for each, the mindset that matters more than any of them, and how to start building without spending a fortune.

I'm Hamza. I build production AI systems for internal teams at a software company. Let's get into it. `[CONFIRM: intro line]`

---

## 1. What an AI engineer is (0:40–2:00)

**SAY**

The simple version first. An AI engineer builds software on top of AI models that somebody else trained.

You're not training GPT or Claude. That's machine learning research, and it's a different job with a different path. An AI engineer takes a model through an API and turns it into something that does real work. A bot that answers questions from your company's docs. An agent that sorts a support inbox. A workflow that reads invoices and flags the weird ones.

> GFX: three-layer stack builds bottom-up. Bottom: **The model** (trained by OpenAI, Anthropic, Google…). Middle, highlighted: **The AI engineer builds here.** Top: **The product people actually use.**

**SAY**

The term really took off in 2023, when swyx wrote an essay called "The Rise of the AI Engineer." His point was that the models had turned into an API call. You didn't need a research background to build with them anymore, and a new kind of engineer was showing up to do exactly that.

> GFX: card with the essay title and "swyx · Latent Space · 2023" `[VERIFY: latent.space/p/ai-engineer]`

**SAY**

That's the clean definition. Now go read the actual job postings, and it gets messy.

---

## 2. The two job postings (2:00–4:50)

**SAY**

I've been reading a lot of these postings, and getting a lot of recruiter messages, and almost every one lands in one of two buckets.

### Type 1: the AI-powered developer

**SAY**

The first type is a software engineer who uses AI to build. The job is shipping product code: front end, back end, full stack. The "AI" part is that they expect you to work with tools like Claude Code, Codex, or Cursor, and move a lot faster because of it.

Here's a real one a recruiter sent me. "Developing enterprise custom applications using AI-assisted development tools." "Demonstrated experience using AI coding assistants, like GitHub Copilot, Claude, or Cursor, in a professional development environment." And then a pretty normal software stack: JavaScript, TypeScript, Node, SQL.

> B-ROLL: the Mid-Level AI Developer posting pops in on the open side. Highlight "AI-assisted development tools," "AI coding assistants," and the stack bullets. Crop out the header with location, contract length, and interview format.

**SAY**

Here, AI is the tool, not the product. It's a developer job with a power tool attached.

But look at the last line of that same posting: "hands-on experience building agentic agents, including tool use and function calling." Even the developer job wants a little bit of the other kind. That's how muddled this gets.

> B-ROLL: same posting, scroll to the last bullet and highlight it.

### Type 2: the applied AI engineer

**SAY**

The second type is a different animal. These postings want you to build AI *into* the business.

Here's one from that side: "designing, building, and productionizing AI agents, copilots, and generative applications." Then RAG pipelines and vector databases. RAG just means giving a model your company's data so it answers from that instead of guessing. Then evaluation, guardrails, tool calling, observability.

And then comes the part that tells you it's a different job: "cross-functional collaboration," "documentation and runbooks," "taking AI concepts from ideation to production."

> B-ROLL: the applied AI posting. Highlight "productionizing AI agents," "RAG," "evaluation," "guardrails," "cross-functional collaboration," and "ideation to production." **Crop or blur the "Property Tech… 24 million rental units" line, because it identifies the company.** Then 1–2 recruiter messages with recruiter, client, and company names blurred.

**SAY**

This is the one I always pictured when I heard "forward deployed engineer." The term comes from Palantir. They sent engineers to work inside a customer's organization and make the software actually work there. Now OpenAI, Anthropic, and a ton of startups hire forward deployed engineers to do the same thing with AI. Go into a company, learn how the work really gets done, and build the system that fits.

> GFX: definition card. **Forward Deployed Engineer:** "An engineer who works inside the customer's world to make the product actually work there." Small tag: *term coined at Palantir.*

> GFX (OPTIONAL) `[VERIFY before using]`: "FDE job postings on Indeed: 643 (Apr 2025) → 5,330 (Apr 2026)." Source line: Indeed data via Business Insider.

**SAY**

It sits right where business meets AI. Half the job is engineering. The other half is understanding the problem well enough that what you build actually gets used.

And it's the closest description of what I do day to day. We work with teams across the company, find the work that eats up their week, and build AI systems for it. `[CONFIRM]`

### How to tell them apart

**SAY**

So when you're reading a posting, ask one question: is AI the tool, or is AI the thing you're building?

If AI is the tool, it's type one. You're a developer who builds *with* AI.

If AI is the thing you're building, it's type two. You're building AI *into* something.

> GFX: decision card. **"Is AI the tool or the product?"** → Tool: *AI-powered developer*. Product: *Applied AI engineer / FDE*.

**SAY**

Plenty of postings blend the two, and neither one is better. But they want different skills, and you should know which one you're applying to.

---

## 3. The skills (4:50–6:50)

**SAY**

So what do you actually need? I'm going to keep this simple. Three layers.

> GFX: a checklist builds layer by layer as you talk. It stays on screen through this section.

**SAY**

Layer one is for both jobs: the building basics.

Pick one language and get comfortable in it. Python or TypeScript. Learn how APIs work, because everything in this field talks over an API. Learn Git. And get good with an AI coding tool, and that includes reading and checking what it writes, not just hitting accept.

Layer two is the AI systems layer. This is what the second type of job adds.

Know what a model can and can't do: prompts, context windows, tool calling, what things cost. Learn RAG. Learn the difference between a workflow and an agent. I wrote a plain-English cheat sheet on that, and it's linked below. And learn evals and guardrails. Evals are how you prove the thing works before you hand it to people. Guardrails are the rules that stop it from doing something it shouldn't.

> GFX: when you say "cheat sheet," show the article card: *Agents, Workflows, and Harnesses: A Plain-English Cheat Sheet.*

**SAY**

Quick note on frameworks. Job posts will list a pile of them. Learn the concepts, not the logos. I build mostly with plain SDK calls and MCP, and the ideas carry over to whatever framework a company uses. `[CONFIRM: keep or cut]`

Layer three is the people layer, and it's the most underrated. Can you sit with a team, figure out what problem they actually have, explain the tradeoffs in plain English, and show them a demo they understand? Can you write it down so somebody else can run it? That posting literally asked for documentation and runbooks. For forward deployed work, this is half the job.

---

## 4. The mindset shift (6:50–8:10)

**SAY**

Now the part I care about the most. You have to get past the theory.

You can watch tutorials for a year and still have nothing to show for it. Meanwhile, the barrier to building has never been lower. With the coding tools we have now, one person can build in a weekend what used to take a small team weeks.

So build. And don't stop at toy projects. Build things somebody actually uses. A project is something you made. A product is something someone uses. `[CONFIRM: this is my read of your "projects are products" point]`

Build a bot that answers questions from your team's docs. Build a workflow that cleans up the inbox you dread every Monday. Put it in front of a real person, watch where it breaks, fix it, and ship it again.

> GFX: three example project cards pop in one at a time: *Docs Q&A bot* · *Inbox cleanup workflow* · *An agent that watches something you check by hand.*

**SAY**

That loop is the job. Every posting I just showed you is really asking one thing: can you take a messy, real-world problem and ship something that works? The best way to prove it is to have already done it.

---

## 5. You don't need a $200 plan (8:10–9:05)

**SAY**

And it doesn't have to cost a lot. You do not need to spend a hundred or two hundred dollars a month on a Claude Code plan, or a hundred a month on Codex, to get started.

> GFX: price ladder, cheapest at the bottom. Small footer: *Prices as of Oct 2026. Check before you buy.* `[VERIFY all on record day]`
> - **OpenCode Go:** ~$10/mo · open models (GLM, Kimi, Qwen…)
> - **Z.ai GLM Coding Plan:** Lite ~$18/mo · GLM-5.3
> - **ChatGPT Plus** (includes Codex): $20/mo
> - **Claude Pro** (includes Claude Code): $20/mo
> - **$100–$200 tiers:** later, once you're hitting limits every day

**SAY**

Z.ai has a coding plan running GLM 5.3 for under twenty bucks a month, and it gives you a decent amount of usage. OpenCode is open source, and it has its own plans that let you use a whole bunch of different models.

And if you just want to get your feet wet, the twenty-dollar ChatGPT plan with Codex is decent. But honestly, there are better deals out there, and I'm putting together a full breakdown.

---

## 6. Resources + close (9:05–9:40)

**SAY**

Everything I mentioned is in the description. The cheat sheet on agents, workflows, and harnesses. A plain-English explainer on RAG. And the breakdown of cheaper coding plans. `[the RAG and coding-plan pieces have to be live by publish day, or change this to "coming soon"]`

> GFX: three resource cards stack up on the open side.

**SAY**

So, quick recap. An AI engineer builds on top of models. The title covers two jobs: building *with* AI, and building AI *into* things. Learn the basics, learn the systems, learn the people part. And ship something real.

Tell me in the comments which of the two you're going after.

Next week, I'm breaking down workflows versus agents, because it's the most mixed-up idea in this whole field. I'll see you there.

> GFX: end card with a subscribe prompt and the next-video slot.

---

## Description (draft)

Search "AI engineer" and you'll find two different jobs using the same title. In this video I break down what an AI engineer actually is, the two kinds of job postings you'll see (AI-powered developer vs. applied AI / forward deployed engineer), the skills for each, and how to start building without a $200/month plan.

📖 Companion article: [Substack link]
📄 Agents, Workflows, and Harnesses, a plain-English cheat sheet: https://hamzasaraswat.substack.com/p/agents-workflows-and-harnesses-a
📄 RAG in plain English: [link when live]
💸 Cheaper AI coding plans: [link when live]
🔗 swyx, "The Rise of the AI Engineer": https://www.latent.space/p/ai-engineer

Chapters *(update after the edit)*
0:00 Two jobs, one title
0:40 What an AI engineer is
2:00 The two job postings
4:50 The skills
6:50 Get past the theory
8:10 You don't need a $200 plan
9:05 Resources

---

## Before you record

**Assets to gather**
- The two postings you sent: the Mid-Level AI Developer posting (type 1) and the Property Tech applied AI posting (type 2). Crop the identifying lines from both. You're in live processes for both roles, so the companies shouldn't be identifiable on a public video.
- 1–2 more postings per type if you want extra B-roll
- 1–2 recruiter messages, with recruiter, client, and company names blurred
- Screenshots of the pricing pages, taken on record day.

**HyperFrames comps (8):** two-card open · model/engineer/product stack · essay card · FDE definition card · decision card · skills checklist · price ladder · resources + end card

**Fact-check list**
- OpenCode Go price and model list (opencode.ai): was $10/mo with a $5 first month as of Sept 2026; the lineup changes often
- Z.ai Lite price and current model (z.ai/subscribe): sources listed $18/mo monthly, and the tiers have changed more than once
- ChatGPT Pro tier: some sources show a $100 tier and others only $200. This matters for the "$100 a month on Codex" line
- Optional Indeed stat: trace it to the Business Insider piece before you use it
- Anthropic and OpenAI both currently list FDE roles (check their careers pages)
