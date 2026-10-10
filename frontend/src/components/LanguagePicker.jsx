import React from 'react';
import { Globe } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

/**
 * Language picker for the header.
 *
 * Each account picks its own. The option "Group default" clears the personal
 * choice so the user follows whatever an admin set in Settings, which is the
 * honest way to express "I have no preference".
 */
const LanguagePicker = () => {
  const { lang, setLanguage, languages } = useI18n();
  if (!languages || languages.length < 2) return null;

  const onChange = async (event) => {
    const value = event.target.value;
    const result = await setLanguage(value === 'default' ? null : value);
    if (!result.success && result.error) {
      // The language still applied locally; only the save failed. Say so rather
      // than pretending the whole thing failed.
      // eslint-disable-next-line no-alert
      alert(result.error);
    }
  };

  return (
    <label className="lang-picker" title="Language">
      <Globe size={15} aria-hidden="true" />
      <select value={lang} onChange={onChange} aria-label="Language">
        {languages.map((l) => (
          <option key={l.code} value={l.code}>
            {l.native}
          </option>
        ))}
      </select>
    </label>
  );
};

export default LanguagePicker;