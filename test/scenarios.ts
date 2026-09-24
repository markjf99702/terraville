// Build every challenge city and report its opening state and first year.
import { SCENARIOS, buildScenario } from '../src/scenarios';
import { Sim } from '../src/sim';

for (const s of SCENARIOS) {
  const t0 = performance.now();
  const world = buildScenario(s);
  const sim = new Sim(world);
  for (let k = 0; k < 3; k++) { sim.computeTraffic(); sim.computeMaps(); }
  sim.tally();
  const st = sim.stats;
  const g0 = s.check(sim);
  const line = (tag: string) => `${tag} pop ${st.residents} jobs ${st.comJobs + st.indJobs} zones ${st.zones.res}/${st.zones.com}/${st.zones.ind} unpow ${st.unpowered} noroad ${st.noRoad} notrip ${st.noTrip} traf ${Math.round(st.avgTraffic / 2.55)} pol ${Math.round(st.avgPollution / 2.55)} power ${st.powerDemand}/${st.powerSupply}`;
  console.log(`\n${s.name} (${(performance.now() - t0).toFixed(0)} ms): ${g0.status}`);
  console.log('  ' + line('start'));
  s.start?.(sim);
  for (let m = 0; m < 24; m++) { for (let k = 0; k < 4; k++) sim.step(); s.monthly?.(sim); }
  console.log('  ' + line('+2y  ') + ` funds ${Math.round(world.city.funds)} appr ${Math.round(st.approval)} :: ${s.check(sim).status}`);
}
