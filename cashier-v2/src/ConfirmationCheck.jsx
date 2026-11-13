import React from 'react';
import { Check } from 'lucide-react';

export function ConfirmationCheck({ checked, onChange, disabled = false, children }) {
  return <label className="confirmationCheck" data-checked={checked} data-disabled={disabled}>
    <span className="confirmationControl">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <Check size={18} strokeWidth={3} aria-hidden="true" />
    </span>
    <span className="confirmationText">{children}</span>
    <span className="confirmationState" aria-hidden="true">{checked ? '已确认' : '未勾选'}</span>
  </label>;
}
