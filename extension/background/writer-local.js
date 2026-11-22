// background/writer-local.js — the built-in (free, offline) writer.
// Deterministic for a given `variant`, so tests are stable and "New version" rotates phrasing.
import { truncate, firstSentence, hardFit, aOrAn, ensurePeriod } from '../shared/text.js';

const OPENERS = {
  custom: [v => ensurePeriod(v)],
  sharedCompany: [
    v => `Fellow ${v} alum here — spotted it on your profile.`,
    v => `I noticed we both spent time at ${v}.`,
    v => `Saw we share ${v} on our CVs, which made me want to say hi.`
  ],
  sharedSchool: [
    v => `Fellow ${v} grad here!`,
    v => `Saw we both went to ${v}.`,
    v => `Always nice to find another ${v} alum.`
  ],
  sharedSkill: [
    v => `Looks like we both work with ${v}.`,
    v => `Saw we overlap on ${v}.`
  ],
  sharedLocation: [
    v => `Fellow ${v} local here.`,
    v => `Saw you're in ${v} too.`
  ],
  post: [
    v => `Your recent post — "${v}" — stuck with me.`,
    v => `Enjoyed your recent post: "${v}".`,
    v => `Your post on "${v}" got me thinking.`
  ],
  role: [
    v => `Saw you're ${v.title ? `${aOrAn(v.title)} ${v.title} ` : ''}at ${v.company}.`,
    v => `Your work${v.title ? ` as ${v.title}` : ''} at ${v.company} caught my eye.`,
    v => `Curious about your work${v.title ? ` as ${v.title}` : ''} at ${v.company}.`
  ],
  about: [
    v => `This line from your About section stood out: "${v}".`,
    v => `Liked how you put it in your About: "${v}".`
  ],
  pastCompany: [
    v => `Saw you were at ${v} before your current role.`,
    v => `Your path through ${v} caught my eye.`
  ],
  skill: [
    v => `Your background in ${v} stood out.`,
    v => `Your experience with ${v} caught my eye.`
  ],
  education: [v => `Saw you studied at ${v}.`],
  // Deep Mode web research. Values complete "I saw …" / "I enjoyed …".
  news: [
    v => `I saw ${v}.`,
    v => `Caught ${v} recently.`
  ],
  work: [
    v => `I enjoyed ${v}.`,
    v => `Really enjoyed ${v}.`
  ],
  headline: [v => `Your headline caught my eye: "${truncate(v, 60)}".`]
};

const ASKS = {
  Networking: [
    () => 'Would love to connect.',
    () => 'Happy to connect and swap notes sometime.',
    () => 'Would be great to stay in touch here.'
  ],
  Job: [
    c => `I'm exploring roles${c ? ` at ${c}` : ''} — would you be open to a quick chat about the team?`,
    c => `I'm looking at opportunities${c ? ` at ${c}` : ''} and would value 10 minutes of your perspective.`
  ],
  Referral: [
    c => `I'm applying to a role${c ? ` at ${c}` : ''} — would you be open to a quick look at my profile, and a referral if it seems like a fit?`,
    c => `I'm keen on an opening${c ? ` at ${c}` : ''}. If you're open to it, I'd be grateful for a referral or any pointers.`
  ],
  Collaboration: [
    () => "I think there's an overlap worth exploring — open to a quick chat?",
    () => "I'm working on something close to this and would love to compare notes. Open to a 15-minute call?"
  ]
};

const SHORT_ASKS = {
  Networking: () => 'Would love to connect.',
  Job: c => `Open to a quick chat about roles${c ? ` at ${c}` : ''}?`,
  Referral: c => `Open to referring me${c ? ` at ${c}` : ''} if I'm a fit?`,
  Collaboration: () => 'Open to a quick chat?'
};

const GREET = { Formal: n => `Hello ${n},`, Neutral: n => `Hi ${n},`, Casual: n => `Hey ${n}!` };
const SIGNOFF = { Formal: 'Best regards,', Neutral: 'Best,', Casual: 'Cheers,' };

const pick = (arr, variant, salt) => arr[(variant + salt) % arr.length];

/** The opening sentence for one hook (also used by templates for {hook}). */
export function openerFor(hook, variant = 0, salt = 0) {
  if (!hook) return '';
  const templates = OPENERS[hook.kind] || OPENERS.headline;
  const value = hook.value ?? hook.label;
  if (hook.kind === 'role' && (typeof value !== 'object' || !value.company)) return '';
  return pick(templates, variant, salt)(value);
}

export function greeting(firstName, tone) {
  return (GREET[tone] || GREET.Neutral)(firstName || 'there');
}

/**
 * @param {{p:object, me:{name?:string,bio?:string}, hooks:object[], messageType:string, tone:string, fmt:{limit:number}, variant:number}} args
 */
export function localMessage({ p, me = {}, hooks = [], messageType, tone, fmt, variant = 0 }) {
  const company = p.currentCompany;
  const greet = greeting(p.firstName, tone);
  const signoff = SIGNOFF[tone] || SIGNOFF.Neutral;
  const sign = me.name ? `${signoff}\n${me.name}` : '';

  const openers = hooks.slice(0, 2).map((h, i) => openerFor(h, variant, i * 7)).filter(Boolean);
  if (!openers.length) openers.push(`Came across your profile${company ? ` while looking into ${company}` : ''} and wanted to reach out.`);

  const meLine = me.bio ? `A bit about me: ${ensurePeriod(truncate(firstSentence(me.bio), 110))}` : '';
  const ask = pick(ASKS[messageType] || ASKS.Networking, variant, 3)(company);
  const shortAsk = (SHORT_ASKS[messageType] || SHORT_ASKS.Networking)(company);
  const shortSign = me.name ? `– ${me.name}` : '';

  // Richest first; shed optional parts in a fixed order until it fits.
  const attempts = [
    { openers, meLine, ask, sign },
    { openers, meLine: '', ask, sign },
    { openers: openers.slice(0, 1), meLine: '', ask, sign },
    { openers: openers.slice(0, 1), meLine: '', ask, sign: shortSign },
    { openers: openers.slice(0, 1), meLine: '', ask: shortAsk, sign: shortSign },
    { openers: openers.slice(0, 1), meLine: '', ask: shortAsk, sign: '' }
  ];
  for (const a of attempts) {
    const text = assemble(greet, a);
    if (text.length <= fmt.limit) return text;
  }
  return hardFit(assemble(greet, attempts[attempts.length - 1]), fmt.limit);
}

function assemble(greet, { openers, meLine, ask, sign }) {
  const body = [openers.join(' '), meLine].filter(Boolean).join(' ');
  return [greet, body, ask, sign].filter(Boolean).join('\n\n');
}

// ─── Follow-ups ───────────────────────────────────────────────────────────────
const FOLLOW_OPENERS = [
  (topic) => `Just bumping this up in case it got buried${topic ? ` — I'd reached out about ${topic}` : ''}.`,
  (topic) => `Following up on my earlier note${topic ? ` about ${topic}` : ''} — I know inboxes get busy.`,
  () => 'Circling back on my last message, no pressure at all.'
];
const FOLLOW_ASKS = {
  Networking: () => 'Would still love to connect if you are open to it.',
  Job: c => `Still keen to hear how the team${c ? ` at ${c}` : ''} works — would 10 minutes this week or next work?`,
  Referral: c => `Still interested in the role${c ? ` at ${c}` : ''} — happy to send a short summary of my fit if that helps.`,
  Collaboration: () => "Still think there's something worth exploring — happy to work around your schedule."
};

/** A short, polite follow-up. Second follow-ups get softer and offer an out. */
export function localFollowUp({ contact, me = {}, tone, variant = 0, limit = 400 }) {
  const first = (contact.name || '').split(/\s+/)[0] || 'there';
  const topic = topicFromHooks(contact.hooks);
  const opener = pick(FOLLOW_OPENERS, variant, contact.followUps || 0)(topic);
  const ask = (FOLLOW_ASKS[contact.purpose] || FOLLOW_ASKS.Networking)(contact.company);
  const out = (contact.followUps || 0) >= 1 ? "If now's not a good time, no worries — I won't keep pinging." : '';
  const sign = me.name ? `${SIGNOFF[tone] || SIGNOFF.Neutral}\n${me.name}` : '';
  const text = [greeting(first, tone), [opener, ask, out].filter(Boolean).join(' '), sign].filter(Boolean).join('\n\n');
  return hardFit(text, limit);
}

function topicFromHooks(hooks = []) {
  const h = hooks[0];
  if (!h) return '';
  if (h.kind === 'post') return 'your post';
  if (h.kind?.startsWith('shared')) return `our shared ${h.kind === 'sharedSchool' ? 'school' : h.kind === 'sharedCompany' ? 'time at ' + h.value : 'background'}`;
  return '';
}
