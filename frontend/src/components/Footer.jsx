import React from 'react';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';

/**
 * Site footer. Rendered by the app shell (every signed-in page) and by the
 * login screen, so the attribution is not something you only see if you go
 * looking for it.
 *
 * `variant="onDark"` is for the login gradient, where the normal theme colours
 * would be unreadable.
 *
 * Only the wording around the attribution is translated. The names themselves are
 * left as literal text in every language, because "Developed by X under Y" is the
 * credit that has to stay readable no matter which language the reader picked.
 */
const Footer = ({ variant = 'default' }) => {
  const { chamaName } = useFormat();
  const { t } = useI18n();
  const year = new Date().getFullYear();

  return (
    <footer className={`site-footer${variant === 'onDark' ? ' on-dark' : ''}`}>
      <div className="site-footer-inner">
        <p className="site-footer-credit">
          {t('footer.builtBy')} <strong>Kenneth Ndugi</strong> {t('footer.builtByUnder')}{' '}
          <strong>WILNCOM TECH</strong>
        </p>
        <p className="site-footer-licence">
          &copy; {year} {chamaName} &middot; {t('footer.freeToUse')} &middot;{' '}
          {t('footer.notForResale')}
        </p>
      </div>
    </footer>
  );
};

export default Footer;