import assert from 'node:assert/strict';
import test from 'node:test';
import { recordForActiveStep } from '../tests/support/auth-startup-attribution.mjs';

test('attributes same-document SPA observations to the active step', () => {
  const page = {};
  const activeSteps = new Map();
  const directLogin = { paths: [], loginHeading: false };
  const logout = { paths: [], loginHeading: false };

  // The document starts during direct login and remains open through logout.
  activeSteps.set(page, directLogin);
  activeSteps.set(page, logout);
  recordForActiveStep(activeSteps, page, (step) => step.paths.push('/login'));
  recordForActiveStep(activeSteps, page, (step) => { step.loginHeading = true; });

  assert.deepEqual(directLogin, { paths: [], loginHeading: false });
  assert.deepEqual(logout, { paths: ['/login'], loginHeading: true });
});
