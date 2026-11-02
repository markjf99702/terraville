// Whether the person's system asks for less motion, kept current if they change it while the page is open. The map's
// own life (cars, smoke, rotors) stays; what goes is motion that only decorates or alerts: the title screen's slow pan,
// the blinking warnings on the map, and smooth scrolling.

const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let reduce = !!query?.matches;
query?.addEventListener('change', (e) => (reduce = e.matches));

/** True when motion should be kept to what the game needs. */
export function lessMotion(): boolean {
  return reduce;
}
