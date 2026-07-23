// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.

/**
 * Whether a keyboard event landing on this element should be left alone by the
 * global shortcut handler — the user is typing into a field and expects the key
 * (Space, Enter, a digit) to reach that field rather than fire a shortcut.
 *
 * `<textarea>` counts as much as `<input>`: the feedback widget's message box is
 * a textarea, and leaving it out meant every space typed there fired the global
 * record/play shortcut instead of reaching the field, so feedback came through
 * with the spaces stripped out.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable === true
  );
}
