import React from 'react';

interface FieldErrorProps {
  id?: string;
  message?: string | null;
  className?: string;
}

export const FieldError: React.FC<FieldErrorProps> = ({ id, message, className = '' }) => {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      className={`mt-1 text-xs text-red-600 dark:text-red-400 leading-snug ${className}`.trim()}
    >
      {message}
    </p>
  );
};

export function fieldBorderClass(hasError: boolean, defaultBorder = 'border-slate-300 dark:border-slate-700'): string {
  return hasError
    ? 'border-red-500 dark:border-red-500 focus:border-red-500 focus:ring-red-500/20'
    : defaultBorder;
}
