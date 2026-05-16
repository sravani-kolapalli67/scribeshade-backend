import { PrismaClient, SessionStatus, Prisma } from './node_modules/@prisma/client/default.js';

const p = new PrismaClient();
const USER_ID = '394819ee-7bde-44af-b472-ce1becdbe947';
const COMPANY_ID = '176d420c-ed24-49ea-a6de-0b728290dae3';
const RESUME_ID = '0e602d56-1f1d-4919-aa9d-c767cf3097fb';

async function api(method, path, body) {
  const o = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) o.body = JSON.stringify(body);
  const r = await fetch('http://localhost:3200' + path, o);
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mkSession(free) {
  return p.session.create({
    data: {
      userId: USER_ID, companyId: COMPANY_ID, companyName: 'Google',
      jobDescription: 'SWE', resumeId: RESUME_ID, DocumentId: '',
      language: 'TypeScript', simpleLanguage: true, extraContext: '',
      autoGenerateResponse: false, saveTranscription: false,
      mode: 'manual', free, status: SessionStatus.PRE_CHECK,
    }
  });
}

async function setBalance(pc, hc, ta) {
  await p.userCreditBalance.upsert({
    where: { userId: USER_ID },
    update: { purchasedCredits: new Prisma.Decimal(pc), heldCredits: new Prisma.Decimal(hc), totalAvailable: new Prisma.Decimal(ta) },
    create: { userId: USER_ID, purchasedCredits: new Prisma.Decimal(pc), earnedCredits: new Prisma.Decimal(0), heldCredits: new Prisma.Decimal(hc), totalAvailable: new Prisma.Decimal(ta) },
  });
}

async function main() {
  let pass = 0, fail = 0;
  function ok(name, cond, got) {
    if (cond) { console.log('  ✅', name); pass++; }
    else { console.log('  ❌', name, '| got:', JSON.stringify(got)); fail++; }
  }

  // ── TEST 1: Public endpoints ──────────────────────────────────────────────
  console.log('\n══ TEST 1: Public endpoints');
  const h = await api('GET', '/api/health');
  ok('health ok', h.status === 'ok', h);

  const br = await api('GET', '/api/credits/brackets');
  ok('2 active brackets', br.data?.length === 2, br.data?.length);
  ok('30-min creditsFull=0.5', br.data?.[0]?.creditsFull === '0.5', br.data?.[0]?.creditsFull);
  ok('60-min creditsFull=1', br.data?.[1]?.creditsFull === '1', br.data?.[1]?.creditsFull);

  const b401 = await api('GET', '/api/credits/balance');
  ok('balance requires auth', Boolean(b401.error), b401);
  const l401 = await api('GET', '/api/credits/ledger');
  ok('ledger requires auth', Boolean(l401.error), l401);
  const pu401 = await api('GET', '/api/credits/purchases');
  ok('purchases requires auth', Boolean(pu401.error), pu401);

  // ── TEST 2: Activate unknown session → error ──────────────────────────────
  console.log('\n══ TEST 2: Unknown session → error');
  const a404 = await api('POST', '/api/session/00000000-0000-0000-0000-000000000000/activate');
  ok('activate fake-id → error', Boolean(a404.error), a404);

  // ── TEST 3: Paid session full lifecycle ───────────────────────────────────
  console.log('\n══ TEST 3: Paid session full lifecycle');
  await setBalance(1, 0, 1);
  const s = await mkSession(false);

  const act = await api('POST', '/api/session/' + s.id + '/activate');
  ok('activate succeeds', act.success === true, act);
  ok('creditsHeld = 1', act.creditsHeld === '1', act.creditsHeld);
  ok('maxAllowedMinutes = 60', act.maxAllowedMinutes === 60, act.maxAllowedMinutes);

  const bal1 = await p.userCreditBalance.findUnique({ where: { userId: USER_ID } });
  ok('DB heldCredits = 1', bal1.heldCredits.toString() === '1', bal1.heldCredits);
  ok('DB totalAvailable = 0', bal1.totalAvailable.toString() === '0', bal1.totalAvailable);

  const hb1 = await api('POST', '/api/session/' + s.id + '/heartbeat', { elapsedMinutes: 5 });
  ok('heartbeat 5 min → NONE', hb1.action === 'NONE', hb1);
  ok('remainingMinutes = 55', hb1.remainingMinutes === 55, hb1.remainingMinutes);

  const hbw = await api('POST', '/api/session/' + s.id + '/heartbeat', { elapsedMinutes: 59 });
  ok('heartbeat 59 min → CREDIT_WARNING', hbw.action === 'CREDIT_WARNING', hbw);

  const deact = await api('POST', '/api/session/' + s.id + '/deactivate');
  ok('deactivate → COMPLETING', deact.status === 'COMPLETING', deact.status);

  const deact2 = await api('POST', '/api/session/' + s.id + '/deactivate');
  ok('deactivate idempotent (no crash)', deact2.success || Boolean(deact2.status), deact2);

  console.log('  waiting 8 s for BullMQ worker...');
  await sleep(8000);

  const sf = await p.session.findUnique({ where: { id: s.id }, select: { status: true, creditsDeducted: true, deductionReason: true } });
  ok('session → COMPLETED', sf.status === 'COMPLETED', sf.status);
  ok('deductionReason = FREE_ZONE', sf.deductionReason === 'FREE_ZONE', sf.deductionReason);
  ok('creditsDeducted = 0', sf.creditsDeducted?.toString() === '0', sf.creditsDeducted);

  const bf = await p.userCreditBalance.findUnique({ where: { userId: USER_ID } });
  ok('heldCredits = 0 after worker', bf.heldCredits.toString() === '0', bf.heldCredits);
  ok('totalAvailable = 1 restored', bf.totalAvailable.toString() === '1', bf.totalAvailable);

  const led = await p.creditLedger.findMany({ where: { sessionId: s.id } });
  ok('ledger entry created', led.length === 1, led.length);
  ok('ledger type = DEBIT', led[0]?.type === 'DEBIT', led[0]?.type);
  ok('ledger reason = FREE_ZONE', led[0]?.reason === 'FREE_ZONE', led[0]?.reason);

  // ── TEST 4: Free session (no hold) ────────────────────────────────────────
  console.log('\n══ TEST 4: Free session lifecycle');
  const fs = await mkSession(true);
  const fa = await api('POST', '/api/session/' + fs.id + '/activate');
  ok('free activate ok', fa.success === true, fa);
  ok('free creditsHeld = 0', fa.creditsHeld === '0', fa.creditsHeld);
  const fd = await api('POST', '/api/session/' + fs.id + '/deactivate');
  ok('free deactivate ok', fd.success === true, fd);
  await sleep(3000);
  const fss = await p.session.findUnique({ where: { id: fs.id }, select: { status: true } });
  ok('free session → COMPLETED', fss.status === 'COMPLETED', fss.status);

  // ── TEST 5: DELETE PRE_CHECK releases hold ────────────────────────────────
  console.log('\n══ TEST 5: DELETE PRE_CHECK session releases hold');
  await setBalance(1, 0, 1);
  const ds = await mkSession(false);
  await api('POST', '/api/session/' + ds.id + '/activate');
  const bpre = await p.userCreditBalance.findUnique({ where: { userId: USER_ID } });
  ok('hold placed before delete', bpre.heldCredits.toString() === '1', bpre.heldCredits);

  // Revert to PRE_CHECK so deleteSession exercises the hold-release path
  await p.session.update({ where: { id: ds.id }, data: { status: SessionStatus.PRE_CHECK } });
  const delResp = await api('DELETE', '/api/session/' + ds.id);
  ok('delete returns no error', Boolean(delResp.id) || !delResp.error, delResp);

  const bpost = await p.userCreditBalance.findUnique({ where: { userId: USER_ID } });
  ok('heldCredits = 0 after delete', bpost.heldCredits.toString() === '0', bpost.heldCredits);
  ok('totalAvailable = 1 after delete', bpost.totalAvailable.toString() === '1', bpost.totalAvailable);

  // ── TEST 6: Insufficient credits → error ──────────────────────────────────
  console.log('\n══ TEST 6: Insufficient credits');
  await setBalance('0.10', 0, '0.10');
  const ps = await mkSession(false);
  const pa = await api('POST', '/api/session/' + ps.id + '/activate');
  ok('0.10 credits → error', Boolean(pa.error), pa);
  await p.session.delete({ where: { id: ps.id } });
  await setBalance(1, 0, 1);

  // ── TEST 7: Heartbeat on non-existent session → NONE ─────────────────────
  console.log('\n══ TEST 7: Heartbeat on unknown session');
  const hbn = await api('POST', '/api/session/00000000-0000-0000-0000-000000000001/heartbeat', { elapsedMinutes: 5 });
  ok('unknown id heartbeat → NONE', hbn.action === 'NONE', hbn);

  // ── TEST 8: Double-activate (idempotent) ──────────────────────────────────
  console.log('\n══ TEST 8: Double activate (idempotent)');
  await setBalance(1, 0, 1);
  const is = await mkSession(false);
  const ia1 = await api('POST', '/api/session/' + is.id + '/activate');
  ok('first activate ok', ia1.success === true, ia1);
  const ia2 = await api('POST', '/api/session/' + is.id + '/activate');
  ok('second activate idempotent (no error)', ia2.success === true, ia2);
  await api('POST', '/api/session/' + is.id + '/deactivate');

  // ── TEST 9: tsc --noEmit ──────────────────────────────────────────────────
  console.log('\n══ TEST 9: TypeScript compile check');
  const { execSync } = await import('child_process');
  try {
    execSync('pnpm tsc --noEmit', { cwd: process.cwd(), stdio: 'pipe' });
    ok('tsc --noEmit clean', true);
  } catch (e) {
    ok('tsc --noEmit clean', false, e.stdout?.toString());
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(40));
  console.log(` RESULTS: ${pass} passed, ${fail} failed`);
  console.log('═'.repeat(40) + '\n');

  await p.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
