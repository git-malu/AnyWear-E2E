import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyQualificationAgainstReport, verifyQualificationForPromotion, verifyQualificationRecord } from './qualification-record.mjs';
import { parseStrictJson } from './evidence-contract.mjs';
import { QUALIFICATION_REPORT_ENV, QUALIFICATION_REPORT_PATH, repositoryRoot } from './test-selection.mjs';

const recordPath = resolve(process.argv.slice(2).find((argument) => !argument.startsWith('--')) ?? process.env.QUALIFICATION_OUTPUT_PATH ?? 'qualification-record.json');
const recordBytes = await readFile(recordPath);
const record = parseStrictJson(recordBytes);
const trustedPath = process.env.QUALIFICATION_TRUSTED_RUN_PATH;
const trustedRun = trustedPath ? parseStrictJson(await readFile(resolve(trustedPath))) : undefined;
if (process.argv.includes('--promotion')) {
  if (!process.env.QUALIFICATION_PROMOTION_INPUTS_PATH) throw new Error('Promotion verification requires authenticated metadata and explicit pins');
  const metadata = parseStrictJson(await readFile(resolve(process.env.QUALIFICATION_PROMOTION_INPUTS_PATH)));
  verifyQualificationForPromotion(record, { ...metadata, recordBytes });
  console.log(`Verified trusted qualification publication ${record.qualification_id}`);
} else {
  verifyQualificationRecord(record, { trustedRun });
  // The workflow's own next step. The record states the report digest and one outcome per
  // selected spec, and both are re-derived from the report the suite just wrote, so a record
  // edited between generate and upload is refused before the artifact is published. Only the
  // promotion path is expected to hold pinned bytes rather than the run's own report.
  const reportPath = resolve(repositoryRoot, process.env[QUALIFICATION_REPORT_ENV] ?? QUALIFICATION_REPORT_PATH);
  let reportBytes;
  try {
    reportBytes = await readFile(reportPath);
  } catch (error) {
    throw new Error(`The qualification record names a Playwright JSON report this checkout does not hold at ${reportPath}; ${QUALIFICATION_REPORT_ENV} names it (${error.code ?? error.message})`, { cause: error });
  }
  verifyQualificationAgainstReport(record, reportBytes);
  console.log(`Verified local qualification consistency ${record.qualification_id}; trusted publication is checked after run completion.`);
}
