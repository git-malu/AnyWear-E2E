import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyQualificationRecord } from './qualification-record.mjs';

const recordPath = resolve(process.argv[2] ?? process.env.QUALIFICATION_OUTPUT_PATH ?? 'qualification-record.json');
const record = JSON.parse(await readFile(recordPath, 'utf8'));
verifyQualificationRecord(record);
console.log(`Verified qualification record ${record.qualification_id}`);
