import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { navigate } from './router';

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

/**
 * A link to another page in the app. A plain click navigates without
 * reloading; Ctrl/Cmd/Shift-click and middle-click keep the browser's
 * own behavior (open in a new tab or window).
 */
export default function Link({ to, onClick, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (rest.target && rest.target !== '_self')
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
  }

  return <a {...rest} href={to} onClick={handleClick} />;
}
