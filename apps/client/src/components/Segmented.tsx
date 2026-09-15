import { type CSSProperties, type KeyboardEvent, useRef } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * The shared segmented control (R2, `docs/design/polish-pass.md`): pick one
 * of several views as a `role="radiogroup"` of ghost text options inside a
 * `--color-field` track (`controls.css#.segmented`), the current option's
 * `--color-surface` thumb sliding under it via `--seg-index`/`--seg-count`
 * set inline here rather than measured — one implementation so Calendar's
 * view switcher and Contacts' tab strip (whose own hairline underline is
 * why it moved here) share one shape and one motion budget instead of each
 * hand-rolling its own pill.
 *
 * A roving `tabIndex` (only the checked option is in the Tab order) plus
 * arrow-key navigation is the native radiogroup pattern: Left/Up moves to
 * the previous option, Right/Down to the next, wrapping at either end, and
 * selecting an option moves focus to it — never just paints it selected
 * with focus left behind.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The radiogroup's accessible name (`aria-label`) — e.g. "Calendar view". */
  label: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const currentIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  function selectIndex(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    const radios = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        selectIndex((currentIndex + 1) % options.length);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        selectIndex((currentIndex - 1 + options.length) % options.length);
        break;
      case "Home":
        event.preventDefault();
        selectIndex(0);
        break;
      case "End":
        event.preventDefault();
        selectIndex(options.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className="segmented"
      style={
        {
          "--seg-index": currentIndex,
          "--seg-count": options.length,
        } as CSSProperties
      }
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: a native `<input type="radio">` brings its own default appearance and form-field baggage that fights `.segmented-option`'s own ghost-text-in-a-track look (`EventEditorPopover.tsx`'s own `role="group"` call makes the same trade); `role="radio"` on a `<button>` gives the same semantics with none of it.
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className="segmented-option"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
