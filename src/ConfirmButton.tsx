import { useEffect, useRef, useState } from 'react';

interface ConfirmButtonProps {
  /** Text on the button before confirming, e.g. "Clear history". */
  label: string;
  /** The question shown while confirming, e.g. "Clear all 4 transfers?". */
  question: string;
  /** Text on the confirming button, e.g. "Clear". */
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  /** "button" for a full ghost button, "link" for an inline text button. */
  variant?: 'button' | 'link';
}

/** A destructive action that asks once, inline, before it runs. */
export default function ConfirmButton({
  label,
  question,
  confirmLabel,
  onConfirm,
  disabled = false,
  variant = 'link',
}: ConfirmButtonProps) {
  const [asking, setAsking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // After Cancel, put keyboard focus back on the original button.
  useEffect(() => {
    if (asking || !restoreFocus.current) return;
    restoreFocus.current = false;
    triggerRef.current?.focus();
  }, [asking]);

  const plain = variant === 'button' ? 'btn btn-ghost' : 'btn-link btn-link--muted';
  const danger = variant === 'button' ? 'btn btn-danger' : 'btn-link btn-link--danger';

  if (!asking) {
    return (
      <button ref={triggerRef} type="button" className={plain} onClick={() => setAsking(true)} disabled={disabled}>
        {label}
      </button>
    );
  }

  return (
    <span className={`confirm confirm--${variant}`} role="group" aria-label={question}>
      <span className="confirm-question">{question}</span>
      <button
        type="button"
        className={danger}
        // Focus moves here because the button that was clicked is gone.
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className={plain}
        onClick={() => {
          restoreFocus.current = true;
          setAsking(false);
        }}
      >
        Cancel
      </button>
    </span>
  );
}
