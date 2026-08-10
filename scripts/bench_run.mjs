// Runs the eater bench N times inside one process and reports median tick rate.
import { execFileSync } from 'node:child_process';
const n = Number(process.argv[2] ?? 5);
const iters = process.argv[3] ?? '300000';
const results = [];
for (let i = 0; i < n; i++) {
  const out = execFileSync('npx', ['tsx', 'scripts/bench_eater.ts', iters], { encoding: 'utf8', stdio: ['ignore','pipe','inherit'] });
  const rate = Number(out.match(/rate:\s+(\d+) ticks\/s/)?.[1]);
  const clock = Number(out.match(/clock:\s+(\d+) simulated Hz/)?.[1]);
  results.push({ rate, clock });
  console.log(`  run ${i+1}: ${rate} ticks/s  ${clock} Hz`);
}
results.sort((a,b)=>a.rate-b.rate);
const med = results[Math.floor(results.length/2)];
const sum = results.reduce((a,b)=>a+b.rate,0);
console.log(`median: ${med.rate} ticks/s  ${med.clock} Hz  (mean ${(sum/results.length).toFixed(0)}, min ${results[0].rate}, max ${results[results.length-1].rate})`);
