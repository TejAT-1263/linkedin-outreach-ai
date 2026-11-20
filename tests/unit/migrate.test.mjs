import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../../extension/background/migrate.js';
import { SCHEMA_VERSION } from '../../extension/shared/constants.js';

test('migrates the original v3.1 data and drops the stored PDF', () => {
  const v31 = {
    userApiKey: 'sk-ant-abc', userName: 'Arjun', userBio: 'Hi', resumeBase64: 'JVBER...', resumeFileName: 'cv.pdf',
    recentContacts: [{ profileUrl: 'https://www.linkedin.com/in/priya/?x', name: 'Priya', headline: 'PM', company: 'Razorpay', message: 'Hello', timestamp: 1000 }]
  };
  const { set, remove, from } = migrate(v31);
  assert.equal(from, 1);
  assert.equal(set.schemaVersion, SCHEMA_VERSION);
  assert.equal(set.settings.apiKey, 'sk-ant-abc');
  assert.equal(set.settings.name, 'Arjun');
  assert.equal(set.settings.resumeFileName, 'cv.pdf');
  assert.equal(set.contacts['in:priya'].status, 'drafted');
  assert.equal(set.contacts['in:priya'].profileUrl, 'https://www.linkedin.com/in/priya/');
  assert.ok(remove.includes('resumeBase64') && remove.includes('recentContacts'));
});

test('migrates v3.2 statuses and prefs', () => {
  const { set } = migrate({ userBackground: 'Flipkart', prefs: { tone: 'Casual' }, recentContacts: [{ profileUrl: 'https://www.linkedin.com/in/a/', name: 'A', status: 'inserted', timestamp: 5 }] });
  assert.equal(set.settings.background, 'Flipkart');
  assert.equal(set.prefs.tone, 'Casual');
  assert.equal(set.prefs.format, 'note');
  assert.equal(set.contacts['in:a'].insertedAt, 5);
});

test('fresh install gets defaults; already-migrated data is untouched (idempotent)', () => {
  const fresh = migrate({});
  assert.equal(fresh.set.settings.followUpDays, 5);
  assert.deepEqual(fresh.remove, []);
  assert.deepEqual(migrate({ schemaVersion: SCHEMA_VERSION, settings: {} }), { set: {}, remove: [], from: SCHEMA_VERSION });
});
