// Build every challenge city and report its opening state and first two years.
// Usage: node run-test.mjs test/scenarios.ts [seed=N]
//   seed=N: the same run every time, for comparing before and after a change.
import { SCENARIOS, buildScenario, openScenario } from '../src/scenarios';
import { Sim } from '../src/sim';
import { makeRng } from '../src/rng';

const seed = process.argv.find((a) => a.startsWith('seed='));
if (seed) Math.random = makeRng(Number(seed.slice(5)));

for (const s of SCENARIOS) {
  const t0 = performance.now();
  const world = buildScenario(s);
  const sim = new Sim(world);
  openScenario(sim);
  const st = sim.stats;
  const g0 = s.check(sim);
  const line = (tag: string) => `${tag} pop ${st.residents} jobs ${st.comJobs + st.indJobs} zones ${st.zones.res}/${st.zones.com}/${st.zones.ind} unpow ${st.unpowered} noroad ${st.noRoad} notrip ${st.noTrip} traf ${Math.round(st.avgTraffic / 2.55)} pol ${Math.round(st.avgPollution / 2.55)} power ${st.powerDemand}/${st.powerSupply}`;
  console.log(`\n${s.name} (${(performance.now() - t0).toFixed(0)} ms): ${g0.status}`);
  console.log('  ' + line('start'));
  s.start?.(sim);
  for (let m = 0; m < 24; m++) { for (let k = 0; k < 4; k++) sim.step(); s.monthly?.(sim); }
  console.log('  ' + line('+2y  ') + ` funds ${Math.round(world.city.funds)} appr ${Math.round(st.approval)} :: ${s.check(sim).status}`);
}
