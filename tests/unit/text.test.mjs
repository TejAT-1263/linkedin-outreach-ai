import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate, hardFit, matchesAny, contactIdFromUrl, canonicalProfileUrl, csvCell, uniq, ensurePeriod } from '../../extension/shared/text.js';

test('truncate cuts at a word and adds an ellipsis', () => {
  assert.equal(truncate('one two three four five six', 15), 'one two three…');
  assert.equal(truncate('short', 15), 'short');
});

test('hardFit never exceeds the limit and prefers sentence ends', () => {
  const s = 'First sentence here. Second sentence is longer and goes on and on.';
  const out = hardFit(s, 30);
  assert.ok(out.length <= 30);
  assert.equal(out, 'First sentence here.');
  for (let n = 5; n < 80; n++) assert.ok(hardFit(s, n).length <= n, `limit ${n}`);
});

test('matchesAny is whole-word and case/accent-insensitive', () => {
  assert.ok(matchesAny('IIT Bombay', ['iit bombay']));
  assert.ok(matchesAny('Indian Institute of Technology, IIT Bombay', ['IIT Bombay']));
  assert.ok(matchesAny('São Paulo', ['Sao Paulo']));
  assert.ok(!matchesAny('PostgreSQL', ['SQL']), 'SQL must not match PostgreSQL');
  assert.ok(!matchesAny('Go', ['Google']), 'too short');
  assert.ok(!matchesAny('Meta', ['Metamorphic Labs']));
});

test('profile ids and canonical URLs', () => {
  assert.equal(contactIdFromUrl('https://www.linkedin.com/in/Priya-Sharma/?utm=x'), 'in:priya-sharma');
  assert.equal(contactIdFromUrl('https://www.linkedin.com/in/j%C3%B6rg/'), 'in:jörg');
  assert.equal(contactIdFromUrl('https://www.linkedin.com/feed/'), null);
  assert.equal(canonicalProfileUrl('https://www.linkedin.com/in/priya-sharma?x=1#a'), 'https://www.linkedin.com/in/priya-sharma/');
});

test('csvCell quotes and neutralises formula injection', () => {
  assert.equal(csvCell('a "b"'), '"a ""b"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+1'), `"'+1"`);
});

test('uniq is normalised; ensurePeriod', () => {
  assert.deepEqual(uniq(['SQL', 'sql', 'React']), ['SQL', 'React']);
  assert.equal(ensurePeriod('Hi there'), 'Hi there.');
  assert.equal(ensurePeriod('Hi there?'), 'Hi there?');
});
