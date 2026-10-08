import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyQualificationForPromotion, verifyQualificationRecord } from './qualification-record.mjs';
import { parseStrictJson } from './evidence-contract.mjs';

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
  console.log(`Verified local qualification consistency ${record.qualification_id}; trusted publication is checked after run completion.`);
}
