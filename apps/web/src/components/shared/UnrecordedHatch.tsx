import { useId } from 'react';

export function UnrecordedHatch() {
  const pattern = useId();
  return (
    <svg aria-hidden="true" focusable="false" width="100%" height="8" className="block text-hatch">
      <defs>
        <pattern id={pattern} width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M-2 2 2-2 M0 6 6 0 M4 8 8 4" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="8" fill={`url(#${pattern})`} />
    </svg>
  );
}
