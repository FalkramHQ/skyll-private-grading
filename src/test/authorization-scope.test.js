// School authorization compares ids (FLKRM-389). These keep the guarantees the
// old name matcher (schoolMatches) gave, now through inActorSchool: historical
// spellings still map to the right school, other schools never match, and
// anything missing or unresolvable is refused.
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { resetSchoolCache } from '../../api/_lib/canonicalSubmissions.js';
import { inActorSchool } from '../../api/_lib/schoolScope.js';

let db;
const partnerb = { role: 'teacher', school: "Partner Academy B", school_id: 'sch_partnerb' };
const partnerc = { role: 'teacher', school: 'Partner Academy C', school_id: 'sch_partnerc' };

beforeEach(async () => {
  resetSchoolCache();
  db = createClient({ url: ':memory:' });
  await db.batch([
    'CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, slug TEXT)',
    "INSERT INTO schools VALUES ('sch_partnerb', 'Partner Academy B', 'partner-academy-b'), ('sch_partnerc', 'Partner Academy C', 'partner-academy-c'), ('sch_partnerd', 'Partner Academy D', 'partner-academy-d')",
  ], 'write');
});

describe('authorization scope contract', () => {
  it('maps historical spellings to the same school, never to another school', async () => {
    expect(await inActorSchool(db, partnerb, { schoolName: 'Partner Academy B' })).toBe(true);
    expect(await inActorSchool(db, partnerb, { schoolName: 'partner-academy-b' })).toBe(true);
    expect(await inActorSchool(db, partnerc, { schoolName: 'Partner Academy D' })).toBe(false);
    expect(await inActorSchool(db, partnerc, { schoolId: 'sch_partnerd' })).toBe(false);
  });

  it("never lets near-identical names stand in for each other (the gap schoolMatches left)", async () => {
    // Legacy data created before provisioning refused normalized collisions.
    await db.execute("INSERT INTO schools VALUES ('sch_mary1', 'St. Mary''s', 'st-marys'), ('sch_mary2', 'St Marys', 'st-marys-2')");
    resetSchoolCache();
    const maryTeacher = { role: 'teacher', school: "St. Mary's", school_id: 'sch_mary1' };
    // schoolMatches("St Marys", "St. Mary's") was true; the ids differ, so this is refused.
    expect(await inActorSchool(db, maryTeacher, { schoolName: 'St Marys' })).toBe(false);
    expect(await inActorSchool(db, maryTeacher, { schoolName: "St. Mary's" })).toBe(true);
    // A variant that matches neither exactly is ambiguous, so it is refused too.
    expect(await inActorSchool(db, maryTeacher, { schoolName: 'ST MARYS' })).toBe(false);
  });

  it('refuses a missing, empty, or unknown school on either side', async () => {
    expect(await inActorSchool(db, partnerc, {})).toBe(false);
    expect(await inActorSchool(db, partnerc, { schoolName: '' })).toBe(false);
    expect(await inActorSchool(db, partnerc, { schoolName: 'Unknown Academy' })).toBe(false);
    expect(await inActorSchool(db, { ...partnerc, school_id: null }, { schoolId: 'sch_partnerc' })).toBe(false);
    expect(await inActorSchool(db, null, { schoolId: 'sch_partnerc' })).toBe(false);
  });

  it('ignores case and spacing when resolving a name, but decides on the id', async () => {
    expect(await inActorSchool(db, partnerc, { schoolName: ' partner  academy  c ' })).toBe(true);
    expect(await inActorSchool(db, partnerc, { schoolId: 'sch_partnerc' })).toBe(true);
  });

  it('finds a school provisioned after the name map was cached', async () => {
    expect(await inActorSchool(db, partnerc, { schoolName: 'Partner Academy C' })).toBe(true); // map now cached
    await db.execute("INSERT INTO schools VALUES ('sch_new', 'New Horizon', 'new-horizon')");
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000; // past the 30s refresh window
    try {
      expect(await inActorSchool(db, { role: 'admin', school_id: 'sch_new' }, { schoolName: 'New Horizon' })).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});
