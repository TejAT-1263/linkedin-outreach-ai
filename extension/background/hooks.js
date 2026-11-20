// background/hooks.js — turn a scraped profile into specific things worth mentioning.
import { truncate, firstSentence, matchesAny, uniq, clean } from '../shared/text.js';

const str = (x, max = 500) => clean(typeof x === 'string' ? x : '').slice(0, max);
const strArr = (x, n, max = 200) => (Array.isArray(x) ? x : []).map(v => str(v, max)).filter(Boolean).slice(0, n);

/** Validate + normalise anything that came from the page (untrusted input). */
export function normalizeProfile(raw = {}) {
  const name = str(raw.name, 120);
  const edu = (Array.isArray(raw.educationEntries) ? raw.educationEntries : []).slice(0, 5)
    .map(e => (typeof e === 'string' ? { school: str(e, 150), detail: '' } : { school: str(e?.school, 150), detail: str(e?.detail, 150) }))
    .filter(e => e.school);
  return {
    name,
    firstName: name.split(/\s+/)[0] || 'there',
    headline: str(raw.headline, 220),
    currentTitle: str(raw.currentTitle, 120),
    currentCompany: str(raw.currentCompany, 120),
    location: str(raw.location, 120),
    about: str(raw.about, 2000),
    recentPosts: strArr(raw.recentPosts, 3, 500),
    pastCompanies: strArr(raw.pastCompanies, 5),
    educationEntries: edu,
    skills: strArr(raw.skills, 15, 80),
    profileUrl: str(raw.profileUrl, 300)
  };
}

/**
 * Hooks: { id, kind, label (shown), value (used in writing), score, selected }.
 * Common ground with the sender scores highest — it's the strongest reason to reply.
 * @param {ReturnType<typeof normalizeProfile>} p
 * @param {{terms?: string[]}} me
 */
export function buildHooks(p, me = {}) {
  const hooks = [];
  const add = (kind, label, value, score) => hooks.push({ id: `${kind}-${hooks.length}`, kind, label, value, score });
  const mine = me.terms || [];

  const theirCompanies = uniq([p.currentCompany, ...p.pastCompanies].filter(Boolean));
  const theirSchools = p.educationEntries.map(e => e.school);

  const sharedCo = theirCompanies.find(c => matchesAny(c, mine));
  if (sharedCo) add('sharedCompany', `You both worked at ${sharedCo}`, sharedCo, 10);

  const sharedSchool = theirSchools.find(s => matchesAny(s, mine));
  if (sharedSchool) add('sharedSchool', `You both studied at ${sharedSchool}`, sharedSchool, 9);

  const sharedSkills = p.skills.filter(s => matchesAny(s, mine)).slice(0, 2);
  if (sharedSkills.length) add('sharedSkill', `You share skills: ${sharedSkills.join(', ')}`, sharedSkills.join(' and '), 6);

  const theirCity = (p.location || '').split(',')[0].trim();
  if (theirCity && matchesAny(theirCity, mine)) add('sharedLocation', `You're both in ${theirCity}`, theirCity, 5);

  if (p.recentPosts.length) add('post', `Recent post: "${truncate(p.recentPosts[0], 80)}"`, truncate(p.recentPosts[0], 70), 8);
  if (p.currentCompany) {
    add('role', p.currentTitle ? `${p.currentTitle} at ${p.currentCompany}` : `Works at ${p.currentCompany}`,
      { title: p.currentTitle, company: p.currentCompany }, p.currentTitle ? 4 : 3);
  }
  if (p.about) add('about', `About: "${truncate(firstSentence(p.about), 80)}"`, truncate(firstSentence(p.about), 70), 3.5);
  const otherPast = p.pastCompanies.find(c => c !== sharedCo);
  if (otherPast) add('pastCompany', `Previously at ${otherPast}`, otherPast, 2);
  if (p.skills.length && !sharedSkills.length) add('skill', `Skilled in ${p.skills.slice(0, 2).join(', ')}`, p.skills.slice(0, 2).join(' and '), 2);
  if (theirSchools.length && !sharedSchool) add('education', `Studied at ${theirSchools[0]}`, theirSchools[0], 1.5);
  if (!hooks.length && p.headline) add('headline', `Headline: ${truncate(p.headline, 80)}`, p.headline, 1);

  hooks.sort((a, b) => b.score - a.score);
  hooks.forEach((h, i) => { h.selected = i < 2; h.pickedAt = h.selected ? 2 - i : 0; });
  return hooks;
}

/** Sanitise hooks coming back from the popup (they round-trip through UI state). */
export function sanitizeHooks(hooks) {
  return (Array.isArray(hooks) ? hooks : []).slice(0, 20).map(h => ({
    id: str(h?.id, 60),
    kind: str(h?.kind, 30),
    label: str(h?.label, 200),
    value: h?.value && typeof h.value === 'object'
      ? { title: str(h.value.title, 120), company: str(h.value.company, 120) }
      : str(h?.value, 200),
    score: Number(h?.score) || 0,
    selected: !!h?.selected,
    pickedAt: Number(h?.pickedAt) || 0
  })).filter(h => h.kind && (h.value || h.label));
}
