import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconEye, IconEyeOff, IconPlus, IconX } from '@/components/ui/icons';
import { maskApiKey } from '@/utils/format';
import type { AllowedApiKeysValidationError } from '../../allowedApiKeys';
import styles from './sharedForm.module.scss';

interface AllowedApiKeysEditorProps {
  values: string[];
  mutating: boolean;
  validationError?: AllowedApiKeysValidationError | null;
  onChange: (values: string[]) => void;
}

export function AllowedApiKeysEditor({
  values,
  mutating,
  validationError,
  onChange,
}: AllowedApiKeysEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const [visible, setVisible] = useState<Set<number>>(new Set());

  const toggle = (index: number) => {
    setVisible((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const remove = (index: number) => {
    setVisible((current) => {
      const next = new Set<number>();
      current.forEach((value) => {
        if (value < index) next.add(value);
        else if (value > index) next.add(value - 1);
      });
      return next;
    });
    onChange(values.filter((_, valueIndex) => valueIndex !== index));
  };

  return (
    <div className={styles.entriesList}>
      <p className={styles.fieldHint}>{t('providersPage.form.allowedApiKeysHint')}</p>
      {values.length === 0 ? (
        <div className={styles.emptyState}>{t('providersPage.form.allowedApiKeysGlobal')}</div>
      ) : null}
      {values.map((value, index) => {
        const isVisible = visible.has(index);
        const inputId = `${id}-${index}`;
        return (
          <div key={index} className={styles.entryCard}>
            <div className={styles.entryCardBody}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={inputId}>
                  {t('providersPage.form.allowedApiKey', { index: index + 1 })}
                </label>
                <div className={styles.passwordField}>
                  <input
                    id={inputId}
                    className={styles.passwordInput}
                    type={isVisible ? 'text' : 'password'}
                    value={value}
                    onChange={(event) =>
                      onChange(
                        values.map((item, valueIndex) =>
                          valueIndex === index ? event.target.value : item
                        )
                      )
                    }
                    autoComplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    disabled={mutating}
                    placeholder={t('providersPage.form.allowedApiKeyPlaceholder')}
                  />
                  <button
                    type="button"
                    className={styles.passwordToggle}
                    onClick={() => toggle(index)}
                    disabled={mutating}
                    aria-label={t(
                      isVisible
                        ? 'providersPage.form.hideAllowedApiKey'
                        : 'providersPage.form.showAllowedApiKey'
                    )}
                    title={t(
                      isVisible
                        ? 'providersPage.form.hideAllowedApiKey'
                        : 'providersPage.form.showAllowedApiKey'
                    )}
                  >
                    {isVisible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                </div>
                {!isVisible && value.trim() ? (
                  <span className={styles.entrySummaryKey}>{maskApiKey(value.trim())}</span>
                ) : null}
              </div>
              <button
                type="button"
                className={styles.removeBtn}
                disabled={mutating}
                onClick={() => remove(index)}
                aria-label={t('providersPage.form.removeAllowedApiKey', { index: index + 1 })}
              >
                <IconX size={12} />
              </button>
            </div>
          </div>
        );
      })}
      {validationError === 'blank' ? (
        <div className={styles.connectivityError}>
          {t('providersPage.form.validation.allowedApiKeyBlank')}
        </div>
      ) : null}
      {validationError === 'duplicate' ? (
        <div className={styles.connectivityError}>
          {t('providersPage.form.validation.allowedApiKeyDuplicate')}
        </div>
      ) : null}
      <button
        type="button"
        className={styles.addBtn}
        disabled={mutating}
        onClick={() => onChange([...values, ''])}
      >
        <IconPlus size={12} />
        <span>{t('providersPage.form.addAllowedApiKey')}</span>
      </button>
    </div>
  );
}
