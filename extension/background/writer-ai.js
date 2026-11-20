// background/writer-ai.js — AI writing with the user's own key.
import { truncate, hardFit, stripQuotes } from '../shared/text.js';
import { UserError } from '../shared/errors.js';

export const SYSTEM_PROMPT = `You write LinkedIn outreach that real people reply to.
Rules:
- Lead with ONE specific detail from the hooks provided. Never invent facts about either person.
- No flattery clichés ("I came across your impressive profile", "I was blown away", "I hope this finds you well").
- One clear, low-effort ask that matches the purpose.
- Sound like a person typing, not a template. Short sentences. No emojis unless the tone is Casual, and at most one.
- Respect the hard character limit, counting every character including line breaks.
- Return only the message text — no preamble, no quotes, no subject line.`;

async function enforceLimit(client, apiKey, text, limit) {
  text = stripQuotes(text);
  if (text.length > limit) {
    const shorter = await client.call(apiKey, {
      system: SYSTEM_PROMPT,
      content: `Shorten this to under ${limit} characters, keeping the specific detail and the ask. Return only the message.\n\n${text}`,
      maxTokens: 300
    });
    text = stripQuotes(shorter);
  }
  return text.length > limit ? hardFit(text, limit) : text;
}

export async function aiMessage(client, apiKey, { p, me, hooks, messageType, tone, fmt, previousMessage }) {
  const recipient = {
    name: p.name, headline: p.headline, title: p.currentTitle, company: p.currentCompany,
    location: p.location, about: truncate(p.about, 400), recentPosts: p.recentPosts.slice(0, 2)
  };
  const sender = { name: me.name || null, about: me.bio || null };
  const hookLines = hooks.length
    ? hooks.map(h => `- ${h.label}${h.kind?.startsWith('shared') ? ' (common ground)' : ''}`).join('\n')
    : '- (none selected — use the most specific thing in the recipient profile)';

  const content =
`Write a LinkedIn ${fmt.label}.
Hard limit: ${fmt.limit} characters. Aim for ${Math.round(fmt.limit * 0.85)} or fewer.
Purpose: ${messageType}. Tone: ${tone}.

Build the message around these hooks:
${hookLines}

Recipient: ${JSON.stringify(recipient)}
Sender: ${JSON.stringify(sender)}${previousMessage ? `

The previous draft is below. Write a clearly different version (different opening and wording):
"""${truncate(previousMessage, 800)}"""` : ''}`;

  const text = await client.call(apiKey, { system: SYSTEM_PROMPT, content, maxTokens: 400 });
  return enforceLimit(client, apiKey, text, fmt.limit);
}

export async function aiFollowUp(client, apiKey, { contact, me, tone, limit }) {
  const content =
`Write a short LinkedIn follow-up (follow-up #${(contact.followUps || 0) + 1}) to someone who hasn't replied.
Hard limit: ${limit} characters. Tone: ${tone}. Purpose of the original message: ${contact.purpose}.
Rules: reference the original note briefly, don't guilt-trip, keep one easy ask${(contact.followUps || 0) >= 1 ? ', and offer a polite way out since this is not the first follow-up' : ''}.

Recipient: ${JSON.stringify({ name: contact.name, headline: contact.headline, company: contact.company })}
Sender: ${JSON.stringify({ name: me.name || null })}
Original message:
"""${truncate(contact.message, 800)}"""`;
  const text = await client.call(apiKey, { system: SYSTEM_PROMPT, content, maxTokens: 300 });
  return enforceLimit(client, apiKey, text, limit);
}

export async function aiResumeFacts(client, apiKey, base64) {
  const raw = await client.call(apiKey, {
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text:
`Extract facts from this resume as JSON only, no prose:
{"summary": "<one first-person sentence, max 20 words, e.g. I'm a product engineer building AI tools>",
 "companies": ["<employers>"], "schools": ["<universities/colleges>"],
 "skills": ["<up to 10 skills>"], "location": "<city, country or empty>"}` }
    ],
    maxTokens: 500
  });
  const m = String(raw).match(/\{[\s\S]*\}/);
  let json;
  try { json = JSON.parse(m ? m[0] : ''); } catch { json = null; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new UserError("Couldn't read the resume. Try typing your background instead.", 'resume_unreadable');
  const arr = (x, n) => (Array.isArray(x) ? x.map(v => String(v).trim()).filter(Boolean).slice(0, n) : []);
  return {
    summary: String(json.summary || '').trim().slice(0, 160),
    companies: arr(json.companies, 10),
    schools: arr(json.schools, 5),
    skills: arr(json.skills, 10),
    location: String(json.location || '').split(',')[0].trim()
  };
}
