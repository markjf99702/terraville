// Keyboard focus: which control the keyboard put focus on (Tab, or a dialog handing it back), as opposed to a click
// or a tap. Space and Enter press only such a control, and a dialog returns focus only to an opener that had it.

let keyboardFocus: Element | null = null;
let watching = false;

/**
 * Start noting how focus arrives. :focus-visible is read as focus arrives, because Chromium makes whatever has focus
 * match :focus-visible as soon as any key goes down, even a button that a click put there.
 */
export function watchFocus(): void {
  if (watching) return;
  watching = true;
  document.addEventListener('focusin', (e) => {
    const t = e.target as Element;
    keyboardFocus = focusVisible(t) ? t : null;
  });
}

/** Whether `el` has focus, put there by the keyboard. */
export function hasKeyboardFocus(el: Element | null): el is HTMLElement {
  return !!el && el === keyboardFocus && el === document.activeElement;
}

/** Browsers too old for :focus-visible say no, which leaves them as they always were here. */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}
