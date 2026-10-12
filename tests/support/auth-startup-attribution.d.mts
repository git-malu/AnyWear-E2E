export function recordForActiveStep<Page, Step>(
  activeSteps: ReadonlyMap<Page, Step>,
  page: Page,
  record: (step: Step) => void,
): void;

export function recordPathForActiveStep<Page, Step extends { paths: string[] }>(
  activeSteps: ReadonlyMap<Page, Step>,
  page: Page,
  path: string,
): void;
