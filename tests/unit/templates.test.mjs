import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templatize, applyTemplate, validateTemplate } from '../../extension/background/templates.js';

test('templatize swaps concrete values for placeholders (longest first, whole words)', () => {
  const draft = 'Hi Priya,\n\nFellow Flipkart alum here. Curious about your work as Senior Product Manager at Razorpay.\n\nBest,\nArjun Mehta';
  const tpl = templatize(draft, { firstName: 'Priya', company: 'Razorpay', title: 'Senior Product Manager', myName: 'Arjun Mehta', hookSentence: 'Fellow Flipkart alum here.' });
  assert.equal(tpl, 'Hi {firstName},\n\n{hook} Curious about your work as {title} at {company}.\n\nBest,\n{myName}');
  assert.equal(templatize('Hi Al, Albert said hi', { firstName: 'Al' }), 'Hi {firstName}, Albert said hi');
});

test('applyTemplate fills values and tidies empty placeholders', () => {
  const out = applyTemplate('Hi {firstName},\n\n{hook} Curious about {company}.\n\n\n\nBest,\n{myName}', { firstName: 'Sam', company: '', hook: '', myName: '' });
  assert.equal(out, 'Hi Sam,\n\nCurious about your team.\n\nBest,');
});

test('validateTemplate', () => {
  assert.throws(() => validateTemplate({ name: '', text: 'long enough text' }), /name/);
  assert.throws(() => validateTemplate({ name: 'x', text: 'short' }), /short/);
  assert.equal(validateTemplate({ name: '  Warm  ', text: 'Hello {firstName}!' }).name, 'Warm');
});
