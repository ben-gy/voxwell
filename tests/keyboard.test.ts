import { describe, expect, it } from 'vitest';
import { isTypingTarget } from '../src/keyboard';

describe('isTypingTarget', () => {
  it('treats a textarea as a typing target, so a space typed there is not eaten by the record/play shortcut', () => {
    // The feedback widget's message box is a <textarea>; when this returned
    // false, every space bar press there fired the global record/play shortcut
    // and never reached the field, so typed feedback ran together with no spaces.
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
  });

  it('also covers the other native form fields', () => {
    // contentEditable is handled too, but jsdom does not implement
    // isContentEditable, so it cannot be asserted here — it is exercised in the
    // running app instead.
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
  });

  it('lets shortcuts through for non-editable targets and for no target', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
