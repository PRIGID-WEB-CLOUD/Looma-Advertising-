import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  wrapperClassName?: string;
}

export const PasswordInput: React.FC<PasswordInputProps> = ({
  className = '',
  wrapperClassName = '',
  disabled,
  ...rest
}) => {
  const [visible, setVisible] = useState(false);

  return (
    <div className={`relative ${wrapperClassName}`}>
      <input
        {...rest}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        className={`${className} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 px-3 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-r-lg disabled:opacity-50"
      >
        {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
};
