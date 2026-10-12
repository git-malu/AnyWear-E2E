import assert from 'node:assert/strict';
import test from 'node:test';
import { recordForActiveStep, recordPathForActiveStep } from '../tests/support/auth-startup-attribution.mjs';

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

test('records route changes once while preserving a later return to the same route', () => {
  const page = {};
  const activeSteps = new Map();
  const step = { paths: [] };
  activeSteps.set(page, step);

  // Playwright and the injected history observer can report the same transition.
  recordPathForActiveStep(activeSteps, page, '/login');
  recordPathForActiveStep(activeSteps, page, '/login');
  recordPathForActiveStep(activeSteps, page, '/dashboard');
  recordPathForActiveStep(activeSteps, page, '/dashboard');
  recordPathForActiveStep(activeSteps, page, '/login');

  assert.deepEqual(step.paths, ['/login', '/dashboard', '/login']);
});
