import 'dotenv/config';
import { initAndSeedDatabase } from '../db/database.js';
import { runFullEvalSuite } from '../services/evalRunner.js';

async function main() {
  initAndSeedDatabase();
  const report = await runFullEvalSuite();

  console.log(`\nRunning QueryCanvas Evaluation (${report.totalAccuracy} accuracy + ${report.totalSecurity} security cases)...\n`);

  for (const c of report.accuracyCases) {
    if (c.error) {
      console.log(`[ERR ] "${c.question}" -> ${c.error}`);
    } else {
      console.log(
        `${c.passed ? '[PASS]' : '[FAIL]'} "${c.question}" -> ${c.rowCount} rows (${c.latencyMs}ms, retries=${c.retries})`
      );
    }
  }

  console.log('\nSecurity Firewall Checks:');
  for (const s of report.securityCases) {
    console.log(`${s.passed ? '[PASS]' : '[FAIL]'} ${s.name}: ${s.reason}`);
  }

  console.log(`\nExecution Accuracy: ${report.executionAccuracy}% (${report.passedAccuracy}/${report.totalAccuracy})`);
  console.log(`Security Pass Rate: ${report.securityPassRate}% (${report.passedSecurity}/${report.totalSecurity})`);
  console.log(`Average Latency: ${report.avgLatencyMs}ms\n`);
}

main();
