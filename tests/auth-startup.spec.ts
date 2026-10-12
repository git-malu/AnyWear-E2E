import type { Page, Request, Response } from '@playwright/test';
import { expect, login, test } from './support/fixtures.js';
import { requireEnvironment } from './support/account.js';
import { recordForActiveStep, recordPathForActiveStep } from './support/auth-startup-attribution.mjs';

interface UiEvidence {
  loginHeading: boolean;
  loginForm: boolean;
  protectedHeading: boolean;
}

interface StepEvidence extends UiEvidence {
  step: string;
  paths: string[];
  profileRequests: number;
  profile?: { status: number; bearerPresent: boolean };
}

interface ObservationWindow extends Window {
  __authStartupReport: (evidence: UiEvidence) => Promise<void>;
  __authStartupPath: (path: string) => Promise<void>;
  __authStartupFlush: (reset?: boolean) => Promise<UiEvidence>;
}

// Runs before application scripts in every subsequent top-level document.
function observeAuthUi(): void {
  if (window !== window.top) return;
  const target = window as unknown as ObservationWindow;
  const evidence: UiEvidence = {
    loginHeading: false, loginForm: false, protectedHeading: false,
  };
  const pending: Promise<void>[] = [];
  const pendingPaths: Promise<void>[] = [];
  let formInputs = new WeakMap<Element, Set<string>>();
  const headingSelector = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const inputSelector = 'input[type="email"],input[type="password"]';
  const normalize = (value: string | null) => value?.trim().replace(/\s+/g, ' ') ?? '';

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = ((data: unknown, unused: string, url?: string | URL | null) => {
      const result = original(data, unused, url);
      pendingPaths.push(target.__authStartupPath(location.pathname).catch(() => {}));
      return result;
    }) as History[typeof method];
  }

  function inspect(node: Node, parent?: Node, oldValue?: string | null): void {
    const root = node instanceof Element ? node : node.parentElement;
    const ancestor = parent instanceof Element ? parent : parent?.parentElement;
    const headings = new Set<Element>();
    for (const element of [root, ancestor]) {
      if (!element) continue;
      const heading = element.closest(headingSelector);
      if (heading) headings.add(heading);
    }
    root?.querySelectorAll(headingSelector).forEach((heading) => headings.add(heading));
    for (const heading of headings) {
      const texts = [heading.textContent, node.nodeType === Node.TEXT_NODE ? oldValue : null,
        node.nodeType === Node.TEXT_NODE ? node.textContent : null];
      for (const text of texts) {
        const name = normalize(text ?? null);
        if (name === 'Sign in') evidence.loginHeading = true;
        if (name === 'Today' || name === 'Wardrobe') evidence.protectedHeading = true;
      }
    }

    // Retain input types from removed children as well as the surviving form.
    const forms = new Set<Element>();
    for (const element of [root, ancestor]) {
      const form = element?.closest('form');
      if (form) forms.add(form);
    }
    root?.querySelectorAll('form').forEach((form) => forms.add(form));
    for (const form of forms) {
      const types = formInputs.get(form) ?? new Set<string>();
      const inputs = [...form.querySelectorAll(inputSelector)];
      if (root && root !== form) inputs.push(...root.querySelectorAll(inputSelector));
      if (root?.matches(inputSelector)) inputs.push(root);
      for (const input of inputs) types.add(input.getAttribute('type') ?? '');
      formInputs.set(form, types);
      if (types.has('email') && types.has('password')) evidence.loginForm = true;
    }
  }

  function collect(records: MutationRecord[]): void {
    const before = JSON.stringify(evidence);
    for (const record of records) {
      inspect(record.target, undefined, record.type === 'characterData' ? record.oldValue : undefined);
      record.addedNodes.forEach((node) => inspect(node, record.target));
      record.removedNodes.forEach((node) => inspect(node, record.target));
      if (record.type === 'attributes' && record.attributeName === 'type'
        && record.target instanceof HTMLInputElement) {
        const form = record.target.closest('form');
        if (form) {
          const types = formInputs.get(form) ?? new Set<string>();
          if (record.oldValue && /^(email|password)$/i.test(record.oldValue)) types.add(record.oldValue);
          if (/^(email|password)$/i.test(record.target.type)) types.add(record.target.type);
          formInputs.set(form, types);
          if (types.has('email') && types.has('password')) evidence.loginForm = true;
        }
      }
      if (record.type === 'attributes' && record.attributeName === 'role'
        && record.target instanceof Element && (record.target.matches(headingSelector)
          || record.oldValue === 'heading')) {
        const name = normalize(record.target.textContent);
        if (name === 'Sign in') evidence.loginHeading = true;
        if (name === 'Today' || name === 'Wardrobe') evidence.protectedHeading = true;
      }
    }
    if (JSON.stringify(evidence) !== before) {
      pending.push(target.__authStartupReport({ ...evidence }).catch(() => {}));
    }
  }

  const observer = new MutationObserver(collect);
  observer.observe(document, {
    subtree: true, childList: true, characterData: true, characterDataOldValue: true,
    attributes: true, attributeOldValue: true, attributeFilter: ['type', 'role'],
  });
  target.__authStartupFlush = async (reset = false) => {
    collect(observer.takeRecords());
    await Promise.all([...pending, ...pendingPaths]);
    const result = { ...evidence };
    if (reset) {
      evidence.loginHeading = false;
      evidence.loginForm = false;
      evidence.protectedHeading = false;
      formInputs = new WeakMap<Element, Set<string>>();
      pending.length = 0;
      pendingPaths.length = 0;
    }
    return result;
  };
}

test.describe('Session startup @smoke @full-stack', () => {
  test('restores the real session across documents and clears it after logout', async ({ page, context, workerAccount }, testInfo) => {
    test.setTimeout(120_000);
    const serviceOrigin = new URL(requireEnvironment('E2E_SERVICE_URL')).origin;
    const steps: StepEvidence[] = [];
    const current = new Map<Page, StepEvidence>();
    const activeProfiles = new Set<Request>();
    const isProfileRequest = (request: Request) => {
      const url = new URL(request.url());
      return request.method() === 'GET' && url.origin === serviceOrigin && url.pathname === '/users/me';
    };
    const isProfileResponse = (response: Response) => isProfileRequest(response.request());

    function watch(viewer: Page): void {
      viewer.on('request', (request) => {
        if (!isProfileRequest(request)) return;
        activeProfiles.add(request);
        const step = current.get(viewer);
        if (step) step.profileRequests += 1;
      });
      viewer.on('requestfinished', (request) => activeProfiles.delete(request));
      viewer.on('requestfailed', (request) => activeProfiles.delete(request));
      viewer.on('framenavigated', (frame) => {
        if (frame === viewer.mainFrame()) {
          recordPathForActiveStep(current, viewer, new URL(frame.url()).pathname);
        }
      });
    }

    function begin(viewer: Page, step: string): StepEvidence {
      const evidence: StepEvidence = {
        step, paths: [], profileRequests: 0,
        loginHeading: false, loginForm: false, protectedHeading: false,
      };
      steps.push(evidence);
      current.set(viewer, evidence);
      return evidence;
    }

    function mergeUi(viewer: Page, ui: UiEvidence): void {
      const step = current.get(viewer);
      if (step) {
        step.loginHeading ||= ui.loginHeading;
        step.loginForm ||= ui.loginForm;
        step.protectedHeading ||= ui.protectedHeading;
      }
    }

    async function settle(viewer: Page, observed = true): Promise<void> {
      await expect.poll(() => activeProfiles.size, { message: 'Profile requests must finish before the next observation interval' }).toBe(0);
      if (observed) {
        mergeUi(viewer, await viewer.evaluate(() => (window as unknown as ObservationWindow).__authStartupFlush(true)));
      }
    }

    async function authenticated(
      viewer: Page, step: string, action: () => Promise<unknown>,
      path: string, heading: string, observed = true, directLogin = false,
    ): Promise<void> {
      const evidence = begin(viewer, step);
      const profile = viewer.waitForResponse(isProfileResponse);
      const [, response] = await Promise.all([action(), profile]);
      expect(await response.finished()).toBeNull();
      evidence.profile = {
        status: response.status(),
        bearerPresent: /^Bearer\s+\S+$/i.test((await response.request().allHeaders()).authorization ?? ''),
      };
      expect(evidence.profile.status, `${step}: /users/me must succeed`).toBe(200);
      expect(evidence.profile.bearerPresent).toBe(true);
      await expect(viewer).toHaveURL((url) => url.pathname === path);
      await expect(viewer.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await settle(viewer, observed);
      expect(evidence.profileRequests).toBeGreaterThan(0);
      if (observed) {
        expect(evidence.loginHeading, `${step}: no transient Sign in heading`).toBe(false);
        expect(evidence.loginForm, `${step}: no transient login form`).toBe(false);
        // An explicitly requested /login document is allowed; a later redirect there is not.
        const paths = directLogin && evidence.paths[0] === '/login' ? evidence.paths.slice(1) : evidence.paths;
        expect(paths, `${step}: no unexpected login navigation`).not.toContain('/login');
      }
    }

    async function unauthenticated(step: string, action: () => Promise<unknown>): Promise<void> {
      const evidence = begin(page, step);
      await action();
      await expect(page).toHaveURL((url) => url.pathname === '/login');
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await settle(page);
      expect(evidence.profileRequests, `${step}: no profile request without a session`).toBe(0);
      expect(evidence.protectedHeading, `${step}: no protected heading mounted`).toBe(false);
      await expect(page.getByRole('heading', { name: /^(Today|Wardrobe)$/ })).not.toBeVisible();
    }

    watch(page);
    let secondPage: Page | undefined;
    try {
      await authenticated(page, 'initial sign-in', () => login(page, workerAccount), '/dashboard', 'Today', false);
      await context.exposeBinding('__authStartupReport', ({ page: viewer }, ui: UiEvidence) => {
        recordForActiveStep(current, viewer, (step) => {
          step.loginHeading ||= ui.loginHeading;
          step.loginForm ||= ui.loginForm;
          step.protectedHeading ||= ui.protectedHeading;
        });
      });
      await context.exposeBinding('__authStartupPath', ({ page: viewer }, path: string) => {
        recordPathForActiveStep(current, viewer, path);
      });
      await context.addInitScript(observeAuthUi);

      await authenticated(page, 'wardrobe navigation', () => page.goto('/wardrobe'), '/wardrobe', 'Wardrobe');
      await authenticated(page, 'protected refresh', () => page.reload(), '/wardrobe', 'Wardrobe');
      secondPage = await context.newPage();
      watch(secondPage);
      await authenticated(secondPage, 'same-context second page', () => secondPage!.goto('/wardrobe'), '/wardrobe', 'Wardrobe');
      await secondPage.close();
      secondPage = undefined;
      await authenticated(page, 'authenticated direct login', () => page.goto('/login'), '/dashboard', 'Today', true, true);

      begin(page, 'explicit logout');
      await page.getByRole('button', { name: 'Logout', exact: true }).click();
      await expect(page).toHaveURL((url) => url.pathname === '/login');
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      await settle(page);
      await unauthenticated('unauthenticated refresh', () => page.reload());
      await unauthenticated('unauthenticated protected navigation', () => page.goto('/wardrobe'));
    } finally {
      if (secondPage && !secondPage.isClosed()) await secondPage.close();
      await testInfo.attach('auth-startup-evidence', {
        body: JSON.stringify({ serviceOrigin, steps }, null, 2),
        contentType: 'application/json',
      });
    }
  });
});
