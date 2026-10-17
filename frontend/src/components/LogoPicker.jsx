import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Upload, Trash2, ImageOff } from 'lucide-react';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';
import { withBase } from '../baseUrl';

/**
 * Logo picker for Settings.
 *
 * The file is read in the browser as base64 and posted as JSON rather than
 * multipart, so the backend needs no upload middleware. The preview below is
 * the actual stored bytes re-fetched from /api/chama/logo, not the local file,
 * so what you see is what every other screen will show.
 *
 * `reload` comes from the format provider: after a save or a delete the whole
 * app re-reads the settings, which is what makes the header, sidebar and
 * sign-in screen pick up the new branding.
 */
const LogoPicker = ({ reload }) => {
  const { opts, chamaName } = useFormat();
  const { t } = useI18n();
  const inputRef = useRef(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const stamp = opts.chama_logo_updated_at || '';

  const loadStatus = async () => {
    try {
      const { data } = await axios.get('/api/chama/profile');
      setStatus(data);
    } catch (e) {
      setStatus({ has_logo: false });
    }
  };

  useEffect(() => {
    loadStatus();
  }, [stamp]);

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (!/^image\//.test(file.type)) {
      toast.error(t('logo.chooseImage'));
      e.target.value = '';
      return;
    }

    // Warn before uploading, since a phone photo will be rejected server-side.
    if (file.size > 512 * 1024) {
      toast.error(t('logo.tooLarge', { size: Math.round(file.size / 1024) }));
      e.target.value = '';
      return;
    }

    setBusy(true);
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsDataURL(file);
      });

      const res = await axios.put('/api/chama/logo', { data, filename: file.name });
      toast.success(res.data.message);
      await reload();
      await loadStatus();
    } catch (error) {
      toast.error(error.response?.data?.error || t('logo.saveFailed'));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await axios.delete('/api/chama/logo');
      toast.success(t('logo.removed'));
      await reload();
      await loadStatus();
    } catch (error) {
      toast.error(t('logo.removeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const hasLogo = !!(status && status.has_logo);

  return (
    <div className="logo-picker">
      <div className="logo-picker-preview">
        {hasLogo ? (
          <img
            src={withBase(`/api/chama/logo?v=${stamp}`)}
            alt={t('logo.alt', { name: chamaName })}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : (
          <span className="logo-picker-empty">
            <ImageOff size={18} /> {t('logo.none')}
          </span>
        )}
      </div>

      <div className="logo-picker-body">
        <div className="logo-picker-title">
          {t('logo.title')}
          {hasLogo ? (
            <span className="logo-picker-tag on">{t('logo.inUse')}</span>
          ) : (
            <span className="logo-picker-tag off">{t('logo.defaultMark')}</span>
          )}
        </div>

        <p className="logo-picker-hint">{t('logo.hint')}</p>

        <div className="logo-picker-actions">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => inputRef.current && inputRef.current.click()}
            disabled={busy}
          >
            <Upload size={14} />{' '}
            {busy ? t('logo.working') : hasLogo ? t('logo.replace') : t('settings.uploadLogo')}
          </button>

          {hasLogo && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={remove}
              disabled={busy}
            >
              <Trash2 size={14} /> {t('logo.remove')}
            </button>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={onFile}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  );
};

export default LogoPicker;